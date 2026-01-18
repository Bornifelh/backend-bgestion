const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate, checkWorkspaceAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Ticket categories
const TICKET_CATEGORIES = [
  { id: 'hardware', name: 'Matériel', icon: '🖥️' },
  { id: 'software', name: 'Logiciel', icon: '💿' },
  { id: 'network', name: 'Réseau', icon: '🌐' },
  { id: 'security', name: 'Sécurité', icon: '🔒' },
  { id: 'access', name: 'Accès/Droits', icon: '🔑' },
  { id: 'printer', name: 'Imprimante', icon: '🖨️' },
  { id: 'email', name: 'Messagerie', icon: '📧' },
  { id: 'phone', name: 'Téléphonie', icon: '📞' },
  { id: 'training', name: 'Formation', icon: '📚' },
  { id: 'general', name: 'Général', icon: '📋' },
];

// Get ticket categories
router.get('/categories', authenticate, (req, res) => {
  res.json(TICKET_CATEGORIES);
});

// ==========================================
// USER ROUTES (Ticket submission)
// ==========================================

// Get my tickets (submitted by current user)
router.get('/my', authenticate, async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;

    let query = `
      SELECT t.*, 
        w.name as workspace_name,
        u_assigned.first_name as assigned_first_name,
        u_assigned.last_name as assigned_last_name,
        b.name as board_name
      FROM tickets t
      LEFT JOIN workspaces w ON w.id = t.workspace_id
      LEFT JOIN users u_assigned ON u_assigned.id = t.assigned_to
      LEFT JOIN boards b ON b.id = t.assigned_board_id
      WHERE t.submitted_by = $1
    `;
    const params = [req.userId];
    let paramCount = 2;

    if (status) {
      query += ` AND t.status = $${paramCount++}`;
      params.push(status);
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json(result.rows.map(formatTicket));
  } catch (error) {
    logger.error('Get my tickets error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Submit a new ticket (any user)
router.post('/', authenticate, [
  body('workspaceId').isUUID().withMessage('Workspace ID requis'),
  body('title').trim().notEmpty().withMessage('Titre requis'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      workspaceId, title, description, category, priority, urgency,
      location, equipment, requestedDate, attachments
    } = req.body;

    // Check user is member of workspace
    const memberCheck = await db.query(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Non membre de ce workspace' });
    }

    const result = await db.query(
      `INSERT INTO tickets (
        workspace_id, title, description, category, priority, urgency,
        location, equipment, requested_date, attachments, submitted_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        workspaceId, title, description || null, category || 'general',
        priority || 'medium', urgency || 'normal', location || null,
        equipment || null, requestedDate || null,
        JSON.stringify(attachments || []), req.userId
      ]
    );

    const ticket = result.rows[0];
    logger.info(`Ticket ${ticket.ticket_number} created by user ${req.userId}`);

    // Notify admins via socket
    const io = req.app.get('io');
    io.to(`workspace:${workspaceId}:admins`).emit('ticket:new', formatTicket(ticket));

    res.status(201).json(formatTicket(ticket));
  } catch (error) {
    logger.error('Create ticket error:', error);
    res.status(500).json({ error: 'Erreur lors de la création du ticket' });
  }
});

// Get single ticket (for owner or admin)
router.get('/:ticketId', authenticate, async (req, res) => {
  try {
    const { ticketId } = req.params;

    const result = await db.query(
      `SELECT t.*, 
        w.name as workspace_name,
        u_sub.first_name as submitter_first_name,
        u_sub.last_name as submitter_last_name,
        u_sub.email as submitter_email,
        u_assigned.first_name as assigned_first_name,
        u_assigned.last_name as assigned_last_name,
        u_assigner.first_name as assigner_first_name,
        u_assigner.last_name as assigner_last_name,
        u_resolver.first_name as resolver_first_name,
        u_resolver.last_name as resolver_last_name,
        b.name as board_name,
        i.name as item_name
      FROM tickets t
      LEFT JOIN workspaces w ON w.id = t.workspace_id
      LEFT JOIN users u_sub ON u_sub.id = t.submitted_by
      LEFT JOIN users u_assigned ON u_assigned.id = t.assigned_to
      LEFT JOIN users u_assigner ON u_assigner.id = t.assigned_by
      LEFT JOIN users u_resolver ON u_resolver.id = t.resolved_by
      LEFT JOIN boards b ON b.id = t.assigned_board_id
      LEFT JOIN items i ON i.id = t.assigned_item_id
      WHERE t.id = $1`,
      [ticketId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket non trouvé' });
    }

    const ticket = result.rows[0];

    // Check permission: owner or workspace admin
    const isOwner = ticket.submitted_by === req.userId;
    const adminCheck = await db.query(
      `SELECT role FROM workspace_members 
       WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')`,
      [ticket.workspace_id, req.userId]
    );

    if (!isOwner && adminCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    res.json(formatTicketDetails(ticket));
  } catch (error) {
    logger.error('Get ticket error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update own ticket (before assignment)
router.put('/:ticketId', authenticate, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { title, description, category, priority, urgency, location, equipment, requestedDate } = req.body;

    // Check ownership and status
    const ticketCheck = await db.query(
      'SELECT * FROM tickets WHERE id = $1 AND submitted_by = $2',
      [ticketId, req.userId]
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    if (ticketCheck.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Impossible de modifier un ticket déjà traité' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) { updates.push(`title = $${paramCount++}`); values.push(title); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (category !== undefined) { updates.push(`category = $${paramCount++}`); values.push(category); }
    if (priority !== undefined) { updates.push(`priority = $${paramCount++}`); values.push(priority); }
    if (urgency !== undefined) { updates.push(`urgency = $${paramCount++}`); values.push(urgency); }
    if (location !== undefined) { updates.push(`location = $${paramCount++}`); values.push(location); }
    if (equipment !== undefined) { updates.push(`equipment = $${paramCount++}`); values.push(equipment); }
    if (requestedDate !== undefined) { updates.push(`requested_date = $${paramCount++}`); values.push(requestedDate); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(ticketId);

    const result = await db.query(
      `UPDATE tickets SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(formatTicket(result.rows[0]));
  } catch (error) {
    logger.error('Update ticket error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Cancel own ticket
router.delete('/:ticketId', authenticate, async (req, res) => {
  try {
    const { ticketId } = req.params;

    const ticketCheck = await db.query(
      'SELECT * FROM tickets WHERE id = $1 AND submitted_by = $2 AND status = $3',
      [ticketId, req.userId, 'pending']
    );

    if (ticketCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Impossible d\'annuler ce ticket' });
    }

    await db.query(
      'UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2',
      ['cancelled', ticketId]
    );

    res.json({ message: 'Ticket annulé' });
  } catch (error) {
    logger.error('Cancel ticket error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// ADMIN ROUTES (Ticket management)
// ==========================================

// Get all tickets for workspace (admin only)
router.get('/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { status, category, priority, assignedTo, limit = 100 } = req.query;

    // Check admin access
    const adminCheck = await db.query(
      `SELECT role FROM workspace_members 
       WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')`,
      [workspaceId, req.userId]
    );

    if (adminCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    let query = `
      SELECT t.*, 
        u_sub.first_name as submitter_first_name,
        u_sub.last_name as submitter_last_name,
        u_sub.email as submitter_email,
        u_assigned.first_name as assigned_first_name,
        u_assigned.last_name as assigned_last_name,
        b.name as board_name
      FROM tickets t
      LEFT JOIN users u_sub ON u_sub.id = t.submitted_by
      LEFT JOIN users u_assigned ON u_assigned.id = t.assigned_to
      LEFT JOIN boards b ON b.id = t.assigned_board_id
      WHERE t.workspace_id = $1
    `;
    const params = [workspaceId];
    let paramCount = 2;

    if (status) {
      query += ` AND t.status = $${paramCount++}`;
      params.push(status);
    }
    if (category) {
      query += ` AND t.category = $${paramCount++}`;
      params.push(category);
    }
    if (priority) {
      query += ` AND t.priority = $${paramCount++}`;
      params.push(priority);
    }
    if (assignedTo) {
      query += ` AND t.assigned_to = $${paramCount++}`;
      params.push(assignedTo);
    }

    query += ` ORDER BY 
      CASE t.urgency WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
      CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      t.created_at DESC
      LIMIT $${paramCount}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json(result.rows.map(formatTicketAdmin));
  } catch (error) {
    logger.error('Get workspace tickets error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get ticket statistics for workspace (admin)
router.get('/workspace/:workspaceId/stats', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const stats = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
        COUNT(*) FILTER (WHERE status = 'closed') as closed,
        COUNT(*) FILTER (WHERE urgency = 'critical') as critical,
        COUNT(*) FILTER (WHERE urgency = 'high') as high_urgency,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_week
      FROM tickets WHERE workspace_id = $1
    `, [workspaceId]);

    const byCategory = await db.query(`
      SELECT category, COUNT(*) as count
      FROM tickets WHERE workspace_id = $1
      GROUP BY category ORDER BY count DESC
    `, [workspaceId]);

    res.json({
      ...stats.rows[0],
      byCategory: byCategory.rows,
    });
  } catch (error) {
    logger.error('Get ticket stats error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Assign ticket to board/member (admin only)
router.put('/:ticketId/assign', authenticate, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { boardId, assignedTo, dueDate, createItem } = req.body;

    // Get ticket
    const ticketResult = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket non trouvé' });
    }
    const ticket = ticketResult.rows[0];

    // Check admin access
    const adminCheck = await db.query(
      `SELECT role FROM workspace_members 
       WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')`,
      [ticket.workspace_id, req.userId]
    );

    if (adminCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    let assignedItemId = null;

    // Create item in board if requested
    if (createItem && boardId) {
      // Get first group of the board
      const groupResult = await db.query(
        'SELECT id FROM groups WHERE board_id = $1 ORDER BY position LIMIT 1',
        [boardId]
      );

      if (groupResult.rows.length > 0) {
        const itemResult = await db.query(
          `INSERT INTO items (board_id, group_id, name, created_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [boardId, groupResult.rows[0].id, `[${ticket.ticket_number}] ${ticket.title}`, req.userId]
        );
        assignedItemId = itemResult.rows[0].id;

        // Set status column if exists - find the "En cours" or second label
        const statusCol = await db.query(`
          SELECT c.id, sl.id as label_id FROM columns c
          JOIN column_types ct ON ct.id = c.column_type_id
          LEFT JOIN status_labels sl ON sl.column_id = c.id
          WHERE c.board_id = $1 AND ct.name = 'status'
          ORDER BY sl.position ASC
        `, [boardId]);

        if (statusCol.rows.length > 0) {
          // Use the second label (usually "En cours") or first if only one exists
          const statusLabelId = statusCol.rows[1]?.label_id || statusCol.rows[0]?.label_id;
          if (statusLabelId) {
            await db.query(
              `INSERT INTO item_values (item_id, column_id, value) VALUES ($1, $2, $3)
               ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3`,
              [assignedItemId, statusCol.rows[0].id, JSON.stringify(statusLabelId)]
            );
          }
        }

        // Set person column if assignedTo
        if (assignedTo) {
          const personCol = await db.query(`
            SELECT c.id FROM columns c
            JOIN column_types ct ON ct.id = c.column_type_id
            WHERE c.board_id = $1 AND ct.name = 'person' LIMIT 1
          `, [boardId]);

          if (personCol.rows.length > 0) {
            // Store as array of UUIDs (not double-serialized)
            await db.query(
              `INSERT INTO item_values (item_id, column_id, value) VALUES ($1, $2, $3::jsonb)
               ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3::jsonb`,
              [assignedItemId, personCol.rows[0].id, JSON.stringify([assignedTo])]
            );
          }
        }

        // Set date column if dueDate
        if (dueDate) {
          const dateCol = await db.query(`
            SELECT c.id FROM columns c
            JOIN column_types ct ON ct.id = c.column_type_id
            WHERE c.board_id = $1 AND ct.name = 'date' LIMIT 1
          `, [boardId]);

          if (dateCol.rows.length > 0) {
            // Store date as string directly
            await db.query(
              `INSERT INTO item_values (item_id, column_id, value) VALUES ($1, $2, $3::jsonb)
               ON CONFLICT (item_id, column_id) DO UPDATE SET value = $3::jsonb`,
              [assignedItemId, dateCol.rows[0].id, JSON.stringify(dueDate)]
            );
          }
        }
      }
    }

    // Update ticket
    const result = await db.query(
      `UPDATE tickets SET 
        assigned_board_id = $1,
        assigned_item_id = $2,
        assigned_to = $3,
        assigned_by = $4,
        assigned_at = NOW(),
        due_date = $5,
        status = 'assigned',
        updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [boardId || null, assignedItemId, assignedTo || null, req.userId, dueDate || null, ticketId]
    );

    // Notify user
    const io = req.app.get('io');
    io.to(`user:${ticket.submitted_by}`).emit('ticket:assigned', {
      ticketId,
      ticketNumber: ticket.ticket_number,
    });

    logger.info(`Ticket ${ticket.ticket_number} assigned by admin ${req.userId}`);

    res.json(formatTicket(result.rows[0]));
  } catch (error) {
    logger.error('Assign ticket error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'assignation' });
  }
});

// Update ticket status (admin)
router.put('/:ticketId/status', authenticate, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status, resolutionNotes } = req.body;

    // Get ticket
    const ticketResult = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket non trouvé' });
    }
    const ticket = ticketResult.rows[0];

    // Check admin or assigned user
    const adminCheck = await db.query(
      `SELECT role FROM workspace_members 
       WHERE workspace_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')`,
      [ticket.workspace_id, req.userId]
    );
    const isAssigned = ticket.assigned_to === req.userId;

    if (adminCheck.rows.length === 0 && !isAssigned) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    const updates = ['status = $1', 'updated_at = NOW()'];
    const values = [status];
    let paramCount = 2;

    if (status === 'resolved' || status === 'closed') {
      updates.push(`resolved_at = NOW()`);
      updates.push(`resolved_by = $${paramCount++}`);
      values.push(req.userId);
    }

    if (resolutionNotes) {
      updates.push(`resolution_notes = $${paramCount++}`);
      values.push(resolutionNotes);
    }

    values.push(ticketId);

    const result = await db.query(
      `UPDATE tickets SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    // Notify submitter
    const io = req.app.get('io');
    io.to(`user:${ticket.submitted_by}`).emit('ticket:updated', {
      ticketId,
      ticketNumber: ticket.ticket_number,
      status,
    });

    res.json(formatTicket(result.rows[0]));
  } catch (error) {
    logger.error('Update ticket status error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Helper functions
function formatTicket(t) {
  return {
    id: t.id,
    ticketNumber: t.ticket_number,
    workspaceId: t.workspace_id,
    workspaceName: t.workspace_name,
    title: t.title,
    description: t.description,
    category: t.category,
    priority: t.priority,
    urgency: t.urgency,
    status: t.status,
    location: t.location,
    equipment: t.equipment,
    requestedDate: t.requested_date,
    dueDate: t.due_date,
    assignedTo: t.assigned_to,
    assignedToName: t.assigned_first_name ? `${t.assigned_first_name} ${t.assigned_last_name}` : null,
    assignedBoardId: t.assigned_board_id,
    boardName: t.board_name,
    attachments: t.attachments || [],
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function formatTicketAdmin(t) {
  return {
    ...formatTicket(t),
    submitterName: t.submitter_first_name ? `${t.submitter_first_name} ${t.submitter_last_name}` : null,
    submitterEmail: t.submitter_email,
    submittedBy: t.submitted_by,
  };
}

function formatTicketDetails(t) {
  return {
    ...formatTicketAdmin(t),
    assignedBy: t.assigned_by,
    assignerName: t.assigner_first_name ? `${t.assigner_first_name} ${t.assigner_last_name}` : null,
    assignedAt: t.assigned_at,
    assignedItemId: t.assigned_item_id,
    itemName: t.item_name,
    resolutionNotes: t.resolution_notes,
    resolvedAt: t.resolved_at,
    resolvedBy: t.resolved_by,
    resolverName: t.resolver_first_name ? `${t.resolver_first_name} ${t.resolver_last_name}` : null,
  };
}

module.exports = router;
