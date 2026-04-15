const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate, checkWorkspaceAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get my widgets for a workspace
router.get('/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM dashboard_widgets 
      WHERE workspace_id = $1 AND user_id = $2
      ORDER BY position_y ASC, position_x ASC`,
      [req.params.workspaceId, req.userId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get dashboard widgets error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get dashboard data for a workspace (aggregated stats)
router.get('/workspace/:workspaceId/data', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const wsId = req.params.workspaceId;

    // Task summary
    const taskSummary = await db.query(
      `SELECT 
        COUNT(i.id) as total_items,
        COUNT(i.id) FILTER (WHERE iv.value::text ILIKE '%done%' OR iv.value::text ILIKE '%completed%') as completed,
        COUNT(i.id) FILTER (WHERE iv.value::text ILIKE '%progress%' OR iv.value::text ILIKE '%en cours%') as in_progress
      FROM items i
      JOIN boards b ON i.board_id = b.id
      LEFT JOIN item_values iv ON i.id = iv.item_id
      LEFT JOIN columns c ON iv.column_id = c.id AND c.board_id = b.id
      LEFT JOIN column_types ct ON c.column_type_id = ct.id AND ct.name = 'status'
      WHERE b.workspace_id = $1`,
      [wsId]
    );

    // Recent activity
    const recentActivity = await db.query(
      `SELECT al.*, u.first_name, u.last_name
      FROM activity_logs al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.workspace_id = $1
      ORDER BY al.created_at DESC LIMIT 10`,
      [wsId]
    );

    // Items by member
    const byMember = await db.query(
      `SELECT u.id, u.first_name, u.last_name,
        COUNT(DISTINCT iv.item_id) as task_count
      FROM item_values iv
      JOIN items i ON iv.item_id = i.id
      JOIN boards b ON i.board_id = b.id
      JOIN columns c ON iv.column_id = c.id
      JOIN column_types ct ON c.column_type_id = ct.id AND ct.name = 'person'
      JOIN users u ON iv.value::text LIKE '%' || u.id::text || '%'
      WHERE b.workspace_id = $1
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY task_count DESC LIMIT 10`,
      [wsId]
    );

    // Boards summary
    const boards = await db.query(
      `SELECT b.id, b.name, b.color, COUNT(i.id) as item_count
      FROM boards b
      LEFT JOIN items i ON b.id = i.board_id
      WHERE b.workspace_id = $1
      GROUP BY b.id
      ORDER BY item_count DESC`,
      [wsId]
    );

    // Overdue items
    const overdue = await db.query(
      `SELECT COUNT(DISTINCT iv.item_id) as count
      FROM item_values iv
      JOIN items i ON iv.item_id = i.id
      JOIN boards b ON i.board_id = b.id
      JOIN columns c ON iv.column_id = c.id
      JOIN column_types ct ON c.column_type_id = ct.id AND ct.name = 'date'
      WHERE b.workspace_id = $1 
        AND iv.value IS NOT NULL 
        AND iv.value::text != 'null'
        AND iv.value::text != '""'
        AND trim(both '"' from iv.value::text) ~ '^\d{4}-\d{2}-\d{2}'
        AND trim(both '"' from iv.value::text)::date < CURRENT_DATE`,
      [wsId]
    );

    res.json({
      taskSummary: taskSummary.rows[0],
      recentActivity: recentActivity.rows,
      byMember: byMember.rows,
      boards: boards.rows,
      overdueCount: parseInt(overdue.rows[0]?.count || 0),
    });
  } catch (error) {
    logger.error('Get dashboard data error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create widget
router.post('/', authenticate, async (req, res) => {
  try {
    const { workspaceId, widgetType, title, config, positionX, positionY, width, height } = req.body;

    const { rows } = await db.query(
      `INSERT INTO dashboard_widgets (workspace_id, user_id, widget_type, title, config, position_x, position_y, width, height)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [workspaceId, req.userId, widgetType, title, JSON.stringify(config || {}), positionX || 0, positionY || 0, width || 1, height || 1]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Create widget error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update widget
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { title, config, positionX, positionY, width, height } = req.body;

    const { rows } = await db.query(
      `UPDATE dashboard_widgets
      SET title = COALESCE($1, title),
        config = COALESCE($2, config),
        position_x = COALESCE($3, position_x),
        position_y = COALESCE($4, position_y),
        width = COALESCE($5, width),
        height = COALESCE($6, height),
        updated_at = NOW()
      WHERE id = $7 AND user_id = $8
      RETURNING *`,
      [title, config ? JSON.stringify(config) : null, positionX, positionY, width, height, req.params.id, req.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Widget non trouvé' });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('Update widget error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete widget
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM dashboard_widgets WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ message: 'Widget supprimé' });
  } catch (error) {
    logger.error('Delete widget error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Batch update positions
router.put('/batch/positions', authenticate, async (req, res) => {
  try {
    const { widgets } = req.body;
    if (!widgets || !widgets.length) return res.json({ message: 'ok' });

    for (const w of widgets) {
      await db.query(
        `UPDATE dashboard_widgets SET position_x = $1, position_y = $2, width = $3, height = $4, updated_at = NOW()
        WHERE id = $5 AND user_id = $6`,
        [w.positionX, w.positionY, w.width, w.height, w.id, req.userId]
      );
    }

    res.json({ message: 'Positions mises à jour' });
  } catch (error) {
    logger.error('Batch update positions error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
