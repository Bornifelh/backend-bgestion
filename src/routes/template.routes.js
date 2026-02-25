const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get all templates (public + user's own)
router.get('/', authenticate, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    let query = `
      SELECT t.*, u.first_name, u.last_name
      FROM templates t
      LEFT JOIN users u ON t.created_by = u.id
      WHERE t.is_public = true`;
    const params = [];
    let paramIdx = 1;

    if (workspaceId) {
      query += ` OR t.workspace_id = $${paramIdx}`;
      params.push(workspaceId);
      paramIdx++;
    }

    query += ` OR t.created_by = $${paramIdx}`;
    params.push(req.userId);

    query += ' ORDER BY t.created_at DESC';

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    logger.error('Get templates error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create template from existing board
router.post('/', authenticate, async (req, res) => {
  try {
    const { boardId, name, description, isPublic = false } = req.body;

    if (!boardId || !name) {
      return res.status(400).json({ error: 'boardId et name requis' });
    }

    // Get board data
    const board = await db.query('SELECT * FROM boards WHERE id = $1', [boardId]);
    if (board.rows.length === 0) {
      return res.status(404).json({ error: 'Board non trouvé' });
    }

    // Get columns with labels
    const columnsRes = await db.query(
      `SELECT c.*, ct.name as type_name,
        COALESCE(json_agg(json_build_object('id', sl.id, 'label', sl.label, 'color', sl.color, 'position', sl.position)) 
          FILTER (WHERE sl.id IS NOT NULL), '[]') as labels
      FROM columns c
      LEFT JOIN column_types ct ON c.column_type_id = ct.id
      LEFT JOIN status_labels sl ON c.id = sl.column_id
      WHERE c.board_id = $1
      GROUP BY c.id, ct.name
      ORDER BY c.position`,
      [boardId]
    );

    // Get groups
    const groupsRes = await db.query(
      'SELECT * FROM groups WHERE board_id = $1 ORDER BY position',
      [boardId]
    );

    const templateData = {
      board: { name: board.rows[0].name, type: board.rows[0].type, color: board.rows[0].color },
      columns: columnsRes.rows.map(c => ({
        title: c.title, type: c.type_name, width: c.width, position: c.position,
        settings: c.settings, labels: c.labels,
      })),
      groups: groupsRes.rows.map(g => ({
        name: g.name, color: g.color, position: g.position,
      })),
    };

    const { rows } = await db.query(
      `INSERT INTO templates (workspace_id, name, description, type, template_data, is_public, created_by)
      VALUES ($1, $2, $3, 'board', $4, $5, $6)
      RETURNING *`,
      [board.rows[0].workspace_id, name, description || null, JSON.stringify(templateData), isPublic, req.userId]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Create template error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Apply template to create a new board
router.post('/:templateId/apply', authenticate, async (req, res) => {
  try {
    const { workspaceId, boardName } = req.body;

    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId requis' });
    }

    const template = await db.query('SELECT * FROM templates WHERE id = $1', [req.params.templateId]);
    if (template.rows.length === 0) {
      return res.status(404).json({ error: 'Template non trouvé' });
    }

    const data = template.rows[0].template_data;
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // Create board
      const boardRes = await client.query(
        `INSERT INTO boards (workspace_id, name, type, color, owner_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [workspaceId, boardName || data.board?.name || 'Nouveau board', data.board?.type || 'board', data.board?.color || '#6366f1', req.userId]
      );
      const newBoard = boardRes.rows[0];

      // Create columns
      for (const col of (data.columns || [])) {
        const typeRes = await client.query('SELECT id FROM column_types WHERE name = $1', [col.type]);
        if (typeRes.rows.length === 0) continue;

        const colRes = await client.query(
          `INSERT INTO columns (board_id, column_type_id, title, width, position, settings)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [newBoard.id, typeRes.rows[0].id, col.title, col.width, col.position, JSON.stringify(col.settings || {})]
        );

        // Create labels for status columns
        if (col.labels && col.labels.length > 0) {
          for (const label of col.labels) {
            if (label.label) {
              await client.query(
                `INSERT INTO status_labels (column_id, label, color, position)
                VALUES ($1, $2, $3, $4)`,
                [colRes.rows[0].id, label.label, label.color, label.position || 0]
              );
            }
          }
        }
      }

      // Create groups
      for (const group of (data.groups || [])) {
        await client.query(
          `INSERT INTO groups (board_id, name, color, position)
          VALUES ($1, $2, $3, $4)`,
          [newBoard.id, group.name, group.color, group.position]
        );
      }

      await client.query('COMMIT');
      res.status(201).json(newBoard);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Apply template error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete template
router.delete('/:templateId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM templates WHERE id = $1 AND created_by = $2', [req.params.templateId, req.userId]);
    res.json({ message: 'Template supprimé' });
  } catch (error) {
    logger.error('Delete template error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
