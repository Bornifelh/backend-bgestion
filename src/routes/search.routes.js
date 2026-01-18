const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Global search
router.get('/', authenticate, async (req, res) => {
  try {
    const { q, type, limit = 20 } = req.query;

    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }

    const searchTerm = `%${q.toLowerCase()}%`;
    const results = {
      items: [],
      boards: [],
      workspaces: [],
      members: [],
    };

    // Get user's workspaces
    const userWorkspaces = await db.query(
      'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
      [req.userId]
    );
    const workspaceIds = userWorkspaces.rows.map(r => r.workspace_id);

    if (workspaceIds.length === 0) {
      return res.json({ results });
    }

    // Search items
    if (!type || type === 'items') {
      const itemsResult = await db.query(
        `SELECT i.*, b.name as board_name, b.icon as board_icon, w.name as workspace_name
         FROM items i
         JOIN boards b ON b.id = i.board_id
         JOIN workspaces w ON w.id = b.workspace_id
         WHERE b.workspace_id = ANY($1)
           AND LOWER(i.name) LIKE $2
         ORDER BY i.updated_at DESC
         LIMIT $3`,
        [workspaceIds, searchTerm, parseInt(limit)]
      );

      results.items = itemsResult.rows.map(i => ({
        id: i.id,
        name: i.name,
        boardId: i.board_id,
        boardName: i.board_name,
        boardIcon: i.board_icon,
        workspaceName: i.workspace_name,
        type: 'item',
      }));
    }

    // Search boards
    if (!type || type === 'boards') {
      const boardsResult = await db.query(
        `SELECT b.*, w.name as workspace_name
         FROM boards b
         JOIN workspaces w ON w.id = b.workspace_id
         WHERE b.workspace_id = ANY($1)
           AND (LOWER(b.name) LIKE $2 OR LOWER(b.description) LIKE $2)
         ORDER BY b.updated_at DESC
         LIMIT $3`,
        [workspaceIds, searchTerm, parseInt(limit)]
      );

      results.boards = boardsResult.rows.map(b => ({
        id: b.id,
        name: b.name,
        description: b.description,
        icon: b.icon,
        color: b.color,
        workspaceId: b.workspace_id,
        workspaceName: b.workspace_name,
        type: 'board',
      }));
    }

    // Search workspaces
    if (!type || type === 'workspaces') {
      const workspacesResult = await db.query(
        `SELECT w.*
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = $1
           AND (LOWER(w.name) LIKE $2 OR LOWER(w.description) LIKE $2)
         ORDER BY w.updated_at DESC
         LIMIT $3`,
        [req.userId, searchTerm, parseInt(limit)]
      );

      results.workspaces = workspacesResult.rows.map(w => ({
        id: w.id,
        name: w.name,
        description: w.description,
        icon: w.icon,
        color: w.color,
        type: 'workspace',
      }));
    }

    // Search members
    if (!type || type === 'members') {
      const membersResult = await db.query(
        `SELECT DISTINCT u.id, u.first_name, u.last_name, u.email, u.avatar_url
         FROM users u
         JOIN workspace_members wm ON wm.user_id = u.id
         WHERE wm.workspace_id = ANY($1)
           AND (LOWER(u.first_name) LIKE $2 
                OR LOWER(u.last_name) LIKE $2 
                OR LOWER(u.email) LIKE $2
                OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE $2)
         LIMIT $3`,
        [workspaceIds, searchTerm, parseInt(limit)]
      );

      results.members = membersResult.rows.map(m => ({
        id: m.id,
        name: `${m.first_name} ${m.last_name}`,
        email: m.email,
        avatarUrl: m.avatar_url,
        type: 'member',
      }));
    }

    // Flatten results for easier frontend handling
    const allResults = [
      ...results.items,
      ...results.boards,
      ...results.workspaces,
      ...results.members,
    ];

    res.json({
      results: allResults,
      grouped: results,
      total: allResults.length,
    });
  } catch (error) {
    logger.error('Search error:', error);
    res.status(500).json({ error: 'Erreur lors de la recherche' });
  }
});

// Quick search (items only, for autocomplete)
router.get('/quick', authenticate, async (req, res) => {
  try {
    const { q, boardId } = req.query;

    if (!q || q.length < 1) {
      return res.json([]);
    }

    const searchTerm = `%${q.toLowerCase()}%`;
    let query = '';
    let params = [];

    if (boardId) {
      query = `
        SELECT i.id, i.name, b.name as board_name
        FROM items i
        JOIN boards b ON b.id = i.board_id
        WHERE i.board_id = $1 AND LOWER(i.name) LIKE $2
        ORDER BY i.updated_at DESC
        LIMIT 10
      `;
      params = [boardId, searchTerm];
    } else {
      // Get user's workspaces first
      const userWorkspaces = await db.query(
        'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
        [req.userId]
      );
      const workspaceIds = userWorkspaces.rows.map(r => r.workspace_id);

      if (workspaceIds.length === 0) {
        return res.json([]);
      }

      query = `
        SELECT i.id, i.name, b.name as board_name, b.id as board_id
        FROM items i
        JOIN boards b ON b.id = i.board_id
        WHERE b.workspace_id = ANY($1) AND LOWER(i.name) LIKE $2
        ORDER BY i.updated_at DESC
        LIMIT 10
      `;
      params = [workspaceIds, searchTerm];
    }

    const result = await db.query(query, params);

    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      boardId: r.board_id,
      boardName: r.board_name,
    })));
  } catch (error) {
    logger.error('Quick search error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

module.exports = router;
