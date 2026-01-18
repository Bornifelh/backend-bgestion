const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { cache } = require('../database/redis');
const { authenticate, checkWorkspaceAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get all workspaces for current user
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT w.*, wm.role as member_role,
        (SELECT COUNT(*) FROM boards WHERE workspace_id = w.id) as board_count,
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) as member_count
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.userId]
    );

    res.json(result.rows.map(w => ({
      id: w.id,
      name: w.name,
      description: w.description,
      icon: w.icon,
      color: w.color,
      ownerId: w.owner_id,
      memberRole: w.member_role,
      boardCount: parseInt(w.board_count),
      memberCount: parseInt(w.member_count),
      createdAt: w.created_at,
    })));
  } catch (error) {
    logger.error('Get workspaces error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des workspaces' });
  }
});

// Create workspace
router.post('/', authenticate, [
  body('name').trim().notEmpty().withMessage('Nom du workspace requis'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, description, icon, color } = req.body;

    const result = await db.query(
      `INSERT INTO workspaces (name, description, icon, color, owner_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, description || null, icon || '🏢', color || '#6366f1', req.userId]
    );

    const workspace = result.rows[0];

    // Add creator as owner
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [workspace.id, req.userId, 'owner']
    );

    logger.info(`Workspace created: ${workspace.id} by user ${req.userId}`);

    res.status(201).json({
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      icon: workspace.icon,
      color: workspace.color,
      ownerId: workspace.owner_id,
      memberRole: 'owner',
      createdAt: workspace.created_at,
    });
  } catch (error) {
    logger.error('Create workspace error:', error);
    res.status(500).json({ error: 'Erreur lors de la création du workspace' });
  }
});

// Get workspace by ID
router.get('/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT w.*, 
        (SELECT COUNT(*) FROM boards WHERE workspace_id = w.id) as board_count,
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) as member_count
       FROM workspaces w
       WHERE w.id = $1`,
      [workspaceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workspace non trouvé' });
    }

    const w = result.rows[0];
    res.json({
      id: w.id,
      name: w.name,
      description: w.description,
      icon: w.icon,
      color: w.color,
      ownerId: w.owner_id,
      memberRole: req.workspaceRole,
      boardCount: parseInt(w.board_count),
      memberCount: parseInt(w.member_count),
      createdAt: w.created_at,
    });
  } catch (error) {
    logger.error('Get workspace error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du workspace' });
  }
});

// Update workspace
router.put('/:workspaceId', authenticate, checkWorkspaceAccess, [
  body('name').optional().trim().notEmpty().withMessage('Nom requis'),
], async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.workspaceRole)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId } = req.params;
    const { name, description, icon, color } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (icon) {
      updates.push(`icon = $${paramCount++}`);
      values.push(icon);
    }
    if (color) {
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(workspaceId);

    const result = await db.query(
      `UPDATE workspaces SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    const w = result.rows[0];
    res.json({
      id: w.id,
      name: w.name,
      description: w.description,
      icon: w.icon,
      color: w.color,
      ownerId: w.owner_id,
    });
  } catch (error) {
    logger.error('Update workspace error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du workspace' });
  }
});

// Delete workspace
router.delete('/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    if (req.workspaceRole !== 'owner') {
      return res.status(403).json({ error: 'Seul le propriétaire peut supprimer le workspace' });
    }

    const { workspaceId } = req.params;

    await db.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);

    // Emit socket event
    const io = req.app.get('io');
    io.to(`workspace:${workspaceId}`).emit('workspace:deleted', { workspaceId });

    res.json({ message: 'Workspace supprimé avec succès' });
  } catch (error) {
    logger.error('Delete workspace error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression du workspace' });
  }
});

// Get workspace statistics
router.get('/:workspaceId/stats', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Get items by status - join with status_labels to get the label name
    // Use #>> '{}' to extract JSONB value as text without quotes
    const statusResult = await db.query(`
      SELECT 
        COALESCE(sl.label, 'Non défini') as status_name,
        COUNT(*) as count
      FROM items i
      JOIN boards b ON b.id = i.board_id
      JOIN columns c ON c.board_id = b.id
      JOIN column_types ct ON ct.id = c.column_type_id AND ct.name = 'status'
      LEFT JOIN item_values iv ON iv.item_id = i.id AND iv.column_id = c.id
      LEFT JOIN status_labels sl ON sl.id::text = (iv.value #>> '{}')
      WHERE b.workspace_id = $1
      GROUP BY sl.label, sl.position
      ORDER BY sl.position NULLS LAST
    `, [workspaceId]);

    // Get items by priority
    const priorityResult = await db.query(`
      SELECT iv.value as priority, COUNT(*) as count
      FROM items i
      JOIN boards b ON b.id = i.board_id
      JOIN columns c ON c.board_id = b.id
      JOIN column_types ct ON ct.id = c.column_type_id AND ct.name = 'priority'
      LEFT JOIN item_values iv ON iv.item_id = i.id AND iv.column_id = c.id
      WHERE b.workspace_id = $1
      GROUP BY iv.value
    `, [workspaceId]);

    // Get total counts
    const totalsResult = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM boards WHERE workspace_id = $1) as total_boards,
        (SELECT COUNT(*) FROM items i JOIN boards b ON b.id = i.board_id WHERE b.workspace_id = $1) as total_items,
        (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1) as total_members
    `, [workspaceId]);

    const itemsByStatus = {};
    statusResult.rows.forEach(row => {
      // Map status names to standard keys for frontend
      let key = row.status_name || 'unset';
      const nameLower = key.toLowerCase();
      if (nameLower.includes('terminé') || nameLower.includes('done') || nameLower.includes('complet')) {
        key = 'done';
      } else if (nameLower.includes('cours') || nameLower.includes('progress')) {
        key = 'in_progress';
      } else if (nameLower.includes('faire') || nameLower.includes('todo')) {
        key = 'todo';
      } else if (nameLower.includes('bloqu') || nameLower.includes('block')) {
        key = 'blocked';
      }
      itemsByStatus[key] = (itemsByStatus[key] || 0) + parseInt(row.count);
    });

    const itemsByPriority = {};
    priorityResult.rows.forEach(row => {
      const key = row.priority || 'unset';
      itemsByPriority[key] = parseInt(row.count);
    });

    res.json({
      totalBoards: parseInt(totalsResult.rows[0].total_boards),
      totalItems: parseInt(totalsResult.rows[0].total_items),
      totalMembers: parseInt(totalsResult.rows[0].total_members),
      itemsByStatus,
      itemsByPriority,
    });
  } catch (error) {
    logger.error('Get workspace stats error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
  }
});

