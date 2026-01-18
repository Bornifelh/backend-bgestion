require('dotenv').config({ path: '../../.env' });
const bcrypt = require('bcryptjs');
const db = require('./db');
const logger = require('../utils/logger');

async function seed() {
  try {
    logger.info('Starting database seeding...');

    // Create demo user
    const passwordHash = await bcrypt.hash('demo123', 10);
    const userResult = await db.query(`
      INSERT INTO users (email, password_hash, first_name, last_name, role)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET password_hash = $2
      RETURNING id
    `, ['demo@gesprojet.com', passwordHash, 'Demo', 'User', 'admin']);
    
    const userId = userResult.rows[0].id;
    logger.info(`Created user: ${userId}`);

    // Create workspace
    const workspaceResult = await db.query(`
      INSERT INTO workspaces (name, description, icon, color, owner_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, ['Mon Workspace', 'Workspace de démonstration', '🏢', '#6366f1', userId]);
    
    const workspaceId = workspaceResult.rows[0].id;
    logger.info(`Created workspace: ${workspaceId}`);

    // Add user as workspace member
    await db.query(`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [workspaceId, userId, 'owner']);

    // Create board
    const boardResult = await db.query(`
      INSERT INTO boards (workspace_id, name, description, icon, color, owner_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [workspaceId, 'Gestion de Projet', 'Tableau principal de gestion', '📋', '#6366f1', userId]);
    
    const boardId = boardResult.rows[0].id;
    logger.info(`Created board: ${boardId}`);

    // Get column types
    const columnTypes = await db.query('SELECT id, name FROM column_types');
    const typeMap = {};
    columnTypes.rows.forEach(ct => {
      typeMap[ct.name] = ct.id;
    });

    // Create columns
    const columns = [
      { title: 'Statut', type: 'status', position: 0, width: 130 },
      { title: 'Responsable', type: 'person', position: 1, width: 120 },
      { title: 'Date limite', type: 'date', position: 2, width: 130 },
      { title: 'Priorité', type: 'priority', position: 3, width: 120 },
      { title: 'Progression', type: 'progress', position: 4, width: 150 },
    ];

    const columnIds = {};
    for (const col of columns) {
      const result = await db.query(`
        INSERT INTO columns (board_id, column_type_id, title, position, width)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [boardId, typeMap[col.type], col.title, col.position, col.width]);
      columnIds[col.type] = result.rows[0].id;
    }
    logger.info('Created columns');

    // Add status labels
    const statusLabels = [
      { label: 'À faire', color: '#9ca3af' },
      { label: 'En cours', color: '#3b82f6' },
      { label: 'En revue', color: '#f59e0b' },
      { label: 'Terminé', color: '#22c55e' },
      { label: 'Bloqué', color: '#ef4444' },
    ];

    for (let i = 0; i < statusLabels.length; i++) {
      await db.query(`
        INSERT INTO status_labels (column_id, label, color, position)
        VALUES ($1, $2, $3, $4)
      `, [columnIds.status, statusLabels[i].label, statusLabels[i].color, i]);
    }
    logger.info('Created status labels');

    // Create groups
    const groups = [
      { name: 'Sprint 1', color: '#6366f1' },
      { name: 'Sprint 2', color: '#8b5cf6' },
      { name: 'Backlog', color: '#64748b' },
    ];

    const groupIds = [];
    for (let i = 0; i < groups.length; i++) {
      const result = await db.query(`
        INSERT INTO groups (board_id, name, color, position)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [boardId, groups[i].name, groups[i].color, i]);
      groupIds.push(result.rows[0].id);
    }
    logger.info('Created groups');

    // Create sample items
    const items = [
      { name: 'Configuration du projet', groupIndex: 0, status: 'Terminé', priority: 2 },
      { name: 'Design de la base de données', groupIndex: 0, status: 'Terminé', priority: 3 },
      { name: 'Authentification utilisateur', groupIndex: 0, status: 'En cours', priority: 3 },
      { name: 'Interface tableau de bord', groupIndex: 1, status: 'À faire', priority: 2 },
      { name: 'Système de notifications', groupIndex: 1, status: 'À faire', priority: 1 },
      { name: 'Tests unitaires', groupIndex: 2, status: 'À faire', priority: 1 },
      { name: 'Documentation', groupIndex: 2, status: 'À faire', priority: 0 },
    ];

    const statusLabelResult = await db.query(
      'SELECT id, label FROM status_labels WHERE column_id = $1',
      [columnIds.status]
    );
    const statusMap = {};
    statusLabelResult.rows.forEach(s => {
      statusMap[s.label] = s.id;
    });

    for (let i = 0; i < items.length; i++) {
      const itemResult = await db.query(`
        INSERT INTO items (board_id, group_id, name, position, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [boardId, groupIds[items[i].groupIndex], items[i].name, i, userId]);
      
      const itemId = itemResult.rows[0].id;

      // Add status value
      await db.query(`
        INSERT INTO item_values (item_id, column_id, value)
        VALUES ($1, $2, $3)
      `, [itemId, columnIds.status, JSON.stringify({ labelId: statusMap[items[i].status] })]);

      // Add person value
      await db.query(`
        INSERT INTO item_values (item_id, column_id, value)
        VALUES ($1, $2, $3)
      `, [itemId, columnIds.person, JSON.stringify({ userIds: [userId] })]);

      // Add priority value
      await db.query(`
        INSERT INTO item_values (item_id, column_id, value)
        VALUES ($1, $2, $3)
      `, [itemId, columnIds.priority, JSON.stringify({ level: items[i].priority })]);
    }
    logger.info('Created items with values');

    // Create a default view
    await db.query(`
      INSERT INTO views (board_id, name, type, created_by)
      VALUES ($1, $2, $3, $4)
    `, [boardId, 'Vue principale', 'table', userId]);
    logger.info('Created default view');

    logger.info('✅ Seeding completed successfully');
    logger.info('');
    logger.info('Demo credentials:');
    logger.info('  Email: demo@gesprojet.com');
    logger.info('  Password: demo123');
    
    process.exit(0);
  } catch (error) {
    logger.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

seed();
