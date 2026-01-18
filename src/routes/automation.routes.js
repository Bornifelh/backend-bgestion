const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Automation triggers
const TRIGGERS = {
  'status_changed': { name: 'Quand le statut change', params: ['fromStatus', 'toStatus'] },
  'item_created': { name: 'Quand un item est créé', params: [] },
  'date_arrived': { name: 'Quand la date arrive', params: ['dateColumn', 'daysBefore'] },
  'column_changed': { name: 'Quand une colonne change', params: ['columnId', 'value'] },
  'person_assigned': { name: 'Quand une personne est assignée', params: [] },
};

// Automation actions
const ACTIONS = {
  'change_status': { name: 'Changer le statut', params: ['newStatus'] },
  'assign_person': { name: 'Assigner une personne', params: ['userId'] },
  'notify_person': { name: 'Notifier une personne', params: ['userId', 'message'] },
  'notify_owner': { name: 'Notifier le créateur', params: ['message'] },
  'set_date': { name: 'Définir une date', params: ['columnId', 'daysFromNow'] },
  'move_to_group': { name: 'Déplacer vers un groupe', params: ['groupId'] },
  'create_item': { name: 'Créer un item', params: ['name', 'groupId'] },
  'send_email': { name: 'Envoyer un email', params: ['to', 'subject', 'body'] },
};

// Get automation templates
router.get('/templates', authenticate, (req, res) => {
  const templates = [
    {
      id: 'status_notify',
      name: 'Notifier quand le statut change',
      description: 'Envoie une notification quand un item passe à un certain statut',
      trigger: 'status_changed',
      action: 'notify_owner',
      icon: '🔔',
    },
    {
      id: 'auto_assign',
      name: 'Auto-assignation par statut',
      description: 'Assigne automatiquement une personne quand le statut change',
      trigger: 'status_changed',
      action: 'assign_person',
      icon: '👤',
    },
    {
      id: 'deadline_reminder',
      name: 'Rappel avant échéance',
      description: 'Notifie X jours avant la date limite',
      trigger: 'date_arrived',
      action: 'notify_owner',
      icon: '⏰',
    },
    {
      id: 'auto_move_completed',
      name: 'Déplacer les items terminés',
      description: 'Déplace automatiquement les items terminés dans un groupe',
      trigger: 'status_changed',
      action: 'move_to_group',
      icon: '📁',
    },
    {
      id: 'welcome_item',
      name: 'Item de bienvenue',
      description: 'Crée un item quand un nouveau est ajouté',
      trigger: 'item_created',
      action: 'create_item',
      icon: '✨',
    },
  ];
  res.json({ triggers: TRIGGERS, actions: ACTIONS, templates });
});

