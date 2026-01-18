const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate, checkBoardAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get column types
router.get('/types', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM column_types ORDER BY name'
    );

    res.json(result.rows.map(ct => ({
      id: ct.id,
      name: ct.name,
      component: ct.component,
      defaultSettings: ct.default_settings,
    })));
  } catch (error) {
    logger.error('Get column types error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des types de colonnes' });
  }
});

// Create column
router.post('/', authenticate, [
  body('boardId').isUUID().withMessage('ID board invalide'),
  body('title').trim().notEmpty().withMessage('Titre de la colonne requis'),
  body('type').notEmpty().withMessage('Type de colonne requis'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { boardId, title, type, width, settings } = req.body;

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

    // Get column type
    const typeResult = await db.query(
      'SELECT * FROM column_types WHERE name = $1',
      [type]
    );

    if (typeResult.rows.length === 0) {
      return res.status(400).json({ error: 'Type de colonne invalide' });
    }

    const columnType = typeResult.rows[0];

    // Get max position
    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM columns WHERE board_id = $1',
      [boardId]
    );

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // Create column
      const result = await client.query(
        `INSERT INTO columns (board_id, column_type_id, title, width, position, settings)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          boardId,
          columnType.id,
          title,
          width || 150,
          posResult.rows[0].next_pos,
          settings ? JSON.stringify(settings) : columnType.default_settings
        ]
      );

      const column = result.rows[0];

      // If status column, create default labels
      if (type === 'status') {
        const defaultLabels = [
          { label: 'À faire', color: '#9ca3af', position: 0 },
          { label: 'En cours', color: '#3b82f6', position: 1 },
          { label: 'Terminé', color: '#22c55e', position: 2 },
        ];

        for (const label of defaultLabels) {
          await client.query(
            `INSERT INTO status_labels (column_id, label, color, position)
             VALUES ($1, $2, $3, $4)`,
            [column.id, label.label, label.color, label.position]
          );
        }
      }

      await client.query('COMMIT');

      // Get labels if status
      let labels = [];
      if (type === 'status') {
        const labelsResult = await db.query(
          'SELECT * FROM status_labels WHERE column_id = $1 ORDER BY position',
          [column.id]
        );
        labels = labelsResult.rows.map(l => ({
          id: l.id,
          label: l.label,
          color: l.color,
        }));
      }

      // Emit socket event
      const io = req.app.get('io');
      io.to(`board:${boardId}`).emit('column:created', {
        id: column.id,
        boardId: column.board_id,
        title: column.title,
        type: columnType.name,
        component: columnType.component,
        width: column.width,
        position: column.position,
        settings: column.settings,
        labels,
      });

      res.status(201).json({
        id: column.id,
        boardId: column.board_id,
        title: column.title,
        type: columnType.name,
        component: columnType.component,
        width: column.width,
        position: column.position,
        settings: column.settings,
        labels,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Create column error:', error);
    res.status(500).json({ error: 'Erreur lors de la création de la colonne' });
  }
});

// Update column
router.put('/:columnId', authenticate, async (req, res) => {
  try {
    const { columnId } = req.params;
    const { title, width, settings, isVisible } = req.body;

    // Check access
    const columnResult = await db.query(
      `SELECT c.*, b.workspace_id, ct.name as type_name, ct.component
       FROM columns c
       JOIN boards b ON b.id = c.board_id
       JOIN column_types ct ON ct.id = c.column_type_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE c.id = $1 AND wm.user_id = $2`,
      [columnId, req.userId]
    );

    if (columnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Colonne non trouvée ou accès non autorisé' });
    }

    const column = columnResult.rows[0];
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title);
    }
    if (width !== undefined) {
      updates.push(`width = $${paramCount++}`);
      values.push(width);
    }
    if (settings !== undefined) {
      updates.push(`settings = $${paramCount++}`);
      values.push(JSON.stringify(settings));
    }
    if (isVisible !== undefined) {
      updates.push(`is_visible = $${paramCount++}`);
      values.push(isVisible);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(columnId);

    const result = await db.query(
      `UPDATE columns SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    const updatedColumn = result.rows[0];

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${column.board_id}`).emit('column:updated', {
      id: updatedColumn.id,
      title: updatedColumn.title,
      width: updatedColumn.width,
      settings: updatedColumn.settings,
      isVisible: updatedColumn.is_visible,
    });

    res.json({
      id: updatedColumn.id,
      title: updatedColumn.title,
      type: column.type_name,
      component: column.component,
      width: updatedColumn.width,
      position: updatedColumn.position,
      settings: updatedColumn.settings,
      isVisible: updatedColumn.is_visible,
    });
  } catch (error) {
    logger.error('Update column error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la colonne' });
  }
});

// Delete column
router.delete('/:columnId', authenticate, async (req, res) => {
  try {
    const { columnId } = req.params;

    // Check access
    const columnResult = await db.query(
      `SELECT c.*, b.workspace_id
       FROM columns c
       JOIN boards b ON b.id = c.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE c.id = $1 AND wm.user_id = $2`,
      [columnId, req.userId]
    );

    if (columnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Colonne non trouvée ou accès non autorisé' });
    }

    const column = columnResult.rows[0];

    await db.query('DELETE FROM columns WHERE id = $1', [columnId]);

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${column.board_id}`).emit('column:deleted', {
      columnId,
      boardId: column.board_id,
    });

    res.json({ message: 'Colonne supprimée avec succès' });
  } catch (error) {
    logger.error('Delete column error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la colonne' });
  }
});

