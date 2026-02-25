const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get dependencies for an item
router.get('/item/:itemId', authenticate, async (req, res) => {
  try {
    const { rows: blocking } = await db.query(
      `SELECT d.*, i.name as item_name, i.board_id,
        b.name as board_name
      FROM item_dependencies d
      JOIN items i ON d.depends_on_id = i.id
      JOIN boards b ON i.board_id = b.id
      WHERE d.item_id = $1
      ORDER BY d.created_at DESC`,
      [req.params.itemId]
    );

    const { rows: blockedBy } = await db.query(
      `SELECT d.*, i.name as item_name, i.board_id,
        b.name as board_name
      FROM item_dependencies d
      JOIN items i ON d.item_id = i.id
      JOIN boards b ON i.board_id = b.id
      WHERE d.depends_on_id = $1
      ORDER BY d.created_at DESC`,
      [req.params.itemId]
    );

    res.json({ blocking, blockedBy });
  } catch (error) {
    logger.error('Get dependencies error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create dependency
router.post('/', authenticate, async (req, res) => {
  try {
    const { itemId, dependsOnId, dependencyType = 'finish_to_start' } = req.body;

    if (!itemId || !dependsOnId) {
      return res.status(400).json({ error: 'itemId et dependsOnId requis' });
    }

    if (itemId === dependsOnId) {
      return res.status(400).json({ error: 'Un item ne peut pas dépendre de lui-même' });
    }

    // Check for circular dependency
    const hasCircular = await checkCircularDependency(itemId, dependsOnId);
    if (hasCircular) {
      return res.status(400).json({ error: 'Dépendance circulaire détectée' });
    }

    const { rows } = await db.query(
      `INSERT INTO item_dependencies (item_id, depends_on_id, dependency_type)
      VALUES ($1, $2, $3)
      ON CONFLICT (item_id, depends_on_id) DO NOTHING
      RETURNING *`,
      [itemId, dependsOnId, dependencyType]
    );

    if (rows.length === 0) {
      return res.status(409).json({ error: 'Cette dépendance existe déjà' });
    }

    // Get full dependency info
    const { rows: full } = await db.query(
      `SELECT d.*, i.name as item_name, b.name as board_name
      FROM item_dependencies d
      JOIN items i ON d.depends_on_id = i.id
      JOIN boards b ON i.board_id = b.id
      WHERE d.id = $1`,
      [rows[0].id]
    );

    res.status(201).json(full[0]);
  } catch (error) {
    logger.error('Create dependency error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Delete dependency
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM item_dependencies WHERE id = $1', [req.params.id]);
    res.json({ message: 'Dépendance supprimée' });
  } catch (error) {
    logger.error('Delete dependency error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get dependencies for a board (for timeline view)
router.get('/board/:boardId', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*
      FROM item_dependencies d
      JOIN items i1 ON d.item_id = i1.id
      JOIN items i2 ON d.depends_on_id = i2.id
      WHERE i1.board_id = $1 OR i2.board_id = $1`,
      [req.params.boardId]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Get board dependencies error:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

async function checkCircularDependency(itemId, dependsOnId) {
  const visited = new Set();
  const stack = [dependsOnId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === itemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const { rows } = await db.query(
      'SELECT depends_on_id FROM item_dependencies WHERE item_id = $1',
      [current]
    );
    rows.forEach(r => stack.push(r.depends_on_id));
  }
  return false;
}

module.exports = router;