// Get automations for a board
router.get('/board/:boardId', authenticate, async (req, res) => {
  try {
    const { boardId } = req.params;

    const result = await db.query(
      `SELECT a.*, u.first_name, u.last_name
       FROM automations a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.board_id = $1
       ORDER BY a.created_at DESC`,
      [boardId]
    );

    res.json(result.rows.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      trigger: a.trigger_type,
      triggerConfig: a.trigger_config,
      action: a.action_type,
      actionConfig: a.action_config,
      isActive: a.is_active,
      executionCount: a.execution_count,
      lastExecuted: a.last_executed_at,
      createdBy: a.first_name ? `${a.first_name} ${a.last_name}` : null,
      createdAt: a.created_at,
    })));
  } catch (error) {
    logger.error('Get automations error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Create automation
router.post('/', authenticate, async (req, res) => {
  try {
    const { boardId, name, description, trigger, triggerConfig, action, actionConfig } = req.body;

    const result = await db.query(
      `INSERT INTO automations (board_id, name, description, trigger_type, trigger_config, action_type, action_config, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [boardId, name, description, trigger, JSON.stringify(triggerConfig || {}), action, JSON.stringify(actionConfig || {}), req.userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create automation error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update automation
router.put('/:automationId', authenticate, async (req, res) => {
  try {
    const { automationId } = req.params;
    const { name, description, trigger, triggerConfig, action, actionConfig, isActive } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (trigger !== undefined) { updates.push(`trigger_type = $${paramCount++}`); values.push(trigger); }
    if (triggerConfig !== undefined) { updates.push(`trigger_config = $${paramCount++}`); values.push(JSON.stringify(triggerConfig)); }
    if (action !== undefined) { updates.push(`action_type = $${paramCount++}`); values.push(action); }
    if (actionConfig !== undefined) { updates.push(`action_config = $${paramCount++}`); values.push(JSON.stringify(actionConfig)); }
    if (isActive !== undefined) { updates.push(`is_active = $${paramCount++}`); values.push(isActive); }

    values.push(automationId);

    const result = await db.query(
      `UPDATE automations SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update automation error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Toggle automation active state
router.post('/:automationId/toggle', authenticate, async (req, res) => {
  try {
    const { automationId } = req.params;

    const result = await db.query(
      'UPDATE automations SET is_active = NOT is_active WHERE id = $1 RETURNING *',
      [automationId]
    );

    res.json({ isActive: result.rows[0].is_active });
  } catch (error) {
    logger.error('Toggle automation error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete automation
router.delete('/:automationId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM automations WHERE id = $1', [req.params.automationId]);
    res.json({ message: 'Automation supprimée' });
  } catch (error) {
    logger.error('Delete automation error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Execute automation (internal use, called by triggers)
async function executeAutomation(automation, item, db) {
  try {
    const actionConfig = typeof automation.action_config === 'string' 
      ? JSON.parse(automation.action_config) 
      : automation.action_config;

    switch (automation.action_type) {
      case 'change_status':
        // Find status column and update
        const statusCol = await db.query(
          "SELECT id FROM columns WHERE board_id = $1 AND type = 'status' LIMIT 1",
          [automation.board_id]
        );
        if (statusCol.rows[0]) {
          await db.query(
            `INSERT INTO item_values (item_id, column_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3`,
            [item.id, statusCol.rows[0].id, actionConfig.newStatus]
          );
        }
        break;

      case 'move_to_group':
        await db.query(
          'UPDATE items SET group_id = $1 WHERE id = $2',
          [actionConfig.groupId, item.id]
        );
        break;

      case 'notify_owner':
        await db.query(
          `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
           VALUES ($1, 'automation', 'Automation déclenchée', $2, 'item', $3)`,
          [item.created_by, actionConfig.message || `L'item "${item.name}" a déclenché une automation`, item.id]
        );
        break;

      case 'assign_person':
        const personCol = await db.query(
          "SELECT id FROM columns WHERE board_id = $1 AND type = 'person' LIMIT 1",
          [automation.board_id]
        );
        if (personCol.rows[0]) {
          await db.query(
            `INSERT INTO item_values (item_id, column_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3`,
            [item.id, personCol.rows[0].id, JSON.stringify({ userIds: [actionConfig.userId] })]
          );
        }
        break;

      case 'create_item':
        await db.query(
          `INSERT INTO items (board_id, group_id, name, created_by)
           VALUES ($1, $2, $3, $4)`,
          [automation.board_id, actionConfig.groupId || item.group_id, actionConfig.name, item.created_by]
        );
        break;
    }

    // Update execution count
    await db.query(
      'UPDATE automations SET execution_count = execution_count + 1, last_executed_at = NOW() WHERE id = $1',
      [automation.id]
    );

    logger.info(`Automation ${automation.id} executed for item ${item.id}`);
    return true;
  } catch (error) {
    logger.error(`Automation execution error (${automation.id}):`, error);
    return false;
  }
}

// Check and trigger automations for an item event
router.post('/trigger', authenticate, async (req, res) => {
  try {
    const { boardId, itemId, event, data } = req.body;

    // Get active automations for this board and event
    const automations = await db.query(
      `SELECT * FROM automations WHERE board_id = $1 AND trigger_type = $2 AND is_active = true`,
      [boardId, event]
    );

    // Get item details
    const itemResult = await db.query('SELECT * FROM items WHERE id = $1', [itemId]);
    const item = itemResult.rows[0];

    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const results = [];

    for (const automation of automations.rows) {
      const triggerConfig = typeof automation.trigger_config === 'string'
        ? JSON.parse(automation.trigger_config)
        : automation.trigger_config;

      let shouldExecute = false;

      // Check trigger conditions
      switch (event) {
        case 'status_changed':
          if (!triggerConfig.toStatus || triggerConfig.toStatus === data.newStatus) {
            if (!triggerConfig.fromStatus || triggerConfig.fromStatus === data.oldStatus) {
              shouldExecute = true;
            }
          }
          break;

        case 'item_created':
          shouldExecute = true;
          break;

        case 'person_assigned':
          shouldExecute = true;
          break;

        case 'column_changed':
          if (triggerConfig.columnId === data.columnId) {
            shouldExecute = true;
          }
          break;
      }

      if (shouldExecute) {
        const success = await executeAutomation(automation, item, db);
        results.push({ automationId: automation.id, success });
      }
    }

    res.json({ triggered: results.length, results });
  } catch (error) {
    logger.error('Trigger automations error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get automation history/logs
router.get('/:automationId/logs', authenticate, async (req, res) => {
  try {
    const { automationId } = req.params;

    // For now, return basic info from the automation itself
    const result = await db.query(
      'SELECT execution_count, last_executed_at FROM automations WHERE id = $1',
      [automationId]
    );

    res.json({
      executionCount: result.rows[0]?.execution_count || 0,
      lastExecuted: result.rows[0]?.last_executed_at,
    });
  } catch (error) {
    logger.error('Get automation logs error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

module.exports = router;
