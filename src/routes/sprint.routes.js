const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get sprints for a board
router.get('/board/:boardId', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, 
        COUNT(si.item_id) as total_items,
        u.first_name as created_by_name
      FROM sprints s
      LEFT JOIN sprint_items si ON s.id = si.sprint_id
      LEFT JOIN users u ON s.created_by = u.id
      WHERE s.board_id = $1
      GROUP BY s.id, u.first_name
      ORDER BY s.created_at DESC`,
      [req.params.boardId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get sprints error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get active sprint for a board
router.get('/board/:boardId/active', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, COUNT(si.item_id) as total_items
      FROM sprints s
      LEFT JOIN sprint_items si ON s.id = si.sprint_id
      WHERE s.board_id = $1 AND s.status = 'active'
      GROUP BY s.id
      LIMIT 1`,
      [req.params.boardId]
    );
    res.json(rows[0] || null);
  } catch (error) {
    logger.error('Get active sprint error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get backlog items (not in any active/planning sprint)
router.get('/board/:boardId/backlog', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.*, 
        json_object_agg(COALESCE(iv.column_id::text, 'none'), iv.value) FILTER (WHERE iv.column_id IS NOT NULL) as values
      FROM items i
      LEFT JOIN item_values iv ON i.id = iv.item_id
      WHERE i.board_id = $1
        AND i.id NOT IN (
          SELECT si.item_id FROM sprint_items si
          JOIN sprints s ON si.sprint_id = s.id
          WHERE s.status IN ('active', 'planning')
        )
      GROUP BY i.id
      ORDER BY i.position ASC`,
      [req.params.boardId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get backlog error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get sprint items with details
router.get('/:sprintId/items', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT i.*, si.added_at,
        json_object_agg(COALESCE(iv.column_id::text, 'none'), iv.value) FILTER (WHERE iv.column_id IS NOT NULL) as values
      FROM sprint_items si
      JOIN items i ON si.item_id = i.id
      LEFT JOIN item_values iv ON i.id = iv.item_id
      WHERE si.sprint_id = $1
      GROUP BY i.id, si.added_at
      ORDER BY i.position ASC`,
      [req.params.sprintId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get sprint items error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create sprint
router.post('/', authenticate, async (req, res) => {
  try {
    const { boardId, name, goal, startDate, endDate } = req.body;

    if (!boardId || !name) {
      return res.status(400).json({ error: 'boardId et name requis' });
    }

    const { rows } = await db.query(
      `INSERT INTO sprints (board_id, name, goal, start_date, end_date, status, created_by)
      VALUES ($1, $2, $3, $4, $5, 'planning', $6)
      RETURNING *`,
      [boardId, name, goal || null, startDate || null, endDate || null, req.userId]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Create sprint error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update sprint
router.put('/:sprintId', authenticate, async (req, res) => {
  try {
    const { name, goal, startDate, endDate } = req.body;

    const { rows } = await db.query(
      `UPDATE sprints 
      SET name = COALESCE($1, name),
        goal = COALESCE($2, goal),
        start_date = COALESCE($3, start_date),
        end_date = COALESCE($4, end_date),
        updated_at = NOW()
      WHERE id = $5
      RETURNING *`,
      [name, goal, startDate, endDate, req.params.sprintId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Sprint non trouvé' });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('Update sprint error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Start sprint
router.post('/:sprintId/start', authenticate, async (req, res) => {
  try {
    // Check if there's already an active sprint for this board
    const sprint = await db.query('SELECT * FROM sprints WHERE id = $1', [req.params.sprintId]);
    if (sprint.rows.length === 0) {
      return res.status(404).json({ error: 'Sprint non trouvé' });
    }

    const activeCheck = await db.query(
      `SELECT id FROM sprints WHERE board_id = $1 AND status = 'active' AND id != $2`,
      [sprint.rows[0].board_id, req.params.sprintId]
    );

    if (activeCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Un sprint est déjà actif pour ce board' });
    }

    const { rows } = await db.query(
      `UPDATE sprints 
      SET status = 'active', 
        start_date = COALESCE(start_date, CURRENT_DATE),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [req.params.sprintId]
    );

    res.json(rows[0]);
  } catch (error) {
    logger.error('Start sprint error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Complete sprint
router.post('/:sprintId/complete', authenticate, async (req, res) => {
  try {
    const { moveToBacklog = true } = req.body;

    const { rows } = await db.query(
      `UPDATE sprints 
      SET status = 'completed', 
        end_date = COALESCE(end_date, CURRENT_DATE),
        updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [req.params.sprintId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Sprint non trouvé' });
    }

    // Optionally remove incomplete items from sprint (they go back to backlog)
    if (moveToBacklog) {
      await db.query(
        `DELETE FROM sprint_items 
        WHERE sprint_id = $1 AND item_id IN (
          SELECT si.item_id FROM sprint_items si
          JOIN items i ON si.item_id = i.id
          LEFT JOIN item_values iv ON i.id = iv.item_id
          JOIN columns c ON iv.column_id = c.id AND c.title ILIKE '%status%'
          WHERE si.sprint_id = $1
            AND (iv.value IS NULL OR iv.value::text NOT IN ('"done"', '"completed"'))
        )`,
        [req.params.sprintId]
      );
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('Complete sprint error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete sprint
router.delete('/:sprintId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sprints WHERE id = $1', [req.params.sprintId]);
    res.json({ message: 'Sprint supprimé' });
  } catch (error) {
    logger.error('Delete sprint error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Add items to sprint
router.post('/:sprintId/items', authenticate, async (req, res) => {
  try {
    const { itemIds } = req.body;
    if (!itemIds || !itemIds.length) {
      return res.status(400).json({ error: 'itemIds requis' });
    }

    const values = itemIds.map((id, i) => `($1, $${i + 2})`).join(', ');
    const params = [req.params.sprintId, ...itemIds];

    await db.query(
      `INSERT INTO sprint_items (sprint_id, item_id) VALUES ${values} ON CONFLICT DO NOTHING`,
      params
    );

    res.json({ message: `${itemIds.length} item(s) ajouté(s) au sprint` });
  } catch (error) {
    logger.error('Add sprint items error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Remove item from sprint
router.delete('/:sprintId/items/:itemId', authenticate, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM sprint_items WHERE sprint_id = $1 AND item_id = $2',
      [req.params.sprintId, req.params.itemId]
    );
    res.json({ message: 'Item retiré du sprint' });
  } catch (error) {
    logger.error('Remove sprint item error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Burndown data for a sprint
router.get('/:sprintId/burndown', authenticate, async (req, res) => {
  try {
    const sprint = await db.query('SELECT * FROM sprints WHERE id = $1', [req.params.sprintId]);
    if (sprint.rows.length === 0) {
      return res.status(404).json({ error: 'Sprint non trouvé' });
    }

    const s = sprint.rows[0];
    const totalItems = await db.query(
      'SELECT COUNT(*) as count FROM sprint_items WHERE sprint_id = $1',
      [req.params.sprintId]
    );

    // Get completion timeline from activity logs
    const { rows: completions } = await db.query(
      `SELECT DATE(al.created_at) as date, COUNT(*) as completed
      FROM activity_logs al
      JOIN sprint_items si ON al.item_id = si.item_id
      WHERE si.sprint_id = $1 AND al.action IN ('status_changed', 'item_updated')
        AND (al.new_value::text ILIKE '%done%' OR al.new_value::text ILIKE '%completed%')
      GROUP BY DATE(al.created_at)
      ORDER BY date ASC`,
      [req.params.sprintId]
    );

    res.json({
      sprint: s,
      totalItems: parseInt(totalItems.rows[0].count),
      completions,
    });
  } catch (error) {
    logger.error('Burndown error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Velocity data for a board
router.get('/board/:boardId/velocity', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.start_date, s.end_date,
        COUNT(si.item_id) as total_items,
        COUNT(si.item_id) FILTER (WHERE s.status = 'completed') as completed_items
      FROM sprints s
      LEFT JOIN sprint_items si ON s.id = si.sprint_id
      WHERE s.board_id = $1 AND s.status = 'completed'
      GROUP BY s.id
      ORDER BY s.end_date DESC
      LIMIT 10`,
      [req.params.boardId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Velocity error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
