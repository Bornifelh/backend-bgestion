const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Workload report by member
router.get('/workspace/:workspaceId/workload', authenticate, async (req, res) => {
  try {
    const wsId = req.params.workspaceId;

    const { rows } = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email,
        COUNT(DISTINCT i.id) as total_tasks,
        COUNT(DISTINCT i.id) FILTER (WHERE iv_status.value::text ILIKE '%done%' OR iv_status.value::text ILIKE '%completed%') as completed_tasks,
        COALESCE(SUM(te.duration_minutes), 0) as total_time_minutes,
        COUNT(DISTINCT i.id) FILTER (WHERE iv_date.value IS NOT NULL AND (iv_date.value::text)::date < CURRENT_DATE
          AND iv_status.value::text NOT ILIKE '%done%' AND iv_status.value::text NOT ILIKE '%completed%') as overdue_tasks
      FROM workspace_members wm
      JOIN users u ON wm.user_id = u.id
      LEFT JOIN item_values iv_person ON iv_person.value::text LIKE '%' || u.id::text || '%'
      LEFT JOIN items i ON iv_person.item_id = i.id
      LEFT JOIN boards b ON i.board_id = b.id AND b.workspace_id = $1
      LEFT JOIN item_values iv_status ON i.id = iv_status.item_id
        AND iv_status.column_id IN (SELECT c.id FROM columns c JOIN column_types ct ON c.column_type_id = ct.id WHERE ct.name = 'status')
      LEFT JOIN item_values iv_date ON i.id = iv_date.item_id
        AND iv_date.column_id IN (SELECT c.id FROM columns c JOIN column_types ct ON c.column_type_id = ct.id WHERE ct.name = 'date')
      LEFT JOIN time_entries te ON te.user_id = u.id AND te.end_time IS NOT NULL
      WHERE wm.workspace_id = $1
      GROUP BY u.id, u.first_name, u.last_name, u.email
      ORDER BY total_tasks DESC`,
      [wsId]
    );

    res.json(rows);
  } catch (error) {
    logger.error('Workload report error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Deadline compliance report
router.get('/workspace/:workspaceId/deadlines', authenticate, async (req, res) => {
  try {
    const wsId = req.params.workspaceId;

    const { rows } = await db.query(
      `SELECT b.id as board_id, b.name as board_name,
        COUNT(DISTINCT i.id) as total_with_deadline,
        COUNT(DISTINCT i.id) FILTER (WHERE (iv_date.value::text)::date >= CURRENT_DATE OR 
          iv_status.value::text ILIKE '%done%' OR iv_status.value::text ILIKE '%completed%') as on_time,
        COUNT(DISTINCT i.id) FILTER (WHERE (iv_date.value::text)::date < CURRENT_DATE AND 
          iv_status.value::text NOT ILIKE '%done%' AND iv_status.value::text NOT ILIKE '%completed%') as overdue
      FROM boards b
      JOIN items i ON i.board_id = b.id
      JOIN item_values iv_date ON iv_date.item_id = i.id
      JOIN columns c_date ON iv_date.column_id = c_date.id
      JOIN column_types ct_date ON c_date.column_type_id = ct_date.id AND ct_date.name = 'date'
      LEFT JOIN item_values iv_status ON iv_status.item_id = i.id
        AND iv_status.column_id IN (SELECT c.id FROM columns c JOIN column_types ct ON c.column_type_id = ct.id WHERE ct.name = 'status')
      WHERE b.workspace_id = $1 AND iv_date.value IS NOT NULL
      GROUP BY b.id, b.name
      ORDER BY overdue DESC`,
      [wsId]
    );

    res.json(rows);
  } catch (error) {
    logger.error('Deadline report error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Activity summary report
router.get('/workspace/:workspaceId/activity-summary', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const wsId = req.params.workspaceId;
    const params = [wsId];
    let dateFilter = '';
    let paramIdx = 2;

    if (startDate) {
      dateFilter += ` AND al.created_at >= $${paramIdx}`;
      params.push(startDate);
      paramIdx++;
    }
    if (endDate) {
      dateFilter += ` AND al.created_at <= $${paramIdx}`;
      params.push(endDate);
      paramIdx++;
    }

    // Daily activity counts
    const daily = await db.query(
      `SELECT DATE(al.created_at) as date, COUNT(*) as count
      FROM activity_logs al
      WHERE al.workspace_id = $1 ${dateFilter}
      GROUP BY DATE(al.created_at)
      ORDER BY date DESC LIMIT 30`,
      params
    );

    // By action type
    const byAction = await db.query(
      `SELECT al.action, COUNT(*) as count
      FROM activity_logs al
      WHERE al.workspace_id = $1 ${dateFilter}
      GROUP BY al.action
      ORDER BY count DESC`,
      params
    );

    // By user
    const byUser = await db.query(
      `SELECT u.id, u.first_name, u.last_name, COUNT(al.id) as count
      FROM activity_logs al
      JOIN users u ON al.user_id = u.id
      WHERE al.workspace_id = $1 ${dateFilter}
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY count DESC LIMIT 10`,
      params
    );

    res.json({
      daily: daily.rows,
      byAction: byAction.rows,
      byUser: byUser.rows,
    });
  } catch (error) {
    logger.error('Activity summary error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
