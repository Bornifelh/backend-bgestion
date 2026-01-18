const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate, checkWorkspaceAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Get all budgets for a workspace
router.get('/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT b.*, 
        u.first_name as creator_first_name, 
        u.last_name as creator_last_name,
        (SELECT COUNT(*) FROM budget_expenses WHERE budget_id = b.id) as expense_count,
        (SELECT COUNT(*) FROM budget_categories WHERE budget_id = b.id) as category_count
       FROM budgets b
       LEFT JOIN users u ON u.id = b.created_by
       WHERE b.workspace_id = $1
       ORDER BY b.created_at DESC`,
      [workspaceId]
    );

    res.json(result.rows.map(b => ({
      id: b.id,
      workspaceId: b.workspace_id,
      name: b.name,
      description: b.description,
      totalAmount: parseFloat(b.total_amount),
      spentAmount: parseFloat(b.spent_amount),
      remainingAmount: parseFloat(b.total_amount) - parseFloat(b.spent_amount),
      currency: b.currency,
      startDate: b.start_date,
      endDate: b.end_date,
      status: b.status,
      color: b.color,
      creatorName: b.creator_first_name ? `${b.creator_first_name} ${b.creator_last_name}` : null,
      expenseCount: parseInt(b.expense_count),
      categoryCount: parseInt(b.category_count),
      percentUsed: b.total_amount > 0 ? Math.round((b.spent_amount / b.total_amount) * 100) : 0,
      createdAt: b.created_at,
    })));
  } catch (error) {
    logger.error('Get budgets error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des budgets' });
  }
});

// Create budget
router.post('/', authenticate, [
  body('workspaceId').isUUID().withMessage('ID workspace invalide'),
  body('name').trim().notEmpty().withMessage('Nom du budget requis'),
  body('totalAmount').isFloat({ min: 0 }).withMessage('Montant invalide'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId, name, description, totalAmount, currency, startDate, endDate, color } = req.body;

    // Check workspace access
    const memberCheck = await db.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès au workspace non autorisé' });
    }

    const result = await db.query(
      `INSERT INTO budgets (workspace_id, name, description, total_amount, currency, start_date, end_date, color, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [workspaceId, name, description || null, totalAmount, currency || 'XAF', startDate || null, endDate || null, color || '#6366f1', req.userId]
    );

    const budget = result.rows[0];

    logger.info(`Budget created: ${budget.id} by user ${req.userId}`);

    res.status(201).json({
      id: budget.id,
      workspaceId: budget.workspace_id,
      name: budget.name,
      description: budget.description,
      totalAmount: parseFloat(budget.total_amount),
      spentAmount: 0,
      remainingAmount: parseFloat(budget.total_amount),
      currency: budget.currency,
      startDate: budget.start_date,
      endDate: budget.end_date,
      status: budget.status,
      color: budget.color,
      percentUsed: 0,
      createdAt: budget.created_at,
    });
  } catch (error) {
    logger.error('Create budget error:', error);
    res.status(500).json({ error: 'Erreur lors de la création du budget' });
  }
});

// Get budget details
router.get('/:budgetId', authenticate, async (req, res) => {
  try {
    const { budgetId } = req.params;

    // Get budget with access check
    const budgetResult = await db.query(
      `SELECT b.*, u.first_name as creator_first_name, u.last_name as creator_last_name
       FROM budgets b
       LEFT JOIN users u ON u.id = b.created_by
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2`,
      [budgetId, req.userId]
    );

    if (budgetResult.rows.length === 0) {
      return res.status(404).json({ error: 'Budget non trouvé' });
    }

    const budget = budgetResult.rows[0];

    // Get categories
    const categoriesResult = await db.query(
      `SELECT bc.*, 
        COALESCE(SUM(be.amount), 0) as spent_amount
       FROM budget_categories bc
       LEFT JOIN budget_expenses be ON be.category_id = bc.id
       WHERE bc.budget_id = $1
       GROUP BY bc.id
       ORDER BY bc.position`,
      [budgetId]
    );

    // Get recent expenses
    const expensesResult = await db.query(
      `SELECT be.*, 
        bc.name as category_name, bc.color as category_color,
        u.first_name, u.last_name
       FROM budget_expenses be
       LEFT JOIN budget_categories bc ON bc.id = be.category_id
       LEFT JOIN users u ON u.id = be.created_by
       WHERE be.budget_id = $1
       ORDER BY be.expense_date DESC, be.created_at DESC
       LIMIT 50`,
      [budgetId]
    );

    res.json({
      id: budget.id,
      workspaceId: budget.workspace_id,
      name: budget.name,
      description: budget.description,
      totalAmount: parseFloat(budget.total_amount),
      spentAmount: parseFloat(budget.spent_amount),
      remainingAmount: parseFloat(budget.total_amount) - parseFloat(budget.spent_amount),
      currency: budget.currency,
      startDate: budget.start_date,
      endDate: budget.end_date,
      status: budget.status,
      color: budget.color,
      creatorName: budget.creator_first_name ? `${budget.creator_first_name} ${budget.creator_last_name}` : null,
      percentUsed: budget.total_amount > 0 ? Math.round((budget.spent_amount / budget.total_amount) * 100) : 0,
      createdAt: budget.created_at,
      categories: categoriesResult.rows.map(c => ({
        id: c.id,
        name: c.name,
        allocatedAmount: parseFloat(c.allocated_amount),
        spentAmount: parseFloat(c.spent_amount),
        color: c.color,
        icon: c.icon,
      })),
      expenses: expensesResult.rows.map(e => ({
        id: e.id,
        description: e.description,
        amount: parseFloat(e.amount),
        expenseDate: e.expense_date,
        categoryId: e.category_id,
        categoryName: e.category_name,
        categoryColor: e.category_color,
        vendor: e.vendor,
        notes: e.notes,
        status: e.status,
        createdBy: e.first_name ? `${e.first_name} ${e.last_name}` : null,
        createdAt: e.created_at,
      })),
    });
  } catch (error) {
    logger.error('Get budget error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du budget' });
  }
});

