const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { cache } = require('../database/redis');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

const bcrypt = require('bcryptjs');

// ========================================
// ADMIN — Gestion globale des utilisateurs
// ========================================

// List all users (admin only)
router.get('/admin/all', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { search, status } = req.query;
    let query = `
      SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.is_active,
        u.must_change_password, u.last_login, u.created_at,
        (SELECT COUNT(*) FROM workspace_members wm WHERE wm.user_id = u.id) as workspace_count
      FROM users u WHERE 1=1
    `;
    const params = [];
    let p = 1;

    if (search) {
      query += ` AND (u.first_name ILIKE $${p} OR u.last_name ILIKE $${p} OR u.email ILIKE $${p})`;
      params.push(`%${search}%`);
      p++;
    }
    if (status === 'active') { query += ' AND u.is_active = true'; }
    if (status === 'inactive') { query += ' AND u.is_active = false'; }

    query += ' ORDER BY u.created_at DESC';
    const result = await db.query(query, params);

    const users = result.rows.map(u => ({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      fullName: `${u.first_name} ${u.last_name}`,
      role: u.role,
      isActive: u.is_active,
      mustChangePassword: u.must_change_password,
      lastLogin: u.last_login,
      createdAt: u.created_at,
      workspaceCount: parseInt(u.workspace_count),
    }));

    res.json(users);
  } catch (error) {
    logger.error('Admin list users error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Create user (admin only)
router.post('/admin/create', authenticate, [
  body('email').isEmail().withMessage('Email invalide'),
  body('firstName').trim().notEmpty().withMessage('Prénom requis'),
  body('lastName').trim().notEmpty().withMessage('Nom requis'),
], async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, firstName, lastName, role } = req.body;

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Cet email existe déjà' });

    const tempPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-4).toUpperCase();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const result = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [email.toLowerCase(), passwordHash, firstName, lastName, role || 'user']
    );

    const u = result.rows[0];
    res.status(201).json({
      id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name,
      role: u.role, isActive: u.is_active, tempPassword,
    });
  } catch (error) {
    logger.error('Admin create user error:', error);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// Update user (admin only)
router.put('/admin/:userId', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { userId } = req.params;
    const { firstName, lastName, role, isActive } = req.body;

    const updates = [];
    const values = [];
    let p = 1;

    if (firstName !== undefined) { updates.push(`first_name = $${p++}`); values.push(firstName); }
    if (lastName !== undefined) { updates.push(`last_name = $${p++}`); values.push(lastName); }
    if (role !== undefined) { updates.push(`role = $${p++}`); values.push(role); }
    if (isActive !== undefined) { updates.push(`is_active = $${p++}`); values.push(isActive); }

    if (updates.length === 0) return res.status(400).json({ error: 'Aucune donnée' });

    updates.push('updated_at = NOW()');
    values.push(userId);

    const result = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    await cache.del(`user:${userId}`);
    const u = result.rows[0];
    res.json({
      id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name,
      role: u.role, isActive: u.is_active, lastLogin: u.last_login, createdAt: u.created_at,
    });
  } catch (error) {
    logger.error('Admin update user error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Reset password (admin only)
router.post('/admin/:userId/reset-password', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { userId } = req.params;
    const tempPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-4).toUpperCase();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    await db.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [passwordHash, userId]);
    await cache.del(`user:${userId}`);

    res.json({ tempPassword });
  } catch (error) {
    logger.error('Admin reset password error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get all workspaces (admin) for access management
router.get('/admin/workspaces', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const result = await db.query(`
      SELECT w.id, w.name, w.color,
        (SELECT COUNT(*) FROM boards WHERE workspace_id = w.id) as board_count,
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) as member_count
      FROM workspaces w ORDER BY w.name ASC
    `);

    res.json(result.rows.map(w => ({
      id: w.id, name: w.name, color: w.color,
      boardCount: parseInt(w.board_count), memberCount: parseInt(w.member_count),
    })));
  } catch (error) {
    logger.error('Admin get workspaces error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get boards for a workspace (admin)
router.get('/admin/workspaces/:wsId/boards', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const result = await db.query(`
      SELECT b.id, b.name, b.color,
        (SELECT COUNT(*) FROM items WHERE board_id = b.id) as item_count
      FROM boards b WHERE b.workspace_id = $1 ORDER BY b.name ASC
    `, [req.params.wsId]);

    res.json(result.rows.map(b => ({
      id: b.id, name: b.name, color: b.color, itemCount: parseInt(b.item_count),
    })));
  } catch (error) {
    logger.error('Admin get boards error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get user's workspace memberships (admin)
router.get('/admin/:userId/access', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { userId } = req.params;
    const wsResult = await db.query(`
      SELECT wm.workspace_id, wm.role FROM workspace_members wm WHERE wm.user_id = $1
    `, [userId]);

    const bpResult = await db.query(`
      SELECT bp.board_id, bp.permission_level FROM board_permissions bp WHERE bp.user_id = $1
    `, [userId]);

    res.json({
      workspaces: wsResult.rows.map(r => ({ workspaceId: r.workspace_id, role: r.role })),
      boards: bpResult.rows.map(r => ({ boardId: r.board_id, permissionLevel: r.permission_level })),
    });
  } catch (error) {
    logger.error('Admin get user access error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Add user to workspace (admin)
router.post('/admin/:userId/workspaces/:wsId', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { userId, wsId } = req.params;
    const role = req.body.role || 'member';

    await db.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = $3
    `, [wsId, userId, role, req.userId]);

    res.json({ ok: true });
  } catch (error) {
    logger.error('Admin add ws member error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Remove user from workspace (admin)
router.delete('/admin/:userId/workspaces/:wsId', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { userId, wsId } = req.params;
    await db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [wsId, userId]);
    await db.query('DELETE FROM board_permissions WHERE user_id = $1 AND board_id IN (SELECT id FROM boards WHERE workspace_id = $2)', [userId, wsId]);

    res.json({ ok: true });
  } catch (error) {
    logger.error('Admin remove ws member error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Set board permission for user (admin)
router.post('/admin/:userId/boards/:boardId', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { userId, boardId } = req.params;
    const level = req.body.permissionLevel || 'edit';

    await db.query(`
      INSERT INTO board_permissions (board_id, user_id, permission_level, granted_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (board_id, user_id) DO UPDATE SET permission_level = $3
    `, [boardId, userId, level, req.userId]);

    res.json({ ok: true });
  } catch (error) {
    logger.error('Admin set board permission error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Remove board permission for user (admin)
router.delete('/admin/:userId/boards/:boardId', authenticate, async (req, res) => {
  try {
    const adminCheck = await db.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const { userId, boardId } = req.params;
    await db.query('DELETE FROM board_permissions WHERE board_id = $1 AND user_id = $2', [boardId, userId]);

    res.json({ ok: true });
  } catch (error) {
    logger.error('Admin remove board permission error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// GET /profile supprimé — utiliser GET /api/auth/me à la place

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
