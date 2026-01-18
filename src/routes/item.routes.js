const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate, checkBoardAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// ==========================================
// ROUTES SPECIFIQUES (avant les routes paramétrées)
// ==========================================

// Create item
router.post('/', authenticate, [
  body('boardId').isUUID().withMessage('ID board invalide'),
  body('name').trim().notEmpty().withMessage('Nom de l\'item requis'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { boardId, groupId, name, values } = req.body;

    // Check board access
    const boardAccess = await db.query(
      `SELECT b.*, wm.role as workspace_role
       FROM boards b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2`,
      [boardId, req.userId]
    );

    if (boardAccess.rows.length === 0) {
      return res.status(403).json({ error: 'Accès au board non autorisé' });
    }

    // Get max position in group
    const posResult = await db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 as next_pos 
       FROM items 
       WHERE board_id = $1 AND ($2::uuid IS NULL OR group_id = $2)`,
      [boardId, groupId || null]
    );

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // Create item
      const itemResult = await client.query(
        `INSERT INTO items (board_id, group_id, name, position, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [boardId, groupId || null, name, posResult.rows[0].next_pos, req.userId]
      );

      const item = itemResult.rows[0];

      // Insert values if provided
      if (values && typeof values === 'object') {
        for (const [columnId, value] of Object.entries(values)) {
          // Always stringify for JSONB column
          const serializedValue = JSON.stringify(value);
          await client.query(
            `INSERT INTO item_values (item_id, column_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3`,
            [item.id, columnId, serializedValue]
          );
        }
      }

      await client.query('COMMIT');

      // Log activity
      try {
        await db.query(
          `INSERT INTO activity_logs (workspace_id, board_id, item_id, user_id, action, entity_type, entity_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [boardAccess.rows[0].workspace_id, boardId, item.id, req.userId, 'created', 'item', item.id]
        );
      } catch (logError) {
        logger.warn('Activity log insert failed:', logError.message);
      }

      // Emit socket event
      const io = req.app.get('io');
      io.to(`board:${boardId}`).emit('item:created', {
        id: item.id,
        boardId: item.board_id,
        groupId: item.group_id,
        name: item.name,
        position: item.position,
        values: values || {},
        createdBy: req.userId,
      });

      res.status(201).json({
        id: item.id,
        boardId: item.board_id,
        groupId: item.group_id,
        name: item.name,
        position: item.position,
        values: values || {},
        createdBy: item.created_by,
        createdAt: item.created_at,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Create item error:', error);
    res.status(500).json({ error: 'Erreur lors de la création de l\'item' });
  }
});

// Batch update items (for reordering) - MUST BE BEFORE /:itemId
router.put('/batch/reorder', authenticate, async (req, res) => {
  try {
    const { items } = req.body; // Array of { id, position, groupId }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Liste d\'items requise' });
    }

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      let boardId;
      for (const item of items) {
        const result = await client.query(
          `UPDATE items SET position = $1, group_id = $2
           WHERE id = $3
           RETURNING board_id`,
          [item.position, item.groupId || null, item.id]
        );
        if (result.rows.length > 0) {
          boardId = result.rows[0].board_id;
        }
      }

      await client.query('COMMIT');

      // Emit socket event
      if (boardId) {
        const io = req.app.get('io');
        io.to(`board:${boardId}`).emit('items:reordered', { items });
      }

      res.json({ message: 'Items réordonnés avec succès' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Batch reorder items error:', error);
    res.status(500).json({ error: 'Erreur lors du réordonnancement des items' });
  }
});

// Batch delete items - MUST BE BEFORE /:itemId
router.delete('/batch', authenticate, async (req, res) => {
  try {
    const { itemIds } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'Liste d\'IDs requise' });
    }

    // Check access to all items
    const accessCheck = await db.query(
      `SELECT DISTINCT i.board_id
       FROM items i
       JOIN boards b ON b.id = i.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE i.id = ANY($1) AND wm.user_id = $2`,
      [itemIds, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const boardIds = accessCheck.rows.map(r => r.board_id);

    await db.query('DELETE FROM items WHERE id = ANY($1)', [itemIds]);

    // Emit socket events
    const io = req.app.get('io');
    boardIds.forEach(boardId => {
      io.to(`board:${boardId}`).emit('items:deleted', { itemIds });
    });

    res.json({ message: `${itemIds.length} items supprimés` });
  } catch (error) {
    logger.error('Batch delete items error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression des items' });
  }
});

// ==========================================
// ROUTES PARAMETREES (après les routes spécifiques)
// ==========================================

// Update item
router.put('/:itemId', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { name, groupId, position } = req.body;

    // Get item and check access
    const itemResult = await db.query(
      `SELECT i.*, b.workspace_id
       FROM items i
       JOIN boards b ON b.id = i.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE i.id = $1 AND wm.user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item non trouvé ou accès non autorisé' });
    }

    const item = itemResult.rows[0];
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (groupId !== undefined) {
      updates.push(`group_id = $${paramCount++}`);
      values.push(groupId);
    }
    if (position !== undefined) {
      updates.push(`position = $${paramCount++}`);
      values.push(position);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(itemId);

    const result = await db.query(
      `UPDATE items SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    const updatedItem = result.rows[0];

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${item.board_id}`).emit('item:updated', {
      id: updatedItem.id,
      name: updatedItem.name,
      groupId: updatedItem.group_id,
      position: updatedItem.position,
    });

    res.json({
      id: updatedItem.id,
      name: updatedItem.name,
      groupId: updatedItem.group_id,
      position: updatedItem.position,
    });
  } catch (error) {
    logger.error('Update item error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de l\'item' });
  }
});

// Update item value
router.put('/:itemId/values/:columnId', authenticate, async (req, res) => {
  try {
    const { itemId, columnId } = req.params;
    const { value } = req.body;

    // Get item and check access
    const itemResult = await db.query(
      `SELECT i.*, b.workspace_id
       FROM items i
       JOIN boards b ON b.id = i.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE i.id = $1 AND wm.user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item non trouvé ou accès non autorisé' });
    }

    const item = itemResult.rows[0];

    // Get old value for activity log
    const oldValueResult = await db.query(
      'SELECT value FROM item_values WHERE item_id = $1 AND column_id = $2',
      [itemId, columnId]
    );
    const oldValue = oldValueResult.rows[0]?.value;

    // Serialize value to valid JSON - always stringify for JSONB column
    const serializedValue = JSON.stringify(value);

    // Upsert value
    await db.query(
      `INSERT INTO item_values (item_id, column_id, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP`,
      [itemId, columnId, serializedValue]
    );

    // Log activity - old_value is already JSON from DB, new_value needs to match format
    try {
      await db.query(
        `INSERT INTO activity_logs (workspace_id, board_id, item_id, user_id, action, entity_type, entity_id, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [item.workspace_id, item.board_id, itemId, req.userId, 'value_changed', 'item_value', columnId, oldValue || null, serializedValue]
      );
    } catch (logError) {
      // Don't fail the main operation if activity logging fails
      logger.warn('Activity log insert failed:', logError.message);
    }

    // Auto-update progress when status changes
    let progressUpdate = null;
    try {
      // Check if this is a status column
      const columnCheck = await db.query(`
        SELECT c.id, ct.name as type_name 
        FROM columns c 
        JOIN column_types ct ON ct.id = c.column_type_id 
        WHERE c.id = $1
      `, [columnId]);
      
      if (columnCheck.rows[0]?.type_name === 'status') {
        // Get the label info to determine progress
        const labelInfo = await db.query(`
          SELECT sl.label, sl.position, 
                 (SELECT COUNT(*) FROM status_labels WHERE column_id = sl.column_id) as total_labels
          FROM status_labels sl
          WHERE sl.id = $1
        `, [value]);
        
        if (labelInfo.rows.length > 0) {
          const { label, position, total_labels } = labelInfo.rows[0];
          const labelLower = (label || '').toLowerCase();
          
          // Determine progress based on status
          let newProgress = null;
          if (labelLower.includes('terminé') || labelLower.includes('done') || labelLower.includes('complet')) {
            newProgress = 100;
          } else if (labelLower.includes('cours') || labelLower.includes('progress')) {
            newProgress = 50;
          } else if (labelLower.includes('faire') || labelLower.includes('todo') || position === 0) {
            newProgress = 0;
          } else {
            // Calculate based on position
            newProgress = Math.round((position / (total_labels - 1)) * 100);
          }
          
          // Find progress column in the same board
          const progressCol = await db.query(`
            SELECT c.id FROM columns c
            JOIN column_types ct ON ct.id = c.column_type_id
            WHERE c.board_id = $1 AND ct.name = 'progress'
            LIMIT 1
          `, [item.board_id]);
          
          if (progressCol.rows.length > 0 && newProgress !== null) {
            const progressColumnId = progressCol.rows[0].id;
            const progressValue = JSON.stringify({ progress: newProgress });
            
            await db.query(`
              INSERT INTO item_values (item_id, column_id, value)
              VALUES ($1, $2, $3)
              ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP
            `, [itemId, progressColumnId, progressValue]);
            
            progressUpdate = { columnId: progressColumnId, value: { progress: newProgress } };
          }
        }
      }
    } catch (autoError) {
      logger.warn('Auto progress update failed:', autoError.message);
    }

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${item.board_id}`).emit('item:value_updated', {
      itemId,
      columnId,
      value,
      updatedBy: req.userId,
    });
    
    // Also emit progress update if changed
    if (progressUpdate) {
      io.to(`board:${item.board_id}`).emit('item:value_updated', {
        itemId,
        columnId: progressUpdate.columnId,
        value: progressUpdate.value,
        updatedBy: req.userId,
      });
    }

    res.json({ 
      itemId, 
      columnId, 
      value,
      progressUpdate: progressUpdate || undefined 
    });
  } catch (error) {
    logger.error('Update item value error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la valeur' });
  }
});

// Delete item
router.delete('/:itemId', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;

    // Get item and check access
    const itemResult = await db.query(
      `SELECT i.*, b.workspace_id
       FROM items i
       JOIN boards b ON b.id = i.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE i.id = $1 AND wm.user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item non trouvé ou accès non autorisé' });
    }

    const item = itemResult.rows[0];

    await db.query('DELETE FROM items WHERE id = $1', [itemId]);

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${item.board_id}`).emit('item:deleted', {
      itemId,
      boardId: item.board_id,
      groupId: item.group_id,
    });

    res.json({ message: 'Item supprimé avec succès' });
  } catch (error) {
    logger.error('Delete item error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de l\'item' });
  }
});

// Duplicate item
router.post('/:itemId/duplicate', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;

    // Get item and check access
    const itemResult = await db.query(
      `SELECT i.*, b.workspace_id
       FROM items i
       JOIN boards b ON b.id = i.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE i.id = $1 AND wm.user_id = $2`,
      [itemId, req.userId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item non trouvé ou accès non autorisé' });
    }

    const item = itemResult.rows[0];

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // Create new item
      const newItemResult = await client.query(
        `INSERT INTO items (board_id, group_id, name, position, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [item.board_id, item.group_id, `${item.name} (copie)`, item.position + 1, req.userId]
      );

      const newItem = newItemResult.rows[0];

      // Copy values
      await client.query(
        `INSERT INTO item_values (item_id, column_id, value)
         SELECT $1, column_id, value
         FROM item_values
         WHERE item_id = $2`,
        [newItem.id, itemId]
      );

      // Get values
      const valuesResult = await client.query(
        'SELECT column_id, value FROM item_values WHERE item_id = $1',
        [newItem.id]
      );

      const values = {};
      valuesResult.rows.forEach(v => {
        values[v.column_id] = v.value;
      });

      await client.query('COMMIT');

      // Emit socket event
      const io = req.app.get('io');
      io.to(`board:${item.board_id}`).emit('item:created', {
        id: newItem.id,
        boardId: newItem.board_id,
        groupId: newItem.group_id,
        name: newItem.name,
        position: newItem.position,
        values,
        createdBy: req.userId,
      });

      res.status(201).json({
        id: newItem.id,
        boardId: newItem.board_id,
        groupId: newItem.group_id,
        name: newItem.name,
        position: newItem.position,
        values,
        createdAt: newItem.created_at,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Duplicate item error:', error);
    res.status(500).json({ error: 'Erreur lors de la duplication de l\'item' });
  }
});

module.exports = router;
