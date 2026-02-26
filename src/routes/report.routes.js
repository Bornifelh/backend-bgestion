const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { authenticate } = require("../middleware/auth.middleware");
const logger = require("../utils/logger");

// Workload report by member
router.get(
  "/workspace/:workspaceId/workload",
  authenticate,
  async (req, res) => {
    try {
      const wsId = req.params.workspaceId;

      const { rows } = await db.query(
        `SELECT u.id, u.first_name, u.last_name, u.email,
        COUNT(DISTINCT i.id) as total_tasks,
        COUNT(DISTINCT i.id) FILTER (
          WHERE iv_status.value::text ILIKE '%done%'
             OR iv_status.value::text ILIKE '%completed%'
             OR iv_status.value::text ILIKE '%terminé%'
        ) as completed_tasks,
        COALESCE(te_agg.total_minutes, 0) as total_time_minutes,
        COUNT(DISTINCT i.id) FILTER (
          WHERE iv_date.value IS NOT NULL
            AND TRIM(BOTH '"' FROM iv_date.value::text) != ''
            AND TRIM(BOTH '"' FROM iv_date.value::text) != 'null'
            AND (TRIM(BOTH '"' FROM iv_date.value::text))::date < CURRENT_DATE
            AND iv_status.value::text NOT ILIKE '%done%'
            AND iv_status.value::text NOT ILIKE '%completed%'
            AND iv_status.value::text NOT ILIKE '%terminé%'
        ) as overdue_tasks
      FROM workspace_members wm
      JOIN users u ON wm.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT DISTINCT iv_p.item_id
        FROM item_values iv_p
        JOIN columns c_p ON iv_p.column_id = c_p.id
        JOIN column_types ct_p ON c_p.column_type_id = ct_p.id AND ct_p.name = 'person'
        WHERE iv_p.value::text LIKE '%' || u.id::text || '%'
      ) assigned ON true
      LEFT JOIN items i ON i.id = assigned.item_id
      LEFT JOIN boards b ON i.board_id = b.id AND b.workspace_id = $1
      LEFT JOIN LATERAL (
        SELECT iv_s.value
        FROM item_values iv_s
        JOIN columns c_s ON iv_s.column_id = c_s.id
        JOIN column_types ct_s ON c_s.column_type_id = ct_s.id AND ct_s.name = 'status'
        WHERE iv_s.item_id = i.id
        LIMIT 1
      ) iv_status ON b.id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT iv_d.value
        FROM item_values iv_d
        JOIN columns c_d ON iv_d.column_id = c_d.id
        JOIN column_types ct_d ON c_d.column_type_id = ct_d.id AND ct_d.name = 'date'
        WHERE iv_d.item_id = i.id
        LIMIT 1
      ) iv_date ON b.id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(te.duration_minutes), 0) as total_minutes
        FROM time_entries te
        WHERE te.user_id = u.id AND te.end_time IS NOT NULL
      ) te_agg ON true
      WHERE wm.workspace_id = $1
      GROUP BY u.id, u.first_name, u.last_name, u.email, te_agg.total_minutes
      ORDER BY total_tasks DESC`,
        [wsId],
      );

      res.json(rows);
    } catch (error) {
      logger.error("Workload report error:", error);
      res.json([]);
    }
  },
);

// Deadline compliance report
router.get(
  "/workspace/:workspaceId/deadlines",
  authenticate,
  async (req, res) => {
    try {
      const wsId = req.params.workspaceId;

      const { rows } = await db.query(
        `SELECT b.id as board_id, b.name as board_name,
        COUNT(DISTINCT i.id) as total_with_deadline,
        COUNT(DISTINCT i.id) FILTER (
          WHERE (TRIM(BOTH '"' FROM iv_date.value::text))::date >= CURRENT_DATE
             OR iv_status.value::text ILIKE '%done%'
             OR iv_status.value::text ILIKE '%completed%'
             OR iv_status.value::text ILIKE '%terminé%'
        ) as on_time,
        COUNT(DISTINCT i.id) FILTER (
          WHERE (TRIM(BOTH '"' FROM iv_date.value::text))::date < CURRENT_DATE
            AND iv_status.value::text NOT ILIKE '%done%'
            AND iv_status.value::text NOT ILIKE '%completed%'
            AND iv_status.value::text NOT ILIKE '%terminé%'
        ) as overdue
      FROM boards b
      JOIN items i ON i.board_id = b.id
      JOIN item_values iv_date ON iv_date.item_id = i.id
      JOIN columns c_date ON iv_date.column_id = c_date.id
      JOIN column_types ct_date ON c_date.column_type_id = ct_date.id AND ct_date.name = 'date'
      LEFT JOIN item_values iv_status ON iv_status.item_id = i.id
        AND iv_status.column_id IN (
          SELECT c.id FROM columns c
          JOIN column_types ct ON c.column_type_id = ct.id
          WHERE ct.name = 'status'
        )
      WHERE b.workspace_id = $1
        AND iv_date.value IS NOT NULL
        AND TRIM(BOTH '"' FROM iv_date.value::text) != ''
        AND TRIM(BOTH '"' FROM iv_date.value::text) != 'null'
      GROUP BY b.id, b.name
      ORDER BY overdue DESC`,
        [wsId],
      );

      res.json(rows);
    } catch (error) {
      logger.error("Deadline report error:", error);
      res.json([]);
    }
  },
);

// Activity summary report
router.get(
  "/workspace/:workspaceId/activity-summary",
  authenticate,
  async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const wsId = req.params.workspaceId;
      const params = [wsId];
      let dateFilter = "";
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

      const daily = await db.query(
        `SELECT DATE(al.created_at) as date, COUNT(*) as count
      FROM activity_logs al
      WHERE al.workspace_id = $1 ${dateFilter}
      GROUP BY DATE(al.created_at)
      ORDER BY date DESC LIMIT 30`,
        params,
      );

      const byAction = await db.query(
        `SELECT al.action, COUNT(*) as count
      FROM activity_logs al
      WHERE al.workspace_id = $1 ${dateFilter}
      GROUP BY al.action
      ORDER BY count DESC`,
        params,
      );

      const byUser = await db.query(
        `SELECT u.id, u.first_name, u.last_name, COUNT(al.id) as count
      FROM activity_logs al
      JOIN users u ON al.user_id = u.id
      WHERE al.workspace_id = $1 ${dateFilter}
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY count DESC LIMIT 10`,
        params,
      );

      res.json({
        daily: daily.rows,
        byAction: byAction.rows,
        byUser: byUser.rows,
      });
    } catch (error) {
      logger.error("Activity summary error:", error);
      res.json({ daily: [], byAction: [], byUser: [] });
    }
  },
);

module.exports = router;
