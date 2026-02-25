const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get time entries for an item
router.get('/item/:itemId', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT te.*, u.first_name, u.last_name, u.email,
        CASE WHEN te.end_time IS NULL AND te.start_time IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (NOW() - te.start_time)) / 60
          ELSE te.duration_minutes 
        END as current_duration
      FROM time_entries te
      JOIN users u ON te.user_id = u.id
      WHERE te.item_id = $1
      ORDER BY te.start_time DESC`,
      [req.params.itemId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get time entries error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get my time entries
router.get('/me', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, limit = 50 } = req.query;
    let query = `
      SELECT te.*, i.name as item_name, b.name as board_name, b.id as board_id
      FROM time_entries te
      JOIN items i ON te.item_id = i.id
      JOIN boards b ON i.board_id = b.id
      WHERE te.user_id = $1`;
    const params = [req.userId];
    let paramIdx = 2;

    if (startDate) {
      query += ` AND te.start_time >= $${paramIdx}`;
      params.push(startDate);
      paramIdx++;
    }
    if (endDate) {
      query += ` AND te.start_time <= $${paramIdx}`;
      params.push(endDate);
      paramIdx++;
    }

    query += ` ORDER BY te.start_time DESC LIMIT $${paramIdx}`;
    params.push(parseInt(limit));

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    logger.error('Get my time entries error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get active timer for current user
router.get('/active', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT te.*, i.name as item_name
      FROM time_entries te
      JOIN items i ON te.item_id = i.id
      WHERE te.user_id = $1 AND te.end_time IS NULL
      ORDER BY te.start_time DESC LIMIT 1`,
      [req.userId]
    );
    res.json(rows[0] || null);
  } catch (error) {
    logger.error('Get active timer error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Workspace time report
router.get('/workspace/:workspaceId/report', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let dateFilter = '';
    const params = [req.params.workspaceId];
    let paramIdx = 2;

    if (startDate) {
      dateFilter += ` AND te.start_time >= $${paramIdx}`;
      params.push(startDate);
      paramIdx++;
    }
    if (endDate) {
      dateFilter += ` AND te.start_time <= $${paramIdx}`;
      params.push(endDate);
      paramIdx++;
    }

    // By member
    const byMember = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email,
        COUNT(te.id) as entries_count,
        COALESCE(SUM(te.duration_minutes), 0) as total_minutes
      FROM time_entries te
      JOIN users u ON te.user_id = u.id
      JOIN items i ON te.item_id = i.id
      JOIN boards b ON i.board_id = b.id
      WHERE b.workspace_id = $1 AND te.end_time IS NOT NULL ${dateFilter}
      GROUP BY u.id, u.first_name, u.last_name, u.email
      ORDER BY total_minutes DESC`,
      params
    );

    // By board
    const byBoard = await db.query(
      `SELECT b.id, b.name,
        COUNT(te.id) as entries_count,
        COALESCE(SUM(te.duration_minutes), 0) as total_minutes
      FROM time_entries te
      JOIN items i ON te.item_id = i.id
      JOIN boards b ON i.board_id = b.id
      WHERE b.workspace_id = $1 AND te.end_time IS NOT NULL ${dateFilter}
      GROUP BY b.id, b.name
      ORDER BY total_minutes DESC`,
      params
    );

    // Totals
    const totals = await db.query(
      `SELECT 
        COUNT(te.id) as total_entries,
        COALESCE(SUM(te.duration_minutes), 0) as total_minutes,
        COUNT(DISTINCT te.user_id) as active_members,
        SUM(CASE WHEN te.is_billable THEN te.duration_minutes ELSE 0 END) as billable_minutes
      FROM time_entries te
      JOIN items i ON te.item_id = i.id
      JOIN boards b ON i.board_id = b.id
      WHERE b.workspace_id = $1 AND te.end_time IS NOT NULL ${dateFilter}`,
      params
    );

    res.json({
      byMember: byMember.rows,
      byBoard: byBoard.rows,
      totals: totals.rows[0],
    });
  } catch (error) {
    logger.error('Time report error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create time entry (manual or start timer)
router.post('/', authenticate, async (req, res) => {
  try {
    const { itemId, description, startTime, endTime, durationMinutes, isBillable } = req.body;

    if (!itemId) {
      return res.status(400).json({ error: 'itemId requis' });
    }

    // If starting a timer, stop any active timer first
    if (!endTime && !durationMinutes) {
      await db.query(
        `UPDATE time_entries SET end_time = NOW(), 
          duration_minutes = EXTRACT(EPOCH FROM (NOW() - start_time)) / 60
        WHERE user_id = $1 AND end_time IS NULL`,
        [req.userId]
      );
    }

    const { rows } = await db.query(
      `INSERT INTO time_entries (item_id, user_id, description, start_time, end_time, duration_minutes, is_billable)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        itemId,
        req.userId,
        description || null,
        startTime || new Date().toISOString(),
        endTime || null,
        durationMinutes || null,
        isBillable || false,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Create time entry error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Stop active timer
router.post('/stop', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE time_entries 
      SET end_time = NOW(), 
        duration_minutes = EXTRACT(EPOCH FROM (NOW() - start_time)) / 60,
        updated_at = NOW()
      WHERE user_id = $1 AND end_time IS NULL
      RETURNING *`,
      [req.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Aucun chronomètre actif' });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('Stop timer error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update time entry
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { description, startTime, endTime, durationMinutes, isBillable } = req.body;

    const { rows } = await db.query(
      `UPDATE time_entries 
      SET description = COALESCE($1, description),
        start_time = COALESCE($2, start_time),
        end_time = COALESCE($3, end_time),
        duration_minutes = COALESCE($4, duration_minutes),
        is_billable = COALESCE($5, is_billable),
        updated_at = NOW()
      WHERE id = $6 AND user_id = $7
      RETURNING *`,
      [description, startTime, endTime, durationMinutes, isBillable, req.params.id, req.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Entrée non trouvée' });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('Update time entry error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete time entry
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM time_entries WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Entrée non trouvée' });
    }

    res.json({ message: 'Entrée supprimée' });
  } catch (error) {
    logger.error('Delete time entry error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
