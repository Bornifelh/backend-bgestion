const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get saved filters for a board
router.get('/board/:boardId', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT sf.*, u.first_name, u.last_name
      FROM saved_filters sf
      LEFT JOIN users u ON sf.user_id = u.id
      WHERE sf.board_id = $1 AND (sf.user_id = $2 OR sf.is_shared = true)
      ORDER BY sf.created_at DESC`,
      [req.params.boardId, req.userId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get saved filters error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create saved filter
router.post('/', authenticate, async (req, res) => {
  try {
    const { boardId, name, filters, sorts, isShared = false } = req.body;

    if (!boardId || !name) {
      return res.status(400).json({ error: 'boardId et name requis' });
    }

    const { rows } = await db.query(
      `INSERT INTO saved_filters (board_id, user_id, name, filters, sorts, is_shared)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [boardId, req.userId, name, JSON.stringify(filters || []), JSON.stringify(sorts || []), isShared]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Create saved filter error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Update saved filter
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { name, filters, sorts, isShared } = req.body;

    const { rows } = await db.query(
      `UPDATE saved_filters 
      SET name = COALESCE($1, name),
        filters = COALESCE($2, filters),
        sorts = COALESCE($3, sorts),
        is_shared = COALESCE($4, is_shared),
        updated_at = NOW()
      WHERE id = $5 AND user_id = $6
      RETURNING *`,
      [name, filters ? JSON.stringify(filters) : null, sorts ? JSON.stringify(sorts) : null, isShared, req.params.id, req.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Filtre non trouvé' });
    }

    res.json(rows[0]);
  } catch (error) {
    logger.error('Update saved filter error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete saved filter
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM saved_filters WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ message: 'Filtre supprimé' });
  } catch (error) {
    logger.error('Delete saved filter error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
