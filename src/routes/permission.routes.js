const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate, checkWorkspaceAccess, checkWorkspaceAdmin } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// ==========================================
// PERMISSIONS LIST
// ==========================================

// Get all available permissions
router.get('/list', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM permissions ORDER BY category, name'
    );

    // Group by category
    const grouped = {};
    result.rows.forEach(p => {
      if (!grouped[p.category]) grouped[p.category] = [];
      grouped[p.category].push({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
      });
    });

    res.json({
      permissions: result.rows,
      byCategory: grouped,
    });
  } catch (error) {
    logger.error('Get permissions error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// WORKSPACE ROLES
// ==========================================

// Get workspace roles
router.get('/roles/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const rolesResult = await db.query(`
      SELECT r.*, 
        (SELECT COUNT(*) FROM user_roles WHERE role_id = r.id) as user_count,
        (SELECT json_agg(p.code) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id) as permissions
      FROM workspace_roles r
      WHERE r.workspace_id = $1
      ORDER BY r.name
    `, [workspaceId]);

    res.json(rolesResult.rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      color: r.color,
      isDefault: r.is_default,
      userCount: parseInt(r.user_count),
      permissions: r.permissions || [],
      createdAt: r.created_at,
    })));
  } catch (error) {
    logger.error('Get roles error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Create workspace role
router.post('/roles', authenticate, [
  body('workspaceId').isUUID(),
  body('name').trim().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId, name, description, color, permissions } = req.body;

    // Check admin access
    const accessCheck = await db.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, req.userId]
    );
    if (accessCheck.rows.length === 0 || !['owner', 'admin'].includes(accessCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Create role
      const roleResult = await client.query(
        `INSERT INTO workspace_roles (workspace_id, name, description, color)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [workspaceId, name, description, color || '#6366f1']
      );
      const role = roleResult.rows[0];

      // Add permissions
      if (permissions && permissions.length > 0) {
        for (const permCode of permissions) {
          const permResult = await client.query(
            'SELECT id FROM permissions WHERE code = $1',
            [permCode]
          );
          if (permResult.rows.length > 0) {
            await client.query(
              'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [role.id, permResult.rows[0].id]
            );
          }
        }
      }

      await client.query('COMMIT');

      // Log audit
      await db.query(
        `INSERT INTO permission_audit_logs (workspace_id, action, entity_type, entity_id, performed_by, new_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, 'role_created', 'role', role.id, req.userId, JSON.stringify({ name, permissions })]
      );

      res.status(201).json({
        id: role.id,
        name: role.name,
        description: role.description,
        color: role.color,
        permissions: permissions || [],
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Create role error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Un rôle avec ce nom existe déjà' });
    }
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update role
router.put('/roles/:roleId', authenticate, async (req, res) => {
  try {
    const { roleId } = req.params;
    const { name, description, color, permissions } = req.body;

    // Get role and check access
    const roleCheck = await db.query(
      `SELECT r.*, wm.role as member_role FROM workspace_roles r
       JOIN workspace_members wm ON wm.workspace_id = r.workspace_id AND wm.user_id = $2
       WHERE r.id = $1`,
      [roleId, req.userId]
    );
    if (roleCheck.rows.length === 0 || !['owner', 'admin'].includes(roleCheck.rows[0].member_role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Update role
      const updates = [];
      const values = [];
      let paramCount = 1;

      if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
      if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
      if (color !== undefined) { updates.push(`color = $${paramCount++}`); values.push(color); }

      if (updates.length > 0) {
        values.push(roleId);
        await client.query(
          `UPDATE workspace_roles SET ${updates.join(', ')} WHERE id = $${paramCount}`,
          values
        );
      }

      // Update permissions
      if (permissions !== undefined) {
        await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
        for (const permCode of permissions) {
          const permResult = await client.query(
            'SELECT id FROM permissions WHERE code = $1',
            [permCode]
          );
          if (permResult.rows.length > 0) {
            await client.query(
              'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)',
              [roleId, permResult.rows[0].id]
            );
          }
        }
      }

      await client.query('COMMIT');

      res.json({ message: 'Rôle mis à jour' });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Update role error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete role
router.delete('/roles/:roleId', authenticate, async (req, res) => {
  try {
    const { roleId } = req.params;

    // Check access
    const roleCheck = await db.query(
      `SELECT r.*, wm.role as member_role FROM workspace_roles r
       JOIN workspace_members wm ON wm.workspace_id = r.workspace_id AND wm.user_id = $2
       WHERE r.id = $1`,
      [roleId, req.userId]
    );
    if (roleCheck.rows.length === 0 || !['owner', 'admin'].includes(roleCheck.rows[0].member_role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    await db.query('DELETE FROM workspace_roles WHERE id = $1', [roleId]);
    res.json({ message: 'Rôle supprimé' });
  } catch (error) {
    logger.error('Delete role error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// USER ROLE ASSIGNMENT
// ==========================================

// Get user permissions in workspace
router.get('/users/:userId/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { userId, workspaceId } = req.params;

    // Get user info
    const userResult = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, wm.role as workspace_role
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE u.id = $1 AND wm.workspace_id = $2`,
      [userId, workspaceId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const user = userResult.rows[0];

    // Get assigned roles
    const rolesResult = await db.query(
      `SELECT r.id, r.name, r.color, r.description
       FROM user_roles ur
       JOIN workspace_roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.workspace_id = $2`,
      [userId, workspaceId]
    );

    // Get all permissions (from workspace role + custom roles)
    const permissionsResult = await db.query(`
      SELECT DISTINCT p.code, p.name, p.category
      FROM permissions p
      JOIN role_permissions rp ON rp.permission_id = p.id
      JOIN user_roles ur ON ur.role_id = rp.role_id
      WHERE ur.user_id = $1 AND ur.workspace_id = $2
    `, [userId, workspaceId]);

    // Get board-specific permissions
    const boardPermissions = await db.query(
      `SELECT bp.board_id, b.name as board_name, bp.permission_level
       FROM board_permissions bp
       JOIN boards b ON b.id = bp.board_id
       WHERE bp.user_id = $1 AND b.workspace_id = $2`,
      [userId, workspaceId]
    );

    // Get project-specific permissions
    const projectPermissions = await db.query(
      `SELECT pp.project_id, p.name as project_name, pp.permission_level
       FROM project_permissions pp
       JOIN sdsi_projects p ON p.id = pp.project_id
       WHERE pp.user_id = $1 AND p.workspace_id = $2`,
      [userId, workspaceId]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        fullName: `${user.first_name} ${user.last_name}`,
        avatarUrl: user.avatar_url,
        workspaceRole: user.workspace_role,
      },
      roles: rolesResult.rows,
      permissions: permissionsResult.rows,
      boardPermissions: boardPermissions.rows,
      projectPermissions: projectPermissions.rows,
    });
  } catch (error) {
    logger.error('Get user permissions error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Assign role to user
router.post('/users/:userId/roles', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { workspaceId, roleId } = req.body;

    // Check admin access
    const accessCheck = await db.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, req.userId]
    );
    if (accessCheck.rows.length === 0 || !['owner', 'admin'].includes(accessCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    await db.query(
      `INSERT INTO user_roles (user_id, workspace_id, role_id, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, workspace_id, role_id) DO NOTHING`,
      [userId, workspaceId, roleId, req.userId]
    );

    // Log audit
    await db.query(
      `INSERT INTO permission_audit_logs (workspace_id, action, entity_type, entity_id, target_user_id, performed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, 'role_assigned', 'user_role', roleId, userId, req.userId]
    );

    res.json({ message: 'Rôle assigné' });
  } catch (error) {
    logger.error('Assign role error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Remove role from user
router.delete('/users/:userId/roles/:roleId', authenticate, async (req, res) => {
  try {
    const { userId, roleId } = req.params;
    const { workspaceId } = req.query;

    // Check admin access
    const accessCheck = await db.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, req.userId]
    );
    if (accessCheck.rows.length === 0 || !['owner', 'admin'].includes(accessCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    await db.query(
      'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 AND workspace_id = $3',
      [userId, roleId, workspaceId]
    );

    res.json({ message: 'Rôle retiré' });
  } catch (error) {
    logger.error('Remove role error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// BOARD PERMISSIONS
// ==========================================

// Get board permissions
router.get('/boards/:boardId', authenticate, async (req, res) => {
  try {
    const { boardId } = req.params;

    const result = await db.query(`
      SELECT bp.*, u.email, u.first_name, u.last_name, u.avatar_url
      FROM board_permissions bp
      JOIN users u ON u.id = bp.user_id
      WHERE bp.board_id = $1
      ORDER BY bp.permission_level DESC, u.first_name
    `, [boardId]);

    // Get group permissions
    const groupResult = await db.query(`
      SELECT bgp.*, ug.name as group_name, ug.color as group_color,
        (SELECT COUNT(*) FROM user_group_members WHERE group_id = ug.id) as member_count
      FROM board_group_permissions bgp
      JOIN user_groups ug ON ug.id = bgp.group_id
      WHERE bgp.board_id = $1
    `, [boardId]);

    res.json({
      users: result.rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        fullName: `${r.first_name} ${r.last_name}`,
        avatarUrl: r.avatar_url,
        permissionLevel: r.permission_level,
        grantedAt: r.created_at,
      })),
      groups: groupResult.rows.map(r => ({
        id: r.id,
        groupId: r.group_id,
        groupName: r.group_name,
        groupColor: r.group_color,
        memberCount: parseInt(r.member_count),
        permissionLevel: r.permission_level,
      })),
    });
  } catch (error) {
    logger.error('Get board permissions error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Set board permission for user
router.post('/boards/:boardId/users/:userId', authenticate, async (req, res) => {
  try {
    const { boardId, userId } = req.params;
    const { permissionLevel } = req.body; // 'view', 'edit', 'admin'

    // Check if requester has admin on this board
    const accessCheck = await db.query(`
      SELECT bp.permission_level, b.workspace_id
      FROM boards b
      LEFT JOIN board_permissions bp ON bp.board_id = b.id AND bp.user_id = $2
      LEFT JOIN workspace_members wm ON wm.workspace_id = b.workspace_id AND wm.user_id = $2
      WHERE b.id = $1
    `, [boardId, req.userId]);

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Tableau non trouvé' });
    }

    const board = accessCheck.rows[0];
    const isAdmin = board.permission_level === 'admin';

    // Check workspace admin
    const wsAdmin = await db.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [board.workspace_id, req.userId]
    );
    const isWsAdmin = wsAdmin.rows.length > 0 && ['owner', 'admin'].includes(wsAdmin.rows[0].role);

    if (!isAdmin && !isWsAdmin) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    await db.query(
      `INSERT INTO board_permissions (board_id, user_id, permission_level, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id) DO UPDATE SET permission_level = $3`,
      [boardId, userId, permissionLevel, req.userId]
    );

    res.json({ message: 'Permission mise à jour' });
  } catch (error) {
    logger.error('Set board permission error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Remove board permission
router.delete('/boards/:boardId/users/:userId', authenticate, async (req, res) => {
  try {
    const { boardId, userId } = req.params;

    await db.query(
      'DELETE FROM board_permissions WHERE board_id = $1 AND user_id = $2',
      [boardId, userId]
    );

    res.json({ message: 'Permission retirée' });
  } catch (error) {
    logger.error('Remove board permission error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// PROJECT PERMISSIONS
// ==========================================

// Get project permissions
router.get('/projects/:projectId', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await db.query(`
      SELECT pp.*, u.email, u.first_name, u.last_name, u.avatar_url
      FROM project_permissions pp
      JOIN users u ON u.id = pp.user_id
      WHERE pp.project_id = $1
      ORDER BY pp.permission_level DESC, u.first_name
    `, [projectId]);

    // Get group permissions
    const groupResult = await db.query(`
      SELECT pgp.*, ug.name as group_name, ug.color as group_color,
        (SELECT COUNT(*) FROM user_group_members WHERE group_id = ug.id) as member_count
      FROM project_group_permissions pgp
      JOIN user_groups ug ON ug.id = pgp.group_id
      WHERE pgp.project_id = $1
    `, [projectId]);

    res.json({
      users: result.rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        email: r.email,
        firstName: r.first_name,
        lastName: r.last_name,
        fullName: `${r.first_name} ${r.last_name}`,
        avatarUrl: r.avatar_url,
        permissionLevel: r.permission_level,
        grantedAt: r.created_at,
      })),
      groups: groupResult.rows.map(r => ({
        id: r.id,
        groupId: r.group_id,
        groupName: r.group_name,
        groupColor: r.group_color,
        memberCount: parseInt(r.member_count),
        permissionLevel: r.permission_level,
      })),
    });
  } catch (error) {
    logger.error('Get project permissions error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Set project permission for user
router.post('/projects/:projectId/users/:userId', authenticate, async (req, res) => {
  try {
    const { projectId, userId } = req.params;
    const { permissionLevel } = req.body;

    // Check access
    const projectCheck = await db.query(
      `SELECT p.workspace_id FROM sdsi_projects p WHERE p.id = $1`,
      [projectId]
    );
    if (projectCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }

    const wsAdmin = await db.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [projectCheck.rows[0].workspace_id, req.userId]
    );
    if (wsAdmin.rows.length === 0 || !['owner', 'admin'].includes(wsAdmin.rows[0].role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    await db.query(
      `INSERT INTO project_permissions (project_id, user_id, permission_level, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET permission_level = $3`,
      [projectId, userId, permissionLevel, req.userId]
    );

    res.json({ message: 'Permission mise à jour' });
  } catch (error) {
    logger.error('Set project permission error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Remove project permission
router.delete('/projects/:projectId/users/:userId', authenticate, async (req, res) => {
  try {
    const { projectId, userId } = req.params;

    await db.query(
      'DELETE FROM project_permissions WHERE project_id = $1 AND user_id = $2',
      [projectId, userId]
    );

    res.json({ message: 'Permission retirée' });
  } catch (error) {
    logger.error('Remove project permission error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// USER GROUPS
// ==========================================

// Get workspace groups
router.get('/groups/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(`
      SELECT g.*,
        (SELECT COUNT(*) FROM user_group_members WHERE group_id = g.id) as member_count,
        (SELECT json_agg(json_build_object('id', u.id, 'email', u.email, 'firstName', u.first_name, 'lastName', u.last_name))
         FROM user_group_members ugm
         JOIN users u ON u.id = ugm.user_id
         WHERE ugm.group_id = g.id) as members
      FROM user_groups g
      WHERE g.workspace_id = $1
      ORDER BY g.name
    `, [workspaceId]);

    res.json(result.rows.map(g => ({
      id: g.id,
      name: g.name,
      description: g.description,
      color: g.color,
      memberCount: parseInt(g.member_count),
      members: g.members || [],
      createdAt: g.created_at,
    })));
  } catch (error) {
    logger.error('Get groups error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Create group
router.post('/groups', authenticate, async (req, res) => {
  try {
    const { workspaceId, name, description, color, memberIds } = req.body;

    // Check access
    const accessCheck = await db.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, req.userId]
    );
    if (accessCheck.rows.length === 0 || !['owner', 'admin'].includes(accessCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const groupResult = await client.query(
        `INSERT INTO user_groups (workspace_id, name, description, color, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [workspaceId, name, description, color || '#6366f1', req.userId]
      );
      const group = groupResult.rows[0];

      // Add members
      if (memberIds && memberIds.length > 0) {
        for (const memberId of memberIds) {
          await client.query(
            'INSERT INTO user_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [group.id, memberId]
          );
        }
      }

      await client.query('COMMIT');

      res.status(201).json({
        id: group.id,
        name: group.name,
        description: group.description,
        color: group.color,
        memberCount: memberIds?.length || 0,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Create group error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Un groupe avec ce nom existe déjà' });
    }
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update group
router.put('/groups/:groupId', authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, description, color } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (color !== undefined) { updates.push(`color = $${paramCount++}`); values.push(color); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(groupId);
    await db.query(
      `UPDATE user_groups SET ${updates.join(', ')} WHERE id = $${paramCount}`,
      values
    );

    res.json({ message: 'Groupe mis à jour' });
  } catch (error) {
    logger.error('Update group error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete group
router.delete('/groups/:groupId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM user_groups WHERE id = $1', [req.params.groupId]);
    res.json({ message: 'Groupe supprimé' });
  } catch (error) {
    logger.error('Delete group error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Add member to group
router.post('/groups/:groupId/members/:userId', authenticate, async (req, res) => {
  try {
    const { groupId, userId } = req.params;

    await db.query(
      'INSERT INTO user_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, userId]
    );

    res.json({ message: 'Membre ajouté' });
  } catch (error) {
    logger.error('Add group member error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Remove member from group
router.delete('/groups/:groupId/members/:userId', authenticate, async (req, res) => {
  try {
    const { groupId, userId } = req.params;

    await db.query(
      'DELETE FROM user_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );

    res.json({ message: 'Membre retiré' });
  } catch (error) {
    logger.error('Remove group member error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// AUDIT LOGS
// ==========================================

router.get('/audit/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(`
      SELECT al.*, 
        u1.email as performer_email, u1.first_name as performer_first_name, u1.last_name as performer_last_name,
        u2.email as target_email, u2.first_name as target_first_name, u2.last_name as target_last_name
      FROM permission_audit_logs al
      LEFT JOIN users u1 ON u1.id = al.performed_by
      LEFT JOIN users u2 ON u2.id = al.target_user_id
      WHERE al.workspace_id = $1
      ORDER BY al.created_at DESC
      LIMIT $2 OFFSET $3
    `, [workspaceId, limit, offset]);

    res.json(result.rows.map(r => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      performer: r.performer_email ? {
        email: r.performer_email,
        name: `${r.performer_first_name} ${r.performer_last_name}`,
      } : null,
      target: r.target_email ? {
        email: r.target_email,
        name: `${r.target_first_name} ${r.target_last_name}`,
      } : null,
      oldValue: r.old_value,
      newValue: r.new_value,
      createdAt: r.created_at,
    })));
  } catch (error) {
    logger.error('Get audit logs error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

module.exports = router;
