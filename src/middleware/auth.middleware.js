const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../database/db');
const { cache } = require('../database/redis');
const logger = require('../utils/logger');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token d\'authentification requis' });
    }

    const token = authHeader.split(' ')[1];
    
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      
      // Check if user exists and is active
      const cacheKey = `user:${decoded.userId}`;
      let user = await cache.get(cacheKey);
      
      if (!user) {
        const result = await db.query(
          'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1',
          [decoded.userId]
        );
        
        if (result.rows.length === 0) {
          return res.status(401).json({ error: 'Utilisateur non trouvé' });
        }
        
        user = result.rows[0];
        await cache.set(cacheKey, user, 300); // Cache for 5 minutes
      }
      
      if (!user.is_active) {
        return res.status(401).json({ error: 'Compte désactivé' });
      }
      
      req.user = user;
      req.userId = user.id;
      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expiré', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Token invalide' });
    }
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Erreur d\'authentification' });
  }
};

const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    
    if (!token) {
      return next(new Error('Token d\'authentification requis'));
    }
    
    const decoded = jwt.verify(token, config.jwt.secret);
    
    const result = await db.query(
      'SELECT id, email, first_name, last_name, role, is_active FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return next(new Error('Utilisateur non autorisé'));
    }
    
    socket.userId = decoded.userId;
    socket.user = result.rows[0];
    
    // Track online users
    await cache.setUserOnline(decoded.userId, socket.id);
    
    next();
  } catch (error) {
    logger.error('Socket auth error:', error);
    next(new Error('Token invalide'));
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Non authentifié' });
    }
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    
    next();
  };
};

const checkWorkspaceAccess = async (req, res, next) => {
  try {
    const workspaceId = req.params.workspaceId || req.body.workspaceId;
    
    if (!workspaceId) {
      return res.status(400).json({ error: 'ID du workspace requis' });
    }
    
    const result = await db.query(
      `SELECT wm.role FROM workspace_members wm
       WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
      [workspaceId, req.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Accès au workspace non autorisé' });
    }
    
    req.workspaceRole = result.rows[0].role;
    next();
  } catch (error) {
    logger.error('Workspace access check error:', error);
    res.status(500).json({ error: 'Erreur de vérification d\'accès' });
  }
};

const checkBoardAccess = async (req, res, next) => {
  try {
    const boardId = req.params.boardId || req.body.boardId;
    
    if (!boardId) {
      return res.status(400).json({ error: 'ID du board requis' });
    }
    
    const result = await db.query(
      `SELECT b.*, wm.role as workspace_role
       FROM boards b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2`,
      [boardId, req.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Accès au board non autorisé' });
    }
    
    req.board = result.rows[0];
    req.workspaceRole = result.rows[0].workspace_role;
    next();
  } catch (error) {
    logger.error('Board access check error:', error);
    res.status(500).json({ error: 'Erreur de vérification d\'accès' });
  }
};

const checkWorkspaceAdmin = async (req, res, next) => {
  try {
    const workspaceId = req.params.workspaceId || req.body.workspaceId;
    
    if (!workspaceId) {
      return res.status(400).json({ error: 'ID du workspace requis' });
    }
    
    const result = await db.query(
      `SELECT wm.role FROM workspace_members wm
       WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
      [workspaceId, req.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Accès au workspace non autorisé' });
    }
    
    if (!['owner', 'admin'].includes(result.rows[0].role)) {
      return res.status(403).json({ error: 'Droits administrateur requis' });
    }
    
    req.workspaceRole = result.rows[0].role;
    next();
  } catch (error) {
    logger.error('Workspace admin check error:', error);
    res.status(500).json({ error: 'Erreur de vérification d\'accès' });
  }
};

// Check if user has a specific permission
const checkPermission = (permissionCode) => {
  return async (req, res, next) => {
    try {
      const workspaceId = req.params.workspaceId || req.body.workspaceId;
      
      if (!workspaceId) {
        return res.status(400).json({ error: 'ID du workspace requis' });
      }
      
      // Check workspace role first (owner/admin have all permissions)
      const memberResult = await db.query(
        `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, req.userId]
      );
      
      if (memberResult.rows.length === 0) {
        return res.status(403).json({ error: 'Accès au workspace non autorisé' });
      }
      
      const wsRole = memberResult.rows[0].role;
      if (['owner', 'admin'].includes(wsRole)) {
        return next();
      }
      
      // Check custom role permissions
      const permResult = await db.query(`
        SELECT COUNT(*) as count
        FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = $1 AND ur.workspace_id = $2 AND p.code = $3
      `, [req.userId, workspaceId, permissionCode]);
      
      if (parseInt(permResult.rows[0].count) > 0) {
        return next();
      }
      
      return res.status(403).json({ error: `Permission "${permissionCode}" requise` });
    } catch (error) {
      logger.error('Permission check error:', error);
      res.status(500).json({ error: 'Erreur de vérification des permissions' });
    }
  };
};

module.exports = {
  authenticate,
  authenticateSocket,
  authorize,
  checkWorkspaceAccess,
  checkWorkspaceAdmin,
  checkBoardAccess,
  checkPermission
};
