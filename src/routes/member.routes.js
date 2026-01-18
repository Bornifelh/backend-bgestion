const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { authenticate, checkWorkspaceAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');
const { sendEmail } = require('../services/email.service');

// Generate random password
const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 10; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

// Get workspace members with details
router.get('/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.last_login,
              wm.role, wm.joined_at,
              inv.first_name as inviter_first_name, inv.last_name as inviter_last_name,
              (SELECT COUNT(*) FROM items WHERE created_by = u.id AND board_id IN 
                (SELECT id FROM boards WHERE workspace_id = $1)) as items_created,
              (SELECT COUNT(*) FROM comments WHERE user_id = u.id AND item_id IN 
                (SELECT id FROM items WHERE board_id IN 
                  (SELECT id FROM boards WHERE workspace_id = $1))) as comments_count
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       LEFT JOIN users inv ON inv.id = wm.invited_by
       WHERE wm.workspace_id = $1
       ORDER BY 
         CASE wm.role 
           WHEN 'owner' THEN 1 
           WHEN 'admin' THEN 2 
           WHEN 'member' THEN 3 
           WHEN 'viewer' THEN 4 
         END,
         wm.joined_at ASC`,
      [workspaceId]
    );

    res.json(result.rows.map(m => ({
      id: m.id,
      email: m.email,
      firstName: m.first_name,
      lastName: m.last_name,
      fullName: `${m.first_name} ${m.last_name}`,
      avatarUrl: m.avatar_url,
      role: m.role,
      joinedAt: m.joined_at,
      lastLogin: m.last_login,
      invitedBy: m.inviter_first_name ? `${m.inviter_first_name} ${m.inviter_last_name}` : null,
      stats: {
        itemsCreated: parseInt(m.items_created),
        commentsCount: parseInt(m.comments_count),
      },
    })));
  } catch (error) {
    logger.error('Get members error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des membres' });
  }
});

// Get team evaluation - Performance metrics for all members
router.get('/workspace/:workspaceId/evaluation', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Get all members with their task statistics
    const membersResult = await db.query(
      `SELECT 
        u.id,
        u.email,
        u.first_name,
        u.last_name,
        u.avatar_url,
        wm.role,
        wm.joined_at
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = $1`,
      [workspaceId]
    );

    const members = membersResult.rows;
    const evaluations = [];

    for (const member of members) {
      // Get tasks assigned to this member
      const tasksResult = await db.query(
        `SELECT 
          i.id,
          i.name,
          i.created_at,
          b.name as board_name,
          iv_status.value as status_value,
          iv_progress.value as progress_value,
          iv_deadline.value as deadline_value
         FROM items i
         JOIN boards b ON b.id = i.board_id
         LEFT JOIN item_values iv_person ON iv_person.item_id = i.id 
           AND iv_person.column_id IN (SELECT id FROM columns WHERE board_id = b.id AND column_type_id IN (SELECT id FROM column_types WHERE name = 'person'))
         LEFT JOIN item_values iv_status ON iv_status.item_id = i.id 
           AND iv_status.column_id IN (SELECT id FROM columns WHERE board_id = b.id AND column_type_id IN (SELECT id FROM column_types WHERE name = 'status'))
         LEFT JOIN item_values iv_progress ON iv_progress.item_id = i.id 
           AND iv_progress.column_id IN (SELECT id FROM columns WHERE board_id = b.id AND column_type_id IN (SELECT id FROM column_types WHERE name = 'progress'))
         LEFT JOIN item_values iv_deadline ON iv_deadline.item_id = i.id 
           AND iv_deadline.column_id IN (SELECT id FROM columns WHERE board_id = b.id AND column_type_id IN (SELECT id FROM column_types WHERE name = 'date'))
         WHERE b.workspace_id = $1 
           AND (iv_person.value::jsonb @> $2::jsonb OR iv_person.value::text LIKE $3)`,
        [workspaceId, JSON.stringify([member.id]), `%${member.id}%`]
      );

      const tasks = tasksResult.rows;
      let totalTasks = tasks.length;
      let completedTasks = 0;
      let inProgressTasks = 0;
      let overdueTasks = 0;
      let totalProgress = 0;

      tasks.forEach(task => {
        // Check status
        const statusValue = task.status_value;
        if (statusValue) {
          const status = typeof statusValue === 'string' ? statusValue : JSON.parse(statusValue);
          if (status === 'done' || status === 'completed' || status === 'terminé') {
            completedTasks++;
          } else if (status === 'in_progress' || status === 'en_cours') {
            inProgressTasks++;
          }
        }

        // Check progress
        const progressValue = task.progress_value;
        if (progressValue) {
          const progress = typeof progressValue === 'object' 
            ? progressValue.progress || 0 
            : parseInt(progressValue) || 0;
          totalProgress += progress;
          if (progress >= 100) {
            completedTasks++;
          }
        }

        // Check deadline
        const deadlineValue = task.deadline_value;
        if (deadlineValue) {
          const deadline = new Date(typeof deadlineValue === 'object' ? deadlineValue.date : deadlineValue);
          if (deadline < new Date() && totalProgress < 100) {
            overdueTasks++;
          }
        }
      });

      // Calculate performance score (0-100%)
      let performanceScore = 0;
      if (totalTasks > 0) {
        const completionRate = (completedTasks / totalTasks) * 100;
        const avgProgress = totalProgress / totalTasks;
        const onTimeRate = totalTasks > 0 ? ((totalTasks - overdueTasks) / totalTasks) * 100 : 100;
        
        // Weighted average: completion 40%, progress 30%, on-time 30%
        performanceScore = Math.round((completionRate * 0.4) + (avgProgress * 0.3) + (onTimeRate * 0.3));
      }

      evaluations.push({
        id: member.id,
        email: member.email,
        firstName: member.first_name,
        lastName: member.last_name,
        fullName: `${member.first_name} ${member.last_name}`,
        avatarUrl: member.avatar_url,
        role: member.role,
        joinedAt: member.joined_at,
        metrics: {
          totalTasks,
          completedTasks,
          inProgressTasks,
          overdueTasks,
          averageProgress: totalTasks > 0 ? Math.round(totalProgress / totalTasks) : 0,
          completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
          performanceScore
        }
      });
    }

    // Sort by performance score descending
    evaluations.sort((a, b) => b.metrics.performanceScore - a.metrics.performanceScore);

    // Calculate team averages
    const teamMetrics = {
      totalMembers: evaluations.length,
      avgPerformance: evaluations.length > 0 
        ? Math.round(evaluations.reduce((sum, e) => sum + e.metrics.performanceScore, 0) / evaluations.length)
        : 0,
      totalTasks: evaluations.reduce((sum, e) => sum + e.metrics.totalTasks, 0),
      totalCompleted: evaluations.reduce((sum, e) => sum + e.metrics.completedTasks, 0),
      totalOverdue: evaluations.reduce((sum, e) => sum + e.metrics.overdueTasks, 0),
    };

    res.json({
      teamMetrics,
      members: evaluations
    });
  } catch (error) {
    logger.error('Get evaluation error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de l\'évaluation' });
  }
});

// Get pending invitations
router.get('/workspace/:workspaceId/invitations', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT wi.*, u.first_name as inviter_first_name, u.last_name as inviter_last_name
       FROM workspace_invitations wi
       LEFT JOIN users u ON u.id = wi.invited_by
       WHERE wi.workspace_id = $1 AND wi.accepted_at IS NULL AND wi.expires_at > NOW()
       ORDER BY wi.created_at DESC`,
      [workspaceId]
    );

    res.json(result.rows.map(i => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expires_at,
      invitedBy: i.inviter_first_name ? `${i.inviter_first_name} ${i.inviter_last_name}` : null,
      createdAt: i.created_at,
    })));
  } catch (error) {
    logger.error('Get invitations error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des invitations' });
  }
});

