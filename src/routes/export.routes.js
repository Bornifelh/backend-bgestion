const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Export board data as JSON (for CSV/Excel conversion on frontend)
router.get('/board/:boardId', authenticate, async (req, res) => {
  try {
    const { boardId } = req.params;
    const { format = 'json' } = req.query;

    // Get board info
    const boardResult = await db.query(
      'SELECT * FROM boards WHERE id = $1',
      [boardId]
    );

    if (boardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Board non trouvé' });
    }

    const board = boardResult.rows[0];

    // Get columns
    const columnsResult = await db.query(
      'SELECT * FROM columns WHERE board_id = $1 ORDER BY position',
      [boardId]
    );

    // Get groups
    const groupsResult = await db.query(
      'SELECT * FROM groups WHERE board_id = $1 ORDER BY position',
      [boardId]
    );

    // Get items with their values
    const itemsResult = await db.query(
      `SELECT i.*, g.name as group_name,
        (SELECT json_object_agg(iv.column_id, iv.value) 
         FROM item_values iv WHERE iv.item_id = i.id) as values
       FROM items i
       LEFT JOIN groups g ON g.id = i.group_id
       WHERE i.board_id = $1
       ORDER BY i.position`,
      [boardId]
    );

    // Get members for person columns
    const membersResult = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = $1`,
      [board.workspace_id]
    );

    const membersMap = {};
    membersResult.rows.forEach(m => {
      membersMap[m.id] = `${m.first_name} ${m.last_name}`;
    });

    const columns = columnsResult.rows.map(c => ({
      id: c.id,
      title: c.title,
      type: c.type || 'text',
      settings: c.settings,
    }));

    // Process items into flat structure for export
    const exportData = itemsResult.rows.map(item => {
      const row = {
        'Nom': item.name,
        'Groupe': item.group_name || '',
        'Créé le': new Date(item.created_at).toLocaleDateString('fr-FR'),
      };

      // Add column values
      columns.forEach(col => {
        let value = item.values?.[col.id];
        
        if (value) {
          // Handle different value types
          if (col.type === 'person') {
            const userIds = value.userIds || (Array.isArray(value) ? value : [value]);
            value = userIds.map(id => membersMap[id] || id).join(', ');
          } else if (col.type === 'date') {
            value = value ? new Date(value).toLocaleDateString('fr-FR') : '';
          } else if (col.type === 'progress') {
            value = typeof value === 'object' ? `${value.progress || 0}%` : `${value || 0}%`;
          } else if (col.type === 'status' || col.type === 'priority') {
            // Find label name
            const labels = col.settings?.labels || [];
            const label = labels.find(l => l.id === value);
            value = label?.name || label?.label || value;
          } else if (col.type === 'checkbox') {
            value = value ? 'Oui' : 'Non';
          } else if (typeof value === 'object') {
            value = JSON.stringify(value);
          }
        }
        
        row[col.title] = value || '';
      });

      return row;
    });

    if (format === 'csv') {
      // Generate CSV
      const headers = Object.keys(exportData[0] || { 'Nom': '', 'Groupe': '', 'Créé le': '' });
      const csvRows = [headers.join(',')];
      
      exportData.forEach(row => {
        const values = headers.map(h => {
          const val = (row[h] || '').toString().replace(/"/g, '""');
          return `"${val}"`;
        });
        csvRows.push(values.join(','));
      });

      const csv = csvRows.join('\n');
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${board.name}.csv"`);
      return res.send('\ufeff' + csv); // BOM for Excel UTF-8 support
    }

    // Return JSON for frontend processing
    res.json({
      board: {
        id: board.id,
        name: board.name,
      },
      columns: columns,
      groups: groupsResult.rows.map(g => ({
        id: g.id,
        name: g.name,
        color: g.color,
      })),
      items: exportData,
      raw: itemsResult.rows.map(item => ({
        id: item.id,
        name: item.name,
        groupId: item.group_id,
        groupName: item.group_name,
        values: item.values || {},
        createdAt: item.created_at,
      })),
    });
  } catch (error) {
    logger.error('Export board error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'export' });
  }
});

// Export workspace data
router.get('/workspace/:workspaceId', authenticate, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Get workspace info
    const workspaceResult = await db.query(
      'SELECT * FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (workspaceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Workspace non trouvé' });
    }

    // Get all boards
    const boardsResult = await db.query(
      'SELECT id, name, description, icon FROM boards WHERE workspace_id = $1 ORDER BY position',
      [workspaceId]
    );

    // Get members
    const membersResult = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, wm.role, wm.joined_at
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = $1`,
      [workspaceId]
    );

    res.json({
      workspace: {
        id: workspaceResult.rows[0].id,
        name: workspaceResult.rows[0].name,
        description: workspaceResult.rows[0].description,
      },
      boards: boardsResult.rows,
      members: membersResult.rows.map(m => ({
        id: m.id,
        name: `${m.first_name} ${m.last_name}`,
        email: m.email,
        role: m.role,
        joinedAt: m.joined_at,
      })),
    });
  } catch (error) {
    logger.error('Export workspace error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'export' });
  }
});

module.exports = router;