// Reorder columns
router.put('/reorder', authenticate, async (req, res) => {
  try {
    const { boardId, columns } = req.body; // Array of { id, position }

    // Check access
    const boardAccess = await db.query(
      `SELECT b.id
       FROM boards b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2`,
      [boardId, req.userId]
    );

    if (boardAccess.rows.length === 0) {
      return res.status(403).json({ error: 'Accès au board non autorisé' });
    }

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      for (const col of columns) {
        await client.query(
          'UPDATE columns SET position = $1 WHERE id = $2 AND board_id = $3',
          [col.position, col.id, boardId]
        );
      }

      await client.query('COMMIT');

      // Emit socket event
      const io = req.app.get('io');
      io.to(`board:${boardId}`).emit('columns:reordered', { columns });

      res.json({ message: 'Colonnes réordonnées avec succès' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Reorder columns error:', error);
    res.status(500).json({ error: 'Erreur lors du réordonnancement des colonnes' });
  }
});

// Add status label
router.post('/:columnId/labels', authenticate, [
  body('label').trim().notEmpty().withMessage('Label requis'),
  body('color').matches(/^#[0-9a-fA-F]{6}$/).withMessage('Couleur invalide'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { columnId } = req.params;
    const { label, color } = req.body;

    // Check access and column type
    const columnResult = await db.query(
      `SELECT c.*, ct.name as type_name
       FROM columns c
       JOIN column_types ct ON ct.id = c.column_type_id
       JOIN boards b ON b.id = c.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE c.id = $1 AND wm.user_id = $2`,
      [columnId, req.userId]
    );

    if (columnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Colonne non trouvée ou accès non autorisé' });
    }

    if (columnResult.rows[0].type_name !== 'status') {
      return res.status(400).json({ error: 'Cette colonne n\'accepte pas de labels' });
    }

    // Get max position
    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM status_labels WHERE column_id = $1',
      [columnId]
    );

    const result = await db.query(
      `INSERT INTO status_labels (column_id, label, color, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [columnId, label, color, posResult.rows[0].next_pos]
    );

    const newLabel = result.rows[0];

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${columnResult.rows[0].board_id}`).emit('label:created', {
      columnId,
      label: {
        id: newLabel.id,
        label: newLabel.label,
        color: newLabel.color,
      }
    });

    res.status(201).json({
      id: newLabel.id,
      label: newLabel.label,
      color: newLabel.color,
    });
  } catch (error) {
    logger.error('Add status label error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'ajout du label' });
  }
});

// Update status label
router.put('/:columnId/labels/:labelId', authenticate, async (req, res) => {
  try {
    const { columnId, labelId } = req.params;
    const { label, color } = req.body;

    // Check access
    const columnResult = await db.query(
      `SELECT c.board_id
       FROM columns c
       JOIN boards b ON b.id = c.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE c.id = $1 AND wm.user_id = $2`,
      [columnId, req.userId]
    );

    if (columnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Colonne non trouvée ou accès non autorisé' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (label !== undefined) {
      updates.push(`label = $${paramCount++}`);
      values.push(label);
    }
    if (color !== undefined) {
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(labelId);

    const result = await db.query(
      `UPDATE status_labels SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Label non trouvé' });
    }

    const updatedLabel = result.rows[0];

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${columnResult.rows[0].board_id}`).emit('label:updated', {
      columnId,
      label: {
        id: updatedLabel.id,
        label: updatedLabel.label,
        color: updatedLabel.color,
      }
    });

    res.json({
      id: updatedLabel.id,
      label: updatedLabel.label,
      color: updatedLabel.color,
    });
  } catch (error) {
    logger.error('Update status label error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du label' });
  }
});

// Delete status label
router.delete('/:columnId/labels/:labelId', authenticate, async (req, res) => {
  try {
    const { columnId, labelId } = req.params;

    // Check access
    const columnResult = await db.query(
      `SELECT c.board_id
       FROM columns c
       JOIN boards b ON b.id = c.board_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE c.id = $1 AND wm.user_id = $2`,
      [columnId, req.userId]
    );

    if (columnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Colonne non trouvée ou accès non autorisé' });
    }

    await db.query('DELETE FROM status_labels WHERE id = $1', [labelId]);

    // Emit socket event
    const io = req.app.get('io');
    io.to(`board:${columnResult.rows[0].board_id}`).emit('label:deleted', {
      columnId,
      labelId,
    });

    res.json({ message: 'Label supprimé avec succès' });
  } catch (error) {
    logger.error('Delete status label error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression du label' });
  }
});

module.exports = router;