// Update budget
router.put('/:budgetId', authenticate, async (req, res) => {
  try {
    const { budgetId } = req.params;
    const { name, description, totalAmount, currency, startDate, endDate, color, status } = req.body;

    // Check access
    const accessCheck = await db.query(
      `SELECT b.id FROM budgets b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2 AND wm.role IN ('owner', 'admin')`,
      [budgetId, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (totalAmount !== undefined) { updates.push(`total_amount = $${paramCount++}`); values.push(totalAmount); }
    if (currency !== undefined) { updates.push(`currency = $${paramCount++}`); values.push(currency); }
    if (startDate !== undefined) { updates.push(`start_date = $${paramCount++}`); values.push(startDate); }
    if (endDate !== undefined) { updates.push(`end_date = $${paramCount++}`); values.push(endDate); }
    if (color !== undefined) { updates.push(`color = $${paramCount++}`); values.push(color); }
    if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(budgetId);

    const result = await db.query(
      `UPDATE budgets SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const budget = result.rows[0];
    res.json({
      id: budget.id,
      name: budget.name,
      description: budget.description,
      totalAmount: parseFloat(budget.total_amount),
      spentAmount: parseFloat(budget.spent_amount),
      currency: budget.currency,
      startDate: budget.start_date,
      endDate: budget.end_date,
      status: budget.status,
      color: budget.color,
    });
  } catch (error) {
    logger.error('Update budget error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du budget' });
  }
});

// Delete budget
router.delete('/:budgetId', authenticate, async (req, res) => {
  try {
    const { budgetId } = req.params;

    const accessCheck = await db.query(
      `SELECT b.id FROM budgets b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2 AND wm.role IN ('owner', 'admin')`,
      [budgetId, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Permission insuffisante' });
    }

    await db.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
    res.json({ message: 'Budget supprimé avec succès' });
  } catch (error) {
    logger.error('Delete budget error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression du budget' });
  }
});

// Add category to budget
router.post('/:budgetId/categories', authenticate, [
  body('name').trim().notEmpty().withMessage('Nom de la catégorie requis'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { budgetId } = req.params;
    const { name, allocatedAmount, color, icon } = req.body;

    // Check access
    const accessCheck = await db.query(
      `SELECT b.id FROM budgets b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2`,
      [budgetId, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM budget_categories WHERE budget_id = $1',
      [budgetId]
    );

    const result = await db.query(
      `INSERT INTO budget_categories (budget_id, name, allocated_amount, color, icon, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [budgetId, name, allocatedAmount || 0, color || '#6366f1', icon || null, posResult.rows[0].next_pos]
    );

    const category = result.rows[0];
    res.status(201).json({
      id: category.id,
      name: category.name,
      allocatedAmount: parseFloat(category.allocated_amount),
      spentAmount: 0,
      color: category.color,
      icon: category.icon,
    });
  } catch (error) {
    logger.error('Add category error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'ajout de la catégorie' });
  }
});

// Add expense
router.post('/:budgetId/expenses', authenticate, [
  body('description').trim().notEmpty().withMessage('Description requise'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Montant invalide'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { budgetId } = req.params;
    const { description, amount, categoryId, expenseDate, vendor, notes, itemId } = req.body;

    // Check access
    const accessCheck = await db.query(
      `SELECT b.id FROM budgets b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2`,
      [budgetId, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const result = await db.query(
      `INSERT INTO budget_expenses (budget_id, category_id, item_id, description, amount, expense_date, vendor, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [budgetId, categoryId || null, itemId || null, description, amount, expenseDate || new Date(), vendor || null, notes || null, req.userId]
    );

    const expense = result.rows[0];

    // Get category info if exists
    let categoryInfo = null;
    if (expense.category_id) {
      const catResult = await db.query(
        'SELECT name, color FROM budget_categories WHERE id = $1',
        [expense.category_id]
      );
      if (catResult.rows.length > 0) {
        categoryInfo = catResult.rows[0];
      }
    }

    res.status(201).json({
      id: expense.id,
      description: expense.description,
      amount: parseFloat(expense.amount),
      expenseDate: expense.expense_date,
      categoryId: expense.category_id,
      categoryName: categoryInfo?.name,
      categoryColor: categoryInfo?.color,
      vendor: expense.vendor,
      notes: expense.notes,
      status: expense.status,
      createdAt: expense.created_at,
    });
  } catch (error) {
    logger.error('Add expense error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'ajout de la dépense' });
  }
});

// Update expense
router.put('/:budgetId/expenses/:expenseId', authenticate, async (req, res) => {
  try {
    const { budgetId, expenseId } = req.params;
    const { description, amount, categoryId, expenseDate, vendor, notes, status } = req.body;

    // Check access
    const accessCheck = await db.query(
      `SELECT be.id FROM budget_expenses be
       JOIN budgets b ON b.id = be.budget_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE be.id = $1 AND be.budget_id = $2 AND wm.user_id = $3`,
      [expenseId, budgetId, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (amount !== undefined) { updates.push(`amount = $${paramCount++}`); values.push(amount); }
    if (categoryId !== undefined) { updates.push(`category_id = $${paramCount++}`); values.push(categoryId); }
    if (expenseDate !== undefined) { updates.push(`expense_date = $${paramCount++}`); values.push(expenseDate); }
    if (vendor !== undefined) { updates.push(`vendor = $${paramCount++}`); values.push(vendor); }
    if (notes !== undefined) { updates.push(`notes = $${paramCount++}`); values.push(notes); }
    if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(expenseId);

    const result = await db.query(
      `UPDATE budget_expenses SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const expense = result.rows[0];
    res.json({
      id: expense.id,
      description: expense.description,
      amount: parseFloat(expense.amount),
      expenseDate: expense.expense_date,
      categoryId: expense.category_id,
      vendor: expense.vendor,
      notes: expense.notes,
      status: expense.status,
    });
  } catch (error) {
    logger.error('Update expense error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la dépense' });
  }
});

// Delete expense
router.delete('/:budgetId/expenses/:expenseId', authenticate, async (req, res) => {
  try {
    const { budgetId, expenseId } = req.params;

    const accessCheck = await db.query(
      `SELECT be.id FROM budget_expenses be
       JOIN budgets b ON b.id = be.budget_id
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE be.id = $1 AND be.budget_id = $2 AND wm.user_id = $3`,
      [expenseId, budgetId, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    await db.query('DELETE FROM budget_expenses WHERE id = $1', [expenseId]);
    res.json({ message: 'Dépense supprimée avec succès' });
  } catch (error) {
    logger.error('Delete expense error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la dépense' });
  }
});

// Get budget analytics
router.get('/:budgetId/analytics', authenticate, async (req, res) => {
  try {
    const { budgetId } = req.params;

    // Check access
    const accessCheck = await db.query(
      `SELECT b.id FROM budgets b
       JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
       WHERE b.id = $1 AND wm.user_id = $2`,
      [budgetId, req.userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    // Expenses by category
    const byCategory = await db.query(
      `SELECT bc.name, bc.color, COALESCE(SUM(be.amount), 0) as total
       FROM budget_categories bc
       LEFT JOIN budget_expenses be ON be.category_id = bc.id
       WHERE bc.budget_id = $1
       GROUP BY bc.id
       ORDER BY total DESC`,
      [budgetId]
    );

    // Expenses by month
    const byMonth = await db.query(
      `SELECT DATE_TRUNC('month', expense_date) as month, SUM(amount) as total
       FROM budget_expenses
       WHERE budget_id = $1
       GROUP BY DATE_TRUNC('month', expense_date)
       ORDER BY month`,
      [budgetId]
    );

    // Top vendors
    const topVendors = await db.query(
      `SELECT vendor, SUM(amount) as total, COUNT(*) as count
       FROM budget_expenses
       WHERE budget_id = $1 AND vendor IS NOT NULL
       GROUP BY vendor
       ORDER BY total DESC
       LIMIT 10`,
      [budgetId]
    );

    res.json({
      byCategory: byCategory.rows.map(r => ({
        name: r.name,
        color: r.color,
        total: parseFloat(r.total),
      })),
      byMonth: byMonth.rows.map(r => ({
        month: r.month,
        total: parseFloat(r.total),
      })),
      topVendors: topVendors.rows.map(r => ({
        vendor: r.vendor,
        total: parseFloat(r.total),
        count: parseInt(r.count),
      })),
    });
  } catch (error) {
    logger.error('Get budget analytics error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des analytics' });
  }
});

module.exports = router;
