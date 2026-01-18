const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get comments for an item
router.get('/item/:itemId', authenticate, async (req, res) => {
  try {
    const { itemId } = req.params;

    const result = await db.query(
      `SELECT c.*, 
        u.first_name, u.last_name, u.avatar_url,
        (SELECT COUNT(*) FROM comments WHERE parent_id = c.id) as reply_count
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.item_id = $1 AND c.parent_id IS NULL
       ORDER BY c.created_at DESC`,
      [itemId]
    );

    // Get replies for each comment
    const comments = await Promise.all(
      result.rows.map(async (comment) => {
        if (parseInt(comment.reply_count) > 0) {
          const repliesResult = await db.query(
            `SELECT c.*, u.first_name, u.last_name, u.avatar_url
             FROM comments c
             JOIN users u ON u.id = c.user_id
             WHERE c.parent_id = $1
             ORDER BY c.created_at ASC`,
            [comment.id]
          );
          return {
            ...formatComment(comment),
            replies: repliesResult.rows.map(formatComment),
          };
        }
        return { ...formatComment(comment), replies: [] };
      })
    );

    res.json(comments);
  } catch (error) {
    logger.error('Get comments error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des commentaires' });
  }
});

// Create comment
router.post('/', authenticate, [
  body('itemId').isUUID(),
  body('content').trim().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { itemId, content, parentId } = req.body;

    const result = await db.query(
      `INSERT INTO comments (item_id, user_id, content, parent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [itemId, req.userId, content, parentId || null]
    );

    // Get user info
    const userResult = await db.query(
      'SELECT first_name, last_name, avatar_url FROM users WHERE id = $1',
      [req.userId]
    );

    // Log activity
    const itemResult = await db.query(
      'SELECT board_id FROM items WHERE id = $1',
      [itemId]
    );

    if (itemResult.rows[0]) {
      await db.query(
        `INSERT INTO activity_logs (workspace_id, board_id, item_id, user_id, action, entity_type, entity_id, metadata)
         SELECT b.workspace_id, b.id, $1, $2, 'comment_added', 'comment', $3, $4
         FROM boards b WHERE b.id = $5`,
        [itemId, req.userId, result.rows[0].id, JSON.stringify({ content: content.substring(0, 100) }), itemResult.rows[0].board_id]
      );
    }

    res.status(201).json({
      ...formatComment(result.rows[0]),
      firstName: userResult.rows[0].first_name,
      lastName: userResult.rows[0].last_name,
      avatarUrl: userResult.rows[0].avatar_url,
      replies: [],
    });
  } catch (error) {
    logger.error('Create comment error:', error);
    res.status(500).json({ error: 'Erreur lors de la création du commentaire' });
  }
});

// Update comment
router.put('/:commentId', authenticate, [
  body('content').trim().notEmpty(),
], async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;

    const result = await db.query(
      `UPDATE comments SET content = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [content, commentId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Commentaire non trouvé ou non autorisé' });
    }

    res.json(formatComment(result.rows[0]));
  } catch (error) {
    logger.error('Update comment error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// Delete comment
router.delete('/:commentId', authenticate, async (req, res) => {
  try {
    const { commentId } = req.params;

    const result = await db.query(
      'DELETE FROM comments WHERE id = $1 AND user_id = $2 RETURNING id',
      [commentId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Commentaire non trouvé ou non autorisé' });
    }

    res.json({ message: 'Commentaire supprimé' });
  } catch (error) {
    logger.error('Delete comment error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

function formatComment(c) {
  return {
    id: c.id,
    itemId: c.item_id,
    userId: c.user_id,
    content: c.content,
    parentId: c.parent_id,
    firstName: c.first_name,
    lastName: c.last_name,
    avatarUrl: c.avatar_url,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

module.exports = router;