// Send invitation - Creates user with temp password and sends email
router.post('/workspace/:workspaceId/invite', authenticate, checkWorkspaceAccess, [
  body('email').isEmail().withMessage('Email invalide'),
  body('role').optional().isIn(['admin', 'member', 'viewer']).withMessage('Rôle invalide'),
  body('firstName').optional().trim(),
  body('lastName').optional().trim(),
], async (req, res) => {
  try {
    if (!['owner', 'admin'].includes(req.workspaceRole)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId } = req.params;
    const { email, role = 'member', firstName = 'Invité', lastName = '' } = req.body;

    // Get workspace name and inviter info
    const workspaceResult = await db.query(
      'SELECT name FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    const workspaceName = workspaceResult.rows[0]?.name || 'Time Tracker';

    const inviterResult = await db.query(
      'SELECT first_name, last_name FROM users WHERE id = $1',
      [req.userId]
    );
    const inviterName = inviterResult.rows[0] 
      ? `${inviterResult.rows[0].first_name} ${inviterResult.rows[0].last_name}`
      : 'Un administrateur';

    // Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    let userId;
    let tempPassword = null;
    let isNewUser = false;

    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      
      // Check if already member
      const existingMember = await db.query(
        'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId]
      );

      if (existingMember.rows.length > 0) {
        return res.status(400).json({ error: 'Cet utilisateur est déjà membre' });
      }
    } else {
      // Create new user with temp password
      isNewUser = true;
      tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      const userResult = await db.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, must_change_password)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [email, passwordHash, firstName || email.split('@')[0], lastName || '']
      );
      userId = userResult.rows[0].id;
    }

    // Add to workspace
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId, role, req.userId]
    );

    // Create invitation record for tracking
    const token = uuidv4();
    await db.query(
      `INSERT INTO workspace_invitations (workspace_id, email, role, token, invited_by, expires_at, accepted_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days', NOW())`,
      [workspaceId, email, role, token, req.userId]
    );

    // Create notification
    await db.query(
      `INSERT INTO notifications (user_id, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        'workspace_invite',
        'Invitation au workspace',
        `Vous avez été invité à rejoindre ${workspaceName}`,
        JSON.stringify({ workspaceId })
      ]
    );

    // Send email if new user
    if (isNewUser && tempPassword) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      
      try {
        await sendEmail(email, 'invitation', {
          email,
          tempPassword,
          workspaceName,
          inviterName,
          loginUrl: `${frontendUrl}/login`
        });
        logger.info(`Invitation email sent to ${email}`);
      } catch (emailError) {
        logger.error('Failed to send invitation email:', emailError);
        // Don't fail the request, user is still created
      }
    }

    logger.info(`User ${email} invited to workspace ${workspaceId} by ${req.userId}`);

    res.status(201).json({
      id: userId,
      email,
      role,
      status: isNewUser ? 'invited' : 'added',
      message: isNewUser 
        ? 'Invitation envoyée par email avec le mot de passe temporaire'
        : 'Utilisateur ajouté au workspace',
      tempPassword: isNewUser ? tempPassword : undefined // Only return in dev for testing
    });
  } catch (error) {
    logger.error('Send invitation error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'envoi de l\'invitation' });
  }
});

// Resend invitation
router.post('/invitations/:invitationId/resend', authenticate, async (req, res) => {
  try {
    const { invitationId } = req.params;

    // Get invitation and check access
    const invResult = await db.query(
      `SELECT wi.*, wm.role as member_role
       FROM workspace_invitations wi
       JOIN workspace_members wm ON wm.workspace_id = wi.workspace_id
       WHERE wi.id = $1 AND wm.user_id = $2`,
      [invitationId, req.userId]
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation non trouvée' });
    }

    const invitation = invResult.rows[0];

    if (!['owner', 'admin'].includes(invitation.member_role)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    // Update expiration
    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + 7);

    await db.query(
      'UPDATE workspace_invitations SET expires_at = $1 WHERE id = $2',
      [newExpiry, invitationId]
    );

    // TODO: Resend email in production

    res.json({ message: 'Invitation renvoyée', expiresAt: newExpiry });
  } catch (error) {
    logger.error('Resend invitation error:', error);
    res.status(500).json({ error: 'Erreur lors du renvoi de l\'invitation' });
  }
});

// Cancel invitation
router.delete('/invitations/:invitationId', authenticate, async (req, res) => {
  try {
    const { invitationId } = req.params;

    // Get invitation and check access
    const invResult = await db.query(
      `SELECT wi.*, wm.role as member_role
       FROM workspace_invitations wi
       JOIN workspace_members wm ON wm.workspace_id = wi.workspace_id
       WHERE wi.id = $1 AND wm.user_id = $2`,
      [invitationId, req.userId]
    );

    if (invResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation non trouvée' });
    }

    if (!['owner', 'admin'].includes(invResult.rows[0].member_role)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    await db.query('DELETE FROM workspace_invitations WHERE id = $1', [invitationId]);

    res.json({ message: 'Invitation annulée' });
  } catch (error) {
    logger.error('Cancel invitation error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'annulation de l\'invitation' });
  }
});

// Accept invitation (public route for users clicking invite link)
router.post('/invitations/accept/:token', authenticate, async (req, res) => {
  try {
    const { token } = req.params;

    const result = await db.query(
      `SELECT wi.*, w.name as workspace_name
       FROM workspace_invitations wi
       JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.token = $1 AND wi.accepted_at IS NULL AND wi.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation invalide ou expirée' });
    }

    const invitation = result.rows[0];

    // Check if already member
    const memberCheck = await db.query(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [invitation.workspace_id, req.userId]
    );

    if (memberCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Vous êtes déjà membre de ce workspace' });
    }

    // Add member
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, $4)`,
      [invitation.workspace_id, req.userId, invitation.role, invitation.invited_by]
    );

    // Mark as accepted
    await db.query(
      'UPDATE workspace_invitations SET accepted_at = NOW() WHERE id = $1',
      [invitation.id]
    );

    res.json({
      message: 'Invitation acceptée',
      workspaceId: invitation.workspace_id,
      workspaceName: invitation.workspace_name,
    });
  } catch (error) {
    logger.error('Accept invitation error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'acceptation de l\'invitation' });
  }
});

// Update member role
router.put('/workspace/:workspaceId/members/:memberId/role', authenticate, checkWorkspaceAccess, [
  body('role').isIn(['admin', 'member', 'viewer']).withMessage('Rôle invalide'),
], async (req, res) => {
  try {
    if (req.workspaceRole !== 'owner') {
      return res.status(403).json({ error: 'Seul le propriétaire peut modifier les rôles' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId, memberId } = req.params;
    const { role } = req.body;

    // Can't change owner's role
    const workspace = await db.query(
      'SELECT owner_id FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (workspace.rows[0].owner_id === memberId) {
      return res.status(400).json({ error: 'Impossible de modifier le rôle du propriétaire' });
    }

    await db.query(
      'UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3',
      [role, workspaceId, memberId]
    );

    // Emit socket event
    const io = req.app.get('io');
    io.to(`workspace:${workspaceId}`).emit('member:role_updated', { memberId, role });

    res.json({ message: 'Rôle mis à jour' });
  } catch (error) {
    logger.error('Update member role error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du rôle' });
  }
});

// Remove member
router.delete('/workspace/:workspaceId/members/:memberId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId, memberId } = req.params;

    // Check permissions
    if (memberId !== req.userId && !['owner', 'admin'].includes(req.workspaceRole)) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    // Can't remove owner
    const workspace = await db.query(
      'SELECT owner_id FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (workspace.rows[0].owner_id === memberId) {
      return res.status(400).json({ error: 'Le propriétaire ne peut pas être retiré' });
    }

    // Admins can't remove other admins
    if (req.workspaceRole === 'admin' && memberId !== req.userId) {
      const targetMember = await db.query(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, memberId]
      );
      if (targetMember.rows[0]?.role === 'admin') {
        return res.status(403).json({ error: 'Un admin ne peut pas retirer un autre admin' });
      }
    }

    await db.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, memberId]
    );

    // Emit socket event
    const io = req.app.get('io');
    io.to(`workspace:${workspaceId}`).emit('member:removed', { workspaceId, memberId });

    res.json({ message: 'Membre retiré avec succès' });
  } catch (error) {
    logger.error('Remove member error:', error);
    res.status(500).json({ error: 'Erreur lors du retrait du membre' });
  }
});

// Transfer ownership
router.post('/workspace/:workspaceId/transfer-ownership', authenticate, checkWorkspaceAccess, [
  body('newOwnerId').isUUID().withMessage('ID utilisateur invalide'),
], async (req, res) => {
  try {
    if (req.workspaceRole !== 'owner') {
      return res.status(403).json({ error: 'Seul le propriétaire peut transférer la propriété' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId } = req.params;
    const { newOwnerId } = req.body;

    // Check new owner is member
    const memberCheck = await db.query(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, newOwnerId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(400).json({ error: 'L\'utilisateur doit être membre du workspace' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Update workspace owner
      await client.query(
        'UPDATE workspaces SET owner_id = $1 WHERE id = $2',
        [newOwnerId, workspaceId]
      );

      // Update roles
      await client.query(
        'UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3',
        ['owner', workspaceId, newOwnerId]
      );
      await client.query(
        'UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3',
        ['admin', workspaceId, req.userId]
      );

      await client.query('COMMIT');

      res.json({ message: 'Propriété transférée avec succès' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Transfer ownership error:', error);
    res.status(500).json({ error: 'Erreur lors du transfert de propriété' });
  }
});

module.exports = router;
