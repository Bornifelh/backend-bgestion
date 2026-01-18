const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { cache } = require('../database/redis');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, first_name, last_name, role, avatar_url, created_at, last_login
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
      lastLogin: user.last_login,
    });
  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du profil' });
  }
});

// Update user profile
router.put('/profile', authenticate, [
  body('firstName').optional().trim().notEmpty().withMessage('Prénom requis'),
  body('lastName').optional().trim().notEmpty().withMessage('Nom requis'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { firstName, lastName, avatarUrl } = req.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (firstName) {
      updates.push(`first_name = $${paramCount++}`);
      values.push(firstName);
    }
    if (lastName) {
      updates.push(`last_name = $${paramCount++}`);
      values.push(lastName);
    }
    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramCount++}`);
      values.push(avatarUrl);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(req.userId);
    
    const result = await db.query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, email, first_name, last_name, role, avatar_url`,
      values
    );

    // Invalidate cache
    await cache.del(`user:${req.userId}`);

    const user = result.rows[0];
    res.json({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      avatarUrl: user.avatar_url,
    });
  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du profil' });
  }
});

// Search users (for mentions, assignments, etc.)
router.get('/search', authenticate, async (req, res) => {
  try {
    const { q, workspaceId, limit = 10 } = req.query;

    if (!q || q.length < 2) {
      return res.json([]);
    }

    let query;
    let params;

    if (workspaceId) {
      // Search within workspace members
      query = `
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name, u.avatar_url
        FROM users u
        JOIN workspace_members wm ON wm.user_id = u.id
        WHERE wm.workspace_id = $1
        AND u.is_active = true
        AND (
          LOWER(u.first_name) LIKE LOWER($2)
          OR LOWER(u.last_name) LIKE LOWER($2)
          OR LOWER(u.email) LIKE LOWER($2)
          OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE LOWER($2)
        )
        LIMIT $3
      `;
      params = [workspaceId, `%${q}%`, parseInt(limit)];
    } else {
      // Search all users
      query = `
        SELECT id, email, first_name, last_name, avatar_url
        FROM users
        WHERE is_active = true
        AND (
          LOWER(first_name) LIKE LOWER($1)
          OR LOWER(last_name) LIKE LOWER($1)
          OR LOWER(email) LIKE LOWER($1)
          OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE LOWER($1)
        )
        LIMIT $2
      `;
      params = [`%${q}%`, parseInt(limit)];
    }

    const result = await db.query(query, params);

    res.json(result.rows.map(u => ({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      avatarUrl: u.avatar_url,
      fullName: `${u.first_name} ${u.last_name}`,
    })));
  } catch (error) {
    logger.error('Search users error:', error);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});

// Get user by ID
router.get('/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await db.query(
      `SELECT id, email, first_name, last_name, role, avatar_url, created_at
       FROM users WHERE id = $1 AND is_active = true`,
      [userId]
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
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de l\'utilisateur' });
  }
});

module.exports = router;
