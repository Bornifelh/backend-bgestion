const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { authenticate } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// ========================================
// IT ASSETS CRUD
// ========================================

router.get('/assets', authenticate, async (req, res) => {
  try {
    const { category, status, search } = req.query;
    let query = 'SELECT * FROM it_assets WHERE 1=1';
    const params = [];
    let p = 1;

    if (category && category !== 'all') {
      query += ` AND category = $${p++}`;
      params.push(category);
    }
    if (status && status !== 'all') {
      query += ` AND status = $${p++}`;
      params.push(status);
    }
    if (search) {
      query += ` AND (name ILIKE $${p} OR serial ILIKE $${p} OR assignee ILIKE $${p} OR location ILIKE $${p})`;
      params.push(`%${search}%`);
      p++;
    }

    query += ' ORDER BY created_at DESC';
    const result = await db.query(query, params);
    res.json(result.rows.map(formatAsset));
  } catch (error) {
    logger.error('Get IT assets error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.get('/assets/:id', authenticate, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM it_assets WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
    res.json(formatAsset(result.rows[0]));
  } catch (error) {
    logger.error('Get asset error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/assets', authenticate, async (req, res) => {
  try {
    const { name, serial, category, status, brand, model, location, assignee, purchaseDate, warranty, value } = req.body;
    if (!name || !serial) return res.status(400).json({ error: 'Nom et numéro de série requis' });

    const result = await db.query(
      `INSERT INTO it_assets (name, serial, category, status, brand, model, location, assignee, purchase_date, warranty, value, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [name, serial, category || 'computers', status || 'in_stock', brand || '', model || '', location || '', assignee || '', purchaseDate || null, warranty || null, value || 0, req.userId]
    );
    res.status(201).json(formatAsset(result.rows[0]));
  } catch (error) {
    logger.error('Create asset error:', error);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

router.put('/assets/:id', authenticate, async (req, res) => {
  try {
    const { name, serial, category, status, brand, model, location, assignee, purchaseDate, warranty, value } = req.body;
    const result = await db.query(
      `UPDATE it_assets SET
        name = COALESCE($1, name), serial = COALESCE($2, serial), category = COALESCE($3, category),
        status = COALESCE($4, status), brand = COALESCE($5, brand), model = COALESCE($6, model),
        location = COALESCE($7, location), assignee = COALESCE($8, assignee),
        purchase_date = $9, warranty = $10, value = COALESCE($11, value),
        updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [name, serial, category, status, brand, model, location, assignee, purchaseDate || null, warranty || null, value, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
    res.json(formatAsset(result.rows[0]));
  } catch (error) {
    logger.error('Update asset error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.delete('/assets/:id', authenticate, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM it_assets WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
    res.json({ message: 'Supprimé' });
  } catch (error) {
    logger.error('Delete asset error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ========================================
// IT MAINTENANCE CRUD
// ========================================

router.get('/maintenance', authenticate, async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT m.*, u.first_name as assigned_first_name, u.last_name as assigned_last_name, u.email as assigned_email
      FROM it_maintenance m
      LEFT JOIN users u ON u.id = m.assigned_to
      WHERE 1=1
    `;
    const params = [];
    let p = 1;

    if (search) {
      query += ` AND (m.asset_name ILIKE $${p} OR m.description ILIKE $${p})`;
      params.push(`%${search}%`);
      p++;
    }

    query += ' ORDER BY m.created_at DESC';
    const result = await db.query(query, params);
    res.json(result.rows.map(formatMaint));
  } catch (error) {
    logger.error('Get maintenance error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/maintenance', authenticate, async (req, res) => {
  try {
    const { assetId, assetName, type, step, description, assignedTo, workspaceId, boardId, linkedItemId, scheduledDate, completedDate, cost, notes } = req.body;
    if (!description || !assetId) return res.status(400).json({ error: 'Description et équipement requis' });

    const result = await db.query(
      `INSERT INTO it_maintenance (asset_id, asset_name, type, step, description, assigned_to, workspace_id, board_id, linked_item_id, scheduled_date, completed_date, cost, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [assetId, assetName || '', type || 'preventive', step || 'attribution', description, assignedTo || null, workspaceId || null, boardId || null, linkedItemId || null, scheduledDate || null, completedDate || null, cost || 0, notes || '', req.userId]
    );

    const row = result.rows[0];
    let assigned = null;
    if (row.assigned_to) {
      const u = await db.query('SELECT first_name, last_name, email FROM users WHERE id = $1', [row.assigned_to]);
      if (u.rows.length) assigned = u.rows[0];
    }
    res.status(201).json(formatMaint({ ...row, assigned_first_name: assigned?.first_name, assigned_last_name: assigned?.last_name, assigned_email: assigned?.email }));
  } catch (error) {
    logger.error('Create maintenance error:', error);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

router.put('/maintenance/:id', authenticate, async (req, res) => {
  try {
    const { assetId, assetName, type, step, description, assignedTo, workspaceId, boardId, linkedItemId, scheduledDate, completedDate, cost, notes } = req.body;
    const result = await db.query(
      `UPDATE it_maintenance SET
        asset_id = COALESCE($1, asset_id), asset_name = COALESCE($2, asset_name),
        type = COALESCE($3, type), step = COALESCE($4, step),
        description = COALESCE($5, description), assigned_to = $6,
        workspace_id = $7, board_id = $8, linked_item_id = $9,
        scheduled_date = $10, completed_date = $11,
        cost = COALESCE($12, cost), notes = COALESCE($13, notes),
        updated_at = NOW()
       WHERE id = $14 RETURNING *`,
      [assetId, assetName, type, step, description, assignedTo || null, workspaceId || null, boardId || null, linkedItemId || null, scheduledDate || null, completedDate || null, cost, notes, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });

    const row = result.rows[0];
    let assigned = null;
    if (row.assigned_to) {
      const u = await db.query('SELECT first_name, last_name, email FROM users WHERE id = $1', [row.assigned_to]);
      if (u.rows.length) assigned = u.rows[0];
    }
    res.json(formatMaint({ ...row, assigned_first_name: assigned?.first_name, assigned_last_name: assigned?.last_name, assigned_email: assigned?.email }));
  } catch (error) {
    logger.error('Update maintenance error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.delete('/maintenance/:id', authenticate, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM it_maintenance WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
    res.json({ message: 'Supprimé' });
  } catch (error) {
    logger.error('Delete maintenance error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Stats
router.get('/stats', authenticate, async (req, res) => {
  try {
    const assetStats = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'in_use') as in_use,
        COUNT(*) FILTER (WHERE status = 'in_stock') as in_stock,
        COUNT(*) FILTER (WHERE status = 'maintenance') as maintenance,
        COALESCE(SUM(value), 0) as total_value
      FROM it_assets
    `);
    const maintStats = await db.query(`
      SELECT COUNT(*) FILTER (WHERE step != 'livraison') as pending FROM it_maintenance
    `);
    res.json({ ...assetStats.rows[0], pendingMaint: parseInt(maintStats.rows[0].pending) });
  } catch (error) {
    logger.error('Get IT stats error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

function formatAsset(r) {
  return {
    id: r.id,
    name: r.name,
    serial: r.serial,
    category: r.category,
    status: r.status,
    brand: r.brand,
    model: r.model,
    location: r.location,
    assignee: r.assignee,
    purchaseDate: r.purchase_date,
    warranty: r.warranty,
    value: parseFloat(r.value) || 0,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function formatMaint(r) {
  return {
    id: r.id,
    assetId: r.asset_id,
    assetName: r.asset_name,
    type: r.type,
    step: r.step,
    description: r.description,
    assignedTo: r.assigned_to,
    assignedName: r.assigned_first_name ? `${r.assigned_first_name} ${r.assigned_last_name}` : null,
    assignedEmail: r.assigned_email || null,
    workspaceId: r.workspace_id,
    boardId: r.board_id,
    linkedItemId: r.linked_item_id,
    linkedBoardId: r.board_id,
    scheduledDate: r.scheduled_date,
    completedDate: r.completed_date,
    cost: parseFloat(r.cost) || 0,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = router;