// Get workspace members
router.get('/:workspaceId/members', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, 
              wm.role, wm.joined_at
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = $1
       ORDER BY wm.role DESC, wm.joined_at ASC`,
      [workspaceId]
    );

    res.json(result.rows.map(m => ({
      id: m.id,
      email: m.email,
      firstName: m.first_name,
      lastName: m.last_name,
      avatarUrl: m.avatar_url,
      role: m.role,
      joinedAt: m.joined_at,
    })));
  } catch (error) {
    logger.error('Get workspace members error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des membres' });
  }
});

// Add member to workspace
router.post('/:workspaceId/members', authenticate, checkWorkspaceAccess, [
  body('email').isEmail().withMessage('Email invalide'),
  body('role').optional().isIn(['admin', 'member', 'viewer']).withMessage('Rôle invalide'),
], async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.workspaceRole)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId } = req.params;
    const { email, role = 'member' } = req.body;

    // Find user
    const userResult = await db.query(
      'SELECT id, email, first_name, last_name, avatar_url FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const user = userResult.rows[0];

    // Check if already member
    const existingMember = await db.query(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, user.id]
    );

    if (existingMember.rows.length > 0) {
      return res.status(400).json({ error: 'L\'utilisateur est déjà membre' });
    }

    // Add member
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, user.id, role, req.userId]
    );

    // Create notification
    await db.query(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.id,
        'workspace_invite',
        'Invitation au workspace',
        `Vous avez été ajouté au workspace`,
        JSON.stringify({ workspaceId })
      ]
    );

    // Emit socket event
    const io = req.app.get('io');
    io.to(`workspace:${workspaceId}`).emit('member:added', {
      workspaceId,
      member: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        avatarUrl: user.avatar_url,
        role,
      }
    });

    res.status(201).json({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      avatarUrl: user.avatar_url,
      role,
    });
  } catch (error) {
    logger.error('Add member error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'ajout du membre' });
  }
});

// Update member role
router.put('/:workspaceId/members/:memberId', authenticate, checkWorkspaceAccess, [
  body('role').isIn(['admin', 'member', 'viewer']).withMessage('Rôle invalide'),
], async (req, res) => {
  try {
    if (req.workspaceRole !== 'owner') {
      return res.status(403).json({ error: 'Seul le propriétaire peut modifier les rôles' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId, memberId } = req.params;
    const { role } = req.body;

    // Can't change owner's role
    const workspace = await db.query(
      'SELECT owner_id FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (workspace.rows[0].owner_id === memberId) {
      return res.status(400).json({ error: 'Impossible de modifier le rôle du propriétaire' });
    }

    await db.query(
      'UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3',
      [role, workspaceId, memberId]
    );

    res.json({ message: 'Rôle mis à jour' });
  } catch (error) {
    logger.error('Update member role error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du rôle' });
  }
});

// Remove member from workspace
router.delete('/:workspaceId/members/:memberId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId, memberId } = req.params;

    // Check permissions
    if (memberId !== req.userId && !['owner', 'admin'].includes(req.workspaceRole)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    // Can't remove owner
    const workspace = await db.query(
      'SELECT owner_id FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (workspace.rows[0].owner_id === memberId) {
      return res.status(400).json({ error: 'Le propriétaire ne peut pas être retiré' });
    }

    await db.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, memberId]
    );

    // Emit socket event
    const io = req.app.get('io');
    io.to(`workspace:${workspaceId}`).emit('member:removed', { workspaceId, memberId });

    res.json({ message: 'Membre retiré avec succès' });
  } catch (error) {
    logger.error('Remove member error:', error);
    res.status(500).json({ error: 'Erreur lors du retrait du membre' });
  }
});

module.exports = router;
