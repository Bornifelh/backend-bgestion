const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get notifications
router.get('/', authenticate, async (req, res) => {
  try {
    const { limit = 50, offset = 0, unreadOnly = false } = req.query;

    let query = `
      SELECT * FROM notifications
      WHERE user_id = $1
    `;
    const params = [req.userId];

    if (unreadOnly === 'true') {
      query += ` AND is_read = false`;
    }

    query += ` ORDER BY created_at DESC LIMIT $2 OFFSET $3`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get unread count
    const countResult = await db.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.userId]
    );

    res.json({
      notifications: result.rows.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        data: n.data,
        isRead: n.is_read,
        createdAt: n.created_at,
      })),
      unreadCount: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    logger.error('Get notifications error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des notifications' });
  }
});

// Mark notification as read
router.put('/:notificationId/read', authenticate, async (req, res) => {
  try {
    const { notificationId } = req.params;

    await db.query(
      `UPDATE notifications SET is_read = true
       WHERE id = $1 AND user_id = $2`,
      [notificationId, req.userId]
    );

    res.json({ message: 'Notification marquée comme lue' });
  } catch (error) {
    logger.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la notification' });
  }
});

// Mark all notifications as read
router.put('/read-all', authenticate, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
      [req.userId]
    );

    res.json({ message: 'Toutes les notifications marquées comme lues' });
  } catch (error) {
    logger.error('Mark all notifications read error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour des notifications' });
  }
});

// Delete notification
router.delete('/:notificationId', authenticate, async (req, res) => {
  try {
    const { notificationId } = req.params;

    await db.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [notificationId, req.userId]
    );

    res.json({ message: 'Notification supprimée' });
  } catch (error) {
    logger.error('Delete notification error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la notification' });
  }
});

// Delete all read notifications
router.delete('/', authenticate, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM notifications WHERE user_id = $1 AND is_read = true',
      [req.userId]
    );

    res.json({ message: 'Notifications lues supprimées' });
  } catch (error) {
    logger.error('Delete read notifications error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression des notifications' });
  }
});

module.exports = router;
