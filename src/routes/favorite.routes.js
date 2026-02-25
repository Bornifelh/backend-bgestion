const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get my favorites
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT f.*,
        CASE 
          WHEN f.entity_type = 'workspace' THEN w.name
          WHEN f.entity_type = 'board' THEN b.name
          ELSE NULL
        END as entity_name,
        CASE 
          WHEN f.entity_type = 'workspace' THEN w.icon
          WHEN f.entity_type = 'board' THEN b.icon
          ELSE NULL
        END as entity_icon,
        CASE 
          WHEN f.entity_type = 'workspace' THEN w.color
          WHEN f.entity_type = 'board' THEN b.color
          ELSE NULL
        END as entity_color,
        CASE 
          WHEN f.entity_type = 'board' THEN b.workspace_id
          ELSE NULL
        END as workspace_id
      FROM favorites f
      LEFT JOIN workspaces w ON f.entity_type = 'workspace' AND f.entity_id = w.id
      LEFT JOIN boards b ON f.entity_type = 'board' AND f.entity_id = b.id
      WHERE f.user_id = $1
      ORDER BY f.position ASC, f.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get favorites error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Add favorite
router.post('/', authenticate, async (req, res) => {
  try {
    const { entityType, entityId } = req.body;

    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'entityType et entityId requis' });
    }

    if (!['workspace', 'board', 'item'].includes(entityType)) {
      return res.status(400).json({ error: 'entityType invalide' });
    }

    const { rows } = await db.query(
      `INSERT INTO favorites (user_id, entity_type, entity_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING
      RETURNING *`,
      [req.userId, entityType, entityId]
    );

    if (rows.length === 0) {
      return res.json({ message: 'Déjà en favori' });
    }

    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Add favorite error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Remove favorite
router.delete('/:entityType/:entityId', authenticate, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM favorites WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3',
      [req.userId, req.params.entityType, req.params.entityId]
    );
    res.json({ message: 'Favori retiré' });
  } catch (error) {
    logger.error('Remove favorite error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Check if entity is favorite
router.get('/check/:entityType/:entityId', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3',
      [req.userId, req.params.entityType, req.params.entityId]
    );
    res.json({ isFavorite: rows.length > 0 });
  } catch (error) {
    logger.error('Check favorite error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
