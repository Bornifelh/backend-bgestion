const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get subtasks for an item
router.get('/item/:itemId', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;

    const result = await db.query(
      `SELECT s.*, 
        u.first_name as assignee_first_name, u.last_name as assignee_last_name
       FROM subtasks s
       LEFT JOIN users u ON u.id = s.assignee_id
       WHERE s.item_id = $1
       ORDER BY s.position ASC, s.created_at ASC`,
      [itemId]
    );

    res.json(result.rows.map(formatSubtask));
  } catch (error) {
    logger.error('Get subtasks error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération' });
  }
});

// Create subtask
router.post('/', authenticate, [
  body('itemId').isUUID(),
  body('name').trim().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { itemId, name, dueDate, assigneeId } = req.body;

    // Get next position
    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM subtasks WHERE item_id = $1',
      [itemId]
    );

    const result = await db.query(
      `INSERT INTO subtasks (item_id, name, due_date, assignee_id, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [itemId, name, dueDate || null, assigneeId || null, posResult.rows[0].next_pos, req.userId]
    );

    res.status(201).json(formatSubtask(result.rows[0]));
  } catch (error) {
    logger.error('Create subtask error:', error);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// Update subtask
router.put('/:subtaskId', authenticate, async (req, res) => {
  try {
    const { subtaskId } = req.params;
    const { name, isCompleted, dueDate, assigneeId, position } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (isCompleted !== undefined) {
      updates.push(`is_completed = $${paramCount++}`);
      values.push(isCompleted);
      if (isCompleted) {
        updates.push(`completed_at = NOW()`);
      } else {
        updates.push(`completed_at = NULL`);
      }
    }
    if (dueDate !== undefined) {
      updates.push(`due_date = $${paramCount++}`);
      values.push(dueDate);
    }
    if (assigneeId !== undefined) {
      updates.push(`assignee_id = $${paramCount++}`);
      values.push(assigneeId || null);
    }
    if (position !== undefined) {
      updates.push(`position = $${paramCount++}`);
      values.push(position);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(subtaskId);

    const result = await db.query(
      `UPDATE subtasks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sous-tâche non trouvée' });
    }

    res.json(formatSubtask(result.rows[0]));
  } catch (error) {
    logger.error('Update subtask error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// Toggle subtask completion
router.put('/:subtaskId/toggle', authenticate, async (req, res) => {
  try {
    const { subtaskId } = req.params;

    const result = await db.query(
      `UPDATE subtasks 
       SET is_completed = NOT is_completed,
           completed_at = CASE WHEN is_completed THEN NULL ELSE NOW() END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [subtaskId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sous-tâche non trouvée' });
    }

    res.json(formatSubtask(result.rows[0]));
  } catch (error) {
    logger.error('Toggle subtask error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete subtask
router.delete('/:subtaskId', authenticate, async (req, res) => {
  try {
    const { subtaskId } = req.params;

    await db.query('DELETE FROM subtasks WHERE id = $1', [subtaskId]);

    res.json({ message: 'Sous-tâche supprimée' });
  } catch (error) {
    logger.error('Delete subtask error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// Reorder subtasks
router.put('/item/:itemId/reorder', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { subtasks } = req.body; // Array of { id, position }

    for (const subtask of subtasks) {
      await db.query(
        'UPDATE subtasks SET position = $1 WHERE id = $2 AND item_id = $3',
        [subtask.position, subtask.id, itemId]
      );
    }

    res.json({ message: 'Ordre mis à jour' });
  } catch (error) {
    logger.error('Reorder subtasks error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get subtask progress for an item
router.get('/item/:itemId/progress', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;

    const result = await db.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_completed) as completed
       FROM subtasks WHERE item_id = $1`,
      [itemId]
    );

    const { total, completed } = result.rows[0];
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    res.json({
      total: parseInt(total),
      completed: parseInt(completed),
      progress,
    });
  } catch (error) {
    logger.error('Get subtask progress error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

function formatSubtask(s) {
  return {
    id: s.id,
    itemId: s.item_id,
    name: s.name,
    isCompleted: s.is_completed,
    dueDate: s.due_date,
    assigneeId: s.assignee_id,
    assigneeName: s.assignee_first_name ? `${s.assignee_first_name} ${s.assignee_last_name}` : null,
    position: s.position,
    completedAt: s.completed_at,
    createdAt: s.created_at,
  };
}

module.exports = router;
