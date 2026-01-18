const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate, checkWorkspaceAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get recent activity for a workspace
router.get('/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT a.*, 
        u.first_name, u.last_name, u.avatar_url,
        b.name as board_name, b.icon as board_icon,
        i.name as item_name
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN boards b ON b.id = a.board_id
       LEFT JOIN items i ON i.id = a.item_id
       WHERE a.workspace_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2 OFFSET $3`,
      [workspaceId, parseInt(limit), parseInt(offset)]
    );

    res.json(result.rows.map(formatActivity));
  } catch (error) {
    logger.error('Get activity error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get activity for a board
router.get('/board/:boardId', authenticate, async (req, res) => {
  try {
    const { boardId } = req.params;
    const { limit = 30 } = req.query;

    const result = await db.query(
      `SELECT a.*, 
        u.first_name, u.last_name, u.avatar_url,
        i.name as item_name
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN items i ON i.id = a.item_id
       WHERE a.board_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [boardId, parseInt(limit)]
    );

    res.json(result.rows.map(formatActivity));
  } catch (error) {
    logger.error('Get board activity error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get activity for an item
router.get('/item/:itemId', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;

    const result = await db.query(
      `SELECT a.*, 
        u.first_name, u.last_name, u.avatar_url
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.item_id = $1
       ORDER BY a.created_at DESC
       LIMIT 50`,
      [itemId]
    );

    res.json(result.rows.map(formatActivity));
  } catch (error) {
    logger.error('Get item activity error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get user's recent activity (for dashboard)
router.get('/me', authenticate, async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    // Get workspaces the user is a member of
    const workspacesResult = await db.query(
      'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
      [req.userId]
    );

    const workspaceIds = workspacesResult.rows.map(r => r.workspace_id);

    if (workspaceIds.length === 0) {
      return res.json([]);
    }

    const result = await db.query(
      `SELECT a.*, 
        u.first_name, u.last_name, u.avatar_url,
        b.name as board_name, b.icon as board_icon,
        i.name as item_name,
        w.name as workspace_name
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN boards b ON b.id = a.board_id
       LEFT JOIN items i ON i.id = a.item_id
       LEFT JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.workspace_id = ANY($1)
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [workspaceIds, parseInt(limit)]
    );

    res.json(result.rows.map(formatActivity));
  } catch (error) {
    logger.error('Get my activity error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Log activity (internal use, can be called from other routes)
router.post('/', authenticate, async (req, res) => {
  try {
    const { workspaceId, boardId, itemId, action, entityType, entityId, oldValue, newValue, metadata } = req.body;

    const result = await db.query(
      `INSERT INTO activity_logs (workspace_id, board_id, item_id, user_id, action, entity_type, entity_id, old_value, new_value, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [workspaceId, boardId || null, itemId || null, req.userId, action, entityType, entityId || null, 
       oldValue ? JSON.stringify(oldValue) : null, 
       newValue ? JSON.stringify(newValue) : null,
       metadata ? JSON.stringify(metadata) : '{}']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Log activity error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

function formatActivity(a) {
  return {
    id: a.id,
    workspaceId: a.workspace_id,
    workspaceName: a.workspace_name,
    boardId: a.board_id,
    boardName: a.board_name,
    boardIcon: a.board_icon,
    itemId: a.item_id,
    itemName: a.item_name,
    userId: a.user_id,
    userName: a.first_name ? `${a.first_name} ${a.last_name}` : null,
    avatarUrl: a.avatar_url,
    action: a.action,
    entityType: a.entity_type,
    entityId: a.entity_id,
    oldValue: a.old_value,
    newValue: a.new_value,
    metadata: a.metadata,
    createdAt: a.created_at,
  };
}

module.exports = router;
