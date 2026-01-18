const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const config = require('../config');
const db = require('../database/db');
const { cache } = require('../database/redis');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Validation rules
const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
  body('password').isLength({ min: 6 }).withMessage('Mot de passe minimum 6 caractères'),
  body('firstName').trim().notEmpty().withMessage('Prénom requis'),
  body('lastName').trim().notEmpty().withMessage('Nom requis'),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
  body('password').notEmpty().withMessage('Mot de passe requis'),
];

// Generate tokens
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
  
  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiresIn }
  );
  
  return { accessToken, refreshToken };
};

// Register
router.post('/register', registerValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, firstName, lastName } = req.body;

    // Check if user exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Un compte existe déjà avec cet email' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, first_name, last_name, role, created_at`,
      [email, passwordHash, firstName, lastName]
    );

    const user = result.rows[0];
    
    // Create default workspace for user
    const workspaceResult = await db.query(
      `INSERT INTO workspaces (name, description, icon, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [`Espace de ${firstName}`, 'Mon espace de travail', '🏠', user.id]
    );
    
    // Add user as owner of workspace
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [workspaceResult.rows[0].id, user.id, 'owner']
    );

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id);
    
    // Store refresh token
    await cache.storeRefreshToken(user.id, refreshToken);

    logger.info(`New user registered: ${email}`);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    logger.error('Register error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'inscription' });
  }
});

// Login
router.post('/login', loginValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Get user
    const result = await db.query(
      `SELECT id, email, password_hash, first_name, last_name, role, is_active, avatar_url, must_change_password
       FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(401).json({ error: 'Compte désactivé' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // Update last login
    await db.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user.id);
    
    // Store refresh token
    await cache.storeRefreshToken(user.id, refreshToken);

    logger.info(`User logged in: ${email}`);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        avatarUrl: user.avatar_url,
        mustChangePassword: user.must_change_password || false,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
});

// Refresh token
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token requis' });
    }

    // Verify refresh token
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.secret);
    } catch (err) {
      return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
    }

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Token invalide' });
    }

    // Check if refresh token is stored
    const storedToken = await cache.getRefreshToken(decoded.userId);
    if (storedToken !== refreshToken) {
      return res.status(401).json({ error: 'Refresh token révoqué' });
    }

    // Get user
    const result = await db.query(
      'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Utilisateur non autorisé' });
    }

    // Generate new tokens
    const tokens = generateTokens(decoded.userId);
    
    // Store new refresh token
    await cache.storeRefreshToken(decoded.userId, tokens.refreshToken);

    res.json(tokens);
  } catch (error) {
    logger.error('Refresh token error:', error);
    res.status(500).json({ error: 'Erreur lors du rafraîchissement du token' });
  }
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    // Delete refresh token
    await cache.deleteRefreshToken(req.userId);
    
    // Clear user cache
    await cache.del(`user:${req.userId}`);

    res.json({ message: 'Déconnexion réussie' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ error: 'Erreur lors de la déconnexion' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, first_name, last_name, role, avatar_url, created_at
       FROM users WHERE id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const user = result.rows[0];
    res.json({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    });
  } catch (error) {
    logger.error('Get me error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du profil' });
  }
});

// Change password
router.put('/password', authenticate, [
  body('currentPassword').notEmpty().withMessage('Mot de passe actuel requis'),
  body('newPassword').isLength({ min: 6 }).withMessage('Nouveau mot de passe minimum 6 caractères'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    // Get user with password
    const result = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.userId]
    );

    // Check current password
    const isValidPassword = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!isValidPassword) {
      return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password and clear must_change_password flag
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2',
      [newPasswordHash, req.userId]
    );

    // Invalidate all tokens
    await cache.deleteRefreshToken(req.userId);

    res.json({ message: 'Mot de passe modifié avec succès' });
  } catch (error) {
    logger.error('Change password error:', error);
    res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
  }
});

// First login password change (for invited users with temp password)
router.post('/change-temp-password', authenticate, [
  body('newPassword').isLength({ min: 6 }).withMessage('Nouveau mot de passe minimum 6 caractères'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { newPassword } = req.body;

    // Check if user must change password
    const userResult = await db.query(
      'SELECT must_change_password FROM users WHERE id = $1',
      [req.userId]
    );

    if (!userResult.rows[0]?.must_change_password) {
      return res.status(400).json({ error: 'Changement de mot de passe non requis' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password and clear flag
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2',
      [newPasswordHash, req.userId]
    );

    logger.info(`User ${req.userId} changed temporary password`);

    res.json({ message: 'Mot de passe modifié avec succès' });
  } catch (error) {
    logger.error('Change temp password error:', error);
    res.status(500).json({ error: 'Erreur lors du changement de mot de passe' });
  }
});

module.exports = router;
