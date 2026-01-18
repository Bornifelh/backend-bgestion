const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../database/db');
const { authenticate, checkWorkspaceAccess } = require('../middleware/auth.middleware');
const logger = require('../utils/logger');

// Helper function to convert empty strings to null for dates
const parseDate = (dateValue) => {
  if (!dateValue || (typeof dateValue === 'string' && dateValue.trim() === '')) {
    return null;
  }
  return dateValue;
};

// ==========================================
// STRATEGIC AXES
// ==========================================

// Get all strategic axes
router.get('/axes/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT sa.*,
        (SELECT COUNT(*) FROM sdsi_projects WHERE axis_id = sa.id) as project_count,
        (SELECT COUNT(*) FROM sdsi_kpis WHERE axis_id = sa.id) as kpi_count
       FROM sdsi_strategic_axes sa
       WHERE sa.workspace_id = $1
       ORDER BY sa.position ASC, sa.priority ASC`,
      [workspaceId]
    );

    res.json(result.rows.map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      objectives: a.objectives,
      priority: a.priority,
      color: a.color,
      icon: a.icon,
      status: a.status,
      startYear: a.start_year,
      endYear: a.end_year,
      projectCount: parseInt(a.project_count),
      kpiCount: parseInt(a.kpi_count),
      createdAt: a.created_at,
    })));
  } catch (error) {
    logger.error('Get strategic axes error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des axes' });
  }
});

// Create strategic axis
router.post('/axes', authenticate, [
  body('workspaceId').isUUID(),
  body('name').trim().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { workspaceId, name, description, objectives, priority, color, icon, startYear, endYear } = req.body;

    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM sdsi_strategic_axes WHERE workspace_id = $1',
      [workspaceId]
    );

    const result = await db.query(
      `INSERT INTO sdsi_strategic_axes (workspace_id, name, description, objectives, priority, color, icon, start_year, end_year, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [workspaceId, name, description, objectives, priority || 1, color || '#6366f1', icon, startYear, endYear, posResult.rows[0].next_pos, req.userId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create strategic axis error:', error);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// Update strategic axis
router.put('/axes/:axisId', authenticate, async (req, res) => {
  try {
    const { axisId } = req.params;
    const { name, description, objectives, priority, color, icon, status, startYear, endYear } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (objectives !== undefined) { updates.push(`objectives = $${paramCount++}`); values.push(objectives); }
    if (priority !== undefined) { updates.push(`priority = $${paramCount++}`); values.push(priority); }
    if (color !== undefined) { updates.push(`color = $${paramCount++}`); values.push(color); }
    if (icon !== undefined) { updates.push(`icon = $${paramCount++}`); values.push(icon); }
    if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }
    if (startYear !== undefined) { updates.push(`start_year = $${paramCount++}`); values.push(startYear); }
    if (endYear !== undefined) { updates.push(`end_year = $${paramCount++}`); values.push(endYear); }

    values.push(axisId);

    const result = await db.query(
      `UPDATE sdsi_strategic_axes SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update strategic axis error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// Delete strategic axis
router.delete('/axes/:axisId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_strategic_axes WHERE id = $1', [req.params.axisId]);
    res.json({ message: 'Axe supprimé' });
  } catch (error) {
    logger.error('Delete strategic axis error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

// ==========================================
// SDSI PROJECTS
// ==========================================

// Get all SDSI projects
router.get('/projects/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { axisId, status } = req.query;

    let query = `
      SELECT p.*, 
        sa.name as axis_name, sa.color as axis_color,
        u.first_name as pm_first_name, u.last_name as pm_last_name,
        (SELECT COUNT(*) FROM sdsi_project_phases WHERE project_id = p.id) as phase_count,
        (SELECT COUNT(*) FROM sdsi_milestones WHERE project_id = p.id) as milestone_count,
        (SELECT COUNT(*) FROM sdsi_milestones WHERE project_id = p.id AND status = 'completed') as milestones_completed
      FROM sdsi_projects p
      LEFT JOIN sdsi_strategic_axes sa ON sa.id = p.axis_id
      LEFT JOIN users u ON u.id = p.project_manager
      WHERE p.workspace_id = $1
    `;
    const params = [workspaceId];

    if (axisId) {
      params.push(axisId);
      query += ` AND p.axis_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND p.status = $${params.length}`;
    }

    query += ' ORDER BY p.priority DESC, p.start_date ASC';

    const result = await db.query(query, params);

    res.json(result.rows.map(p => ({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      objectives: p.objectives,
      expectedBenefits: p.expected_benefits,
      risks: p.risks,
      axisId: p.axis_id,
      axisName: p.axis_name,
      axisColor: p.axis_color,
      boardId: p.board_id,
      priority: p.priority,
      status: p.status,
      complexity: p.complexity,
      strategicValue: p.strategic_value,
      urgency: p.urgency,
      estimatedBudget: p.estimated_budget ? parseFloat(p.estimated_budget) : null,
      actualBudget: p.actual_budget ? parseFloat(p.actual_budget) : null,
      currency: p.currency,
      startDate: p.start_date,
      endDate: p.end_date,
      actualStartDate: p.actual_start_date,
      actualEndDate: p.actual_end_date,
      progress: p.progress,
      sponsor: p.sponsor,
      projectManager: p.pm_first_name ? `${p.pm_first_name} ${p.pm_last_name}` : null,
      phaseCount: parseInt(p.phase_count),
      milestoneCount: parseInt(p.milestone_count),
      milestonesCompleted: parseInt(p.milestones_completed),
      createdAt: p.created_at,
    })));
  } catch (error) {
    logger.error('Get SDSI projects error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des projets' });
  }
});

// Get single SDSI project with details
router.get('/projects/:projectId', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;

    const projectResult = await db.query(
      `SELECT p.*, 
        sa.name as axis_name, sa.color as axis_color,
        u.first_name as pm_first_name, u.last_name as pm_last_name
       FROM sdsi_projects p
       LEFT JOIN sdsi_strategic_axes sa ON sa.id = p.axis_id
       LEFT JOIN users u ON u.id = p.project_manager
       WHERE p.id = $1`,
      [projectId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }

    const project = projectResult.rows[0];

    // Get phases
    const phasesResult = await db.query(
      'SELECT * FROM sdsi_project_phases WHERE project_id = $1 ORDER BY position',
      [projectId]
    );

    // Get milestones
    const milestonesResult = await db.query(
      'SELECT * FROM sdsi_milestones WHERE project_id = $1 ORDER BY due_date',
      [projectId]
    );

    // Get resource allocations
    const allocationsResult = await db.query(
      `SELECT ra.*, r.name as resource_name, r.type as resource_type
       FROM sdsi_resource_allocations ra
       JOIN sdsi_resources r ON r.id = ra.resource_id
       WHERE ra.project_id = $1`,
      [projectId]
    );

    // Get risks
    const risksResult = await db.query(
      'SELECT * FROM sdsi_risks WHERE project_id = $1 ORDER BY score DESC',
      [projectId]
    );

    res.json({
      ...formatProject(project),
      phases: phasesResult.rows.map(ph => ({
        id: ph.id,
        name: ph.name,
        description: ph.description,
        startDate: ph.start_date,
        endDate: ph.end_date,
        status: ph.status,
        progress: ph.progress,
        deliverables: ph.deliverables,
      })),
      milestones: milestonesResult.rows.map(m => ({
        id: m.id,
        name: m.name,
        description: m.description,
        dueDate: m.due_date,
        completedDate: m.completed_date,
        status: m.status,
        isCritical: m.is_critical,
      })),
      allocations: allocationsResult.rows.map(a => ({
        id: a.id,
        resourceId: a.resource_id,
        resourceName: a.resource_name,
        resourceType: a.resource_type,
        percentage: parseFloat(a.allocation_percentage),
        startDate: a.start_date,
        endDate: a.end_date,
        role: a.role,
      })),
      risks: risksResult.rows.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        probability: r.probability,
        impact: r.impact,
        score: r.score,
        status: r.status,
        mitigationStrategy: r.mitigation_strategy,
      })),
    });
  } catch (error) {
    logger.error('Get SDSI project error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

function formatProject(p) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    objectives: p.objectives,
    expectedBenefits: p.expected_benefits,
    risks: p.risks,
    dependencies: p.dependencies,
    axisId: p.axis_id,
    axisName: p.axis_name,
    axisColor: p.axis_color,
    boardId: p.board_id,
    priority: p.priority,
    status: p.status,
    complexity: p.complexity,
    strategicValue: p.strategic_value,
    urgency: p.urgency,
    estimatedBudget: p.estimated_budget ? parseFloat(p.estimated_budget) : null,
    actualBudget: p.actual_budget ? parseFloat(p.actual_budget) : null,
    currency: p.currency,
    startDate: p.start_date,
    endDate: p.end_date,
    actualStartDate: p.actual_start_date,
    actualEndDate: p.actual_end_date,
    progress: p.progress,
    sponsor: p.sponsor,
    projectManager: p.pm_first_name ? `${p.pm_first_name} ${p.pm_last_name}` : null,
    projectManagerId: p.project_manager,
    createdAt: p.created_at,
  };
}

// Create SDSI project
router.post('/projects', authenticate, [
  body('workspaceId').isUUID(),
  body('name').trim().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      workspaceId, axisId, boardId, code, name, description, objectives,
      expectedBenefits, risks, dependencies, priority, status, complexity,
      strategicValue, urgency, estimatedBudget, currency, startDate, endDate,
      sponsor, projectManagerId
    } = req.body;

    const result = await db.query(
      `INSERT INTO sdsi_projects (
        workspace_id, axis_id, board_id, code, name, description, objectives,
        expected_benefits, risks, dependencies, priority, status, complexity,
        strategic_value, urgency, estimated_budget, currency, start_date, end_date,
        sponsor, project_manager, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *`,
      [
        workspaceId, axisId || null, boardId || null, code, name, description, objectives,
        expectedBenefits, risks, dependencies, priority || 'medium', status || 'planned',
        complexity || 'medium', strategicValue || 5, urgency || 5, estimatedBudget || null,
        currency || 'XAF', parseDate(startDate), parseDate(endDate), sponsor, projectManagerId, req.userId
      ]
    );

    res.status(201).json(formatProject(result.rows[0]));
  } catch (error) {
    logger.error('Create SDSI project error:', error);
    res.status(500).json({ error: 'Erreur lors de la création' });
  }
});

// Update SDSI project
router.put('/projects/:projectId', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const updates = [];
    const values = [];
    let paramCount = 1;

    const fields = [
      'axis_id', 'board_id', 'code', 'name', 'description', 'objectives',
      'expected_benefits', 'risks', 'dependencies', 'priority', 'status',
      'complexity', 'strategic_value', 'urgency', 'estimated_budget', 'actual_budget',
      'currency', 'start_date', 'end_date', 'actual_start_date', 'actual_end_date',
      'progress', 'sponsor', 'project_manager'
    ];

    const bodyFields = {
      axis_id: 'axisId', board_id: 'boardId', expected_benefits: 'expectedBenefits',
      strategic_value: 'strategicValue', estimated_budget: 'estimatedBudget',
      actual_budget: 'actualBudget', start_date: 'startDate', end_date: 'endDate',
      actual_start_date: 'actualStartDate', actual_end_date: 'actualEndDate',
      project_manager: 'projectManagerId'
    };

    for (const field of fields) {
      const bodyKey = bodyFields[field] || field;
      if (req.body[bodyKey] !== undefined) {
        updates.push(`${field} = $${paramCount++}`);
        values.push(req.body[bodyKey]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(projectId);

    const result = await db.query(
      `UPDATE sdsi_projects SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(formatProject(result.rows[0]));
  } catch (error) {
    logger.error('Update SDSI project error:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour' });
  }
});

// Delete SDSI project
router.delete('/projects/:projectId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_projects WHERE id = $1', [req.params.projectId]);
    res.json({ message: 'Projet supprimé' });
  } catch (error) {
    logger.error('Delete SDSI project error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// PROJECT PHASES
// ==========================================

// Get phases by workspace
router.get('/phases/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { projectId } = req.query;

    let query = `
      SELECT ph.*, p.name as project_name, p.code as project_code
      FROM sdsi_project_phases ph
      JOIN sdsi_projects p ON p.id = ph.project_id
      WHERE p.workspace_id = $1
    `;
    const params = [workspaceId];

    if (projectId) {
      params.push(projectId);
      query += ` AND ph.project_id = $${params.length}`;
    }

    query += ' ORDER BY p.name, ph.position';

    const result = await db.query(query, params);

    res.json(result.rows.map(ph => ({
      id: ph.id,
      projectId: ph.project_id,
      projectName: ph.project_name,
      projectCode: ph.project_code,
      name: ph.name,
      description: ph.description,
      startDate: ph.start_date,
      endDate: ph.end_date,
      status: ph.status,
      progress: ph.progress,
      deliverables: ph.deliverables,
      position: ph.position,
    })));
  } catch (error) {
    logger.error('Get phases error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/projects/:projectId/phases', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name, description, startDate, endDate, deliverables } = req.body;

    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM sdsi_project_phases WHERE project_id = $1',
      [projectId]
    );

    const result = await db.query(
      `INSERT INTO sdsi_project_phases (project_id, name, description, start_date, end_date, deliverables, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [projectId, name, description, parseDate(startDate), parseDate(endDate), deliverables, posResult.rows[0].next_pos]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create phase error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update phase
router.put('/phases/:phaseId', authenticate, async (req, res) => {
  try {
    const { phaseId } = req.params;
    const { name, description, startDate, endDate, status, progress, deliverables } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (startDate !== undefined) { updates.push(`start_date = $${paramCount++}`); values.push(parseDate(startDate)); }
    if (endDate !== undefined) { updates.push(`end_date = $${paramCount++}`); values.push(parseDate(endDate)); }
    if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }
    if (progress !== undefined) { updates.push(`progress = $${paramCount++}`); values.push(progress); }
    if (deliverables !== undefined) { updates.push(`deliverables = $${paramCount++}`); values.push(deliverables); }

    // Auto-set progress to 100 if status is completed
    if (status === 'completed' && progress === undefined) {
      updates.push(`progress = $${paramCount++}`);
      values.push(100);
    }

    values.push(phaseId);

    const result = await db.query(
      `UPDATE sdsi_project_phases SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const phase = result.rows[0];

    // Auto-sync project progress after phase update
    if (phase && phase.project_id) {
      const progressResult = await db.query(`
        SELECT COALESCE(AVG(
          CASE WHEN status = 'completed' THEN 100 
               WHEN status = 'in_progress' THEN COALESCE(progress, 50)
               ELSE 0 END
        ), 0)::integer as calculated_progress
        FROM sdsi_project_phases WHERE project_id = $1
      `, [phase.project_id]);

      const newProjectProgress = progressResult.rows[0].calculated_progress;
      
      await db.query(
        'UPDATE sdsi_projects SET progress = $1, updated_at = NOW() WHERE id = $2',
        [newProjectProgress, phase.project_id]
      );

      logger.info(`Project ${phase.project_id} progress auto-updated to ${newProjectProgress}%`);

      // Also sync KPIs linked to this project
      const kpisResult = await db.query(
        'SELECT * FROM sdsi_kpis WHERE project_id = $1 AND calculation_method IS NOT NULL',
        [phase.project_id]
      );

      for (const kpi of kpisResult.rows) {
        const method = kpi.calculation_method;
        if (KPI_CALCULATIONS[method]) {
          try {
            const newValue = await KPI_CALCULATIONS[method](kpi, db);
            if (newValue !== null) {
              const oldValue = kpi.current_value;
              let trend = 'stable';
              if (oldValue !== null) {
                if (newValue > oldValue) trend = 'up';
                else if (newValue < oldValue) trend = 'down';
              }
              
              await db.query(
                'UPDATE sdsi_kpis SET current_value = $1, trend = $2, updated_at = NOW() WHERE id = $3',
                [newValue, trend, kpi.id]
              );
              
              // Insert into KPI values history
              await db.query(
                `INSERT INTO sdsi_kpi_values (kpi_id, value, recorded_at, notes, created_by)
                 VALUES ($1, $2, NOW(), 'Sync phase update', $3)`,
                [kpi.id, newValue, req.userId]
              );
              
              logger.info(`KPI ${kpi.id} auto-synced: ${oldValue} -> ${newValue}%`);
            }
          } catch (e) {
            logger.warn(`Failed to auto-sync KPI ${kpi.id}:`, e.message);
          }
        }
      }
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update phase error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete phase
router.delete('/phases/:phaseId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_project_phases WHERE id = $1', [req.params.phaseId]);
    res.json({ message: 'Phase supprimée' });
  } catch (error) {
    logger.error('Delete phase error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// PROJECT EXPENSES (Dépenses par projet)
// ==========================================

// Get expenses for a project
router.get('/projects/:projectId/expenses', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await db.query(
      `SELECT e.*, u.first_name, u.last_name
       FROM sdsi_project_expenses e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.project_id = $1
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      [projectId]
    );

    res.json(result.rows.map(e => ({
      id: e.id,
      projectId: e.project_id,
      category: e.category,
      description: e.description,
      amount: parseFloat(e.amount),
      expenseDate: e.expense_date,
      vendor: e.vendor,
      invoiceNumber: e.invoice_number,
      notes: e.notes,
      status: e.status,
      createdBy: e.first_name ? `${e.first_name} ${e.last_name}` : null,
      createdAt: e.created_at,
    })));
  } catch (error) {
    logger.error('Get project expenses error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Add expense to project
router.post('/projects/:projectId/expenses', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { category, description, amount, expenseDate, vendor, invoiceNumber, notes, status } = req.body;

    if (!description || !amount) {
      return res.status(400).json({ error: 'Description et montant requis' });
    }

    const result = await db.query(
      `INSERT INTO sdsi_project_expenses 
        (project_id, category, description, amount, expense_date, vendor, invoice_number, notes, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        projectId, category || 'Autre', description, amount, 
        expenseDate || new Date(), vendor || null, invoiceNumber || null, 
        notes || null, status || 'approved', req.userId
      ]
    );

    const e = result.rows[0];
    
    // Get updated project budget
    const projectResult = await db.query(
      'SELECT actual_budget, estimated_budget FROM sdsi_projects WHERE id = $1',
      [projectId]
    );

    logger.info(`Expense added to project ${projectId}: ${amount} XAF`);

    res.status(201).json({
      expense: {
        id: e.id,
        projectId: e.project_id,
        category: e.category,
        description: e.description,
        amount: parseFloat(e.amount),
        expenseDate: e.expense_date,
        vendor: e.vendor,
        invoiceNumber: e.invoice_number,
        notes: e.notes,
        status: e.status,
        createdAt: e.created_at,
      },
      projectBudget: {
        actual: parseFloat(projectResult.rows[0]?.actual_budget || 0),
        estimated: parseFloat(projectResult.rows[0]?.estimated_budget || 0),
      }
    });
  } catch (error) {
    logger.error('Add expense error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'ajout de la dépense' });
  }
});

// Update expense
router.put('/expenses/:expenseId', authenticate, async (req, res) => {
  try {
    const { expenseId } = req.params;
    const { category, description, amount, expenseDate, vendor, invoiceNumber, notes, status } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (category !== undefined) { updates.push(`category = $${paramCount++}`); values.push(category); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (amount !== undefined) { updates.push(`amount = $${paramCount++}`); values.push(amount); }
    if (expenseDate !== undefined) { updates.push(`expense_date = $${paramCount++}`); values.push(expenseDate); }
    if (vendor !== undefined) { updates.push(`vendor = $${paramCount++}`); values.push(vendor); }
    if (invoiceNumber !== undefined) { updates.push(`invoice_number = $${paramCount++}`); values.push(invoiceNumber); }
    if (notes !== undefined) { updates.push(`notes = $${paramCount++}`); values.push(notes); }
    if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(expenseId);

    const result = await db.query(
      `UPDATE sdsi_project_expenses SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dépense non trouvée' });
    }

    const e = result.rows[0];
    res.json({
      id: e.id,
      projectId: e.project_id,
      category: e.category,
      description: e.description,
      amount: parseFloat(e.amount),
      expenseDate: e.expense_date,
      vendor: e.vendor,
      invoiceNumber: e.invoice_number,
      notes: e.notes,
      status: e.status,
    });
  } catch (error) {
    logger.error('Update expense error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete expense
router.delete('/expenses/:expenseId', authenticate, async (req, res) => {
  try {
    const { expenseId } = req.params;
    
    const result = await db.query(
      'DELETE FROM sdsi_project_expenses WHERE id = $1 RETURNING project_id',
      [expenseId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dépense non trouvée' });
    }

    res.json({ message: 'Dépense supprimée' });
  } catch (error) {
    logger.error('Delete expense error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get expense categories for dropdown
router.get('/expense-categories', authenticate, (req, res) => {
  const categories = [
    { id: 'licenses', name: 'Licences & Logiciels', icon: '💿' },
    { id: 'hardware', name: 'Matériel & Équipements', icon: '🖥️' },
    { id: 'services', name: 'Services & Prestations', icon: '👥' },
    { id: 'training', name: 'Formation', icon: '📚' },
    { id: 'infrastructure', name: 'Infrastructure', icon: '🏗️' },
    { id: 'maintenance', name: 'Maintenance', icon: '🔧' },
    { id: 'consulting', name: 'Conseil & Expertise', icon: '💼' },
    { id: 'cloud', name: 'Services Cloud', icon: '☁️' },
    { id: 'security', name: 'Sécurité', icon: '🔒' },
    { id: 'other', name: 'Autre', icon: '📋' },
  ];
  res.json(categories);
});

// ==========================================
// MILESTONES
// ==========================================

// Get milestones by workspace
router.get('/milestones/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { projectId, status } = req.query;

    let query = `
      SELECT m.*, p.name as project_name, p.code as project_code,
             ph.name as phase_name
      FROM sdsi_milestones m
      JOIN sdsi_projects p ON p.id = m.project_id
      LEFT JOIN sdsi_project_phases ph ON ph.id = m.phase_id
      WHERE p.workspace_id = $1
    `;
    const params = [workspaceId];

    if (projectId) {
      params.push(projectId);
      query += ` AND m.project_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND m.status = $${params.length}`;
    }

    query += ' ORDER BY m.due_date ASC';

    const result = await db.query(query, params);

    res.json(result.rows.map(m => ({
      id: m.id,
      projectId: m.project_id,
      projectName: m.project_name,
      projectCode: m.project_code,
      phaseId: m.phase_id,
      phaseName: m.phase_name,
      name: m.name,
      description: m.description,
      dueDate: m.due_date,
      completedDate: m.completed_date,
      status: m.status,
      isCritical: m.is_critical,
    })));
  } catch (error) {
    logger.error('Get milestones error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/projects/:projectId/milestones', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { phaseId, name, description, dueDate, isCritical } = req.body;

    const result = await db.query(
      `INSERT INTO sdsi_milestones (project_id, phase_id, name, description, due_date, is_critical)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [projectId, phaseId || null, name, description, dueDate, isCritical || false]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create milestone error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.put('/milestones/:milestoneId', authenticate, async (req, res) => {
  try {
    const { milestoneId } = req.params;
    const { name, description, dueDate, status, completedDate, isCritical, phaseId } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (dueDate !== undefined) { updates.push(`due_date = $${paramCount++}`); values.push(dueDate); }
    if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }
    if (completedDate !== undefined) { updates.push(`completed_date = $${paramCount++}`); values.push(completedDate); }
    if (isCritical !== undefined) { updates.push(`is_critical = $${paramCount++}`); values.push(isCritical); }
    if (phaseId !== undefined) { updates.push(`phase_id = $${paramCount++}`); values.push(phaseId); }

    values.push(milestoneId);

    const result = await db.query(
      `UPDATE sdsi_milestones SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update milestone error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete milestone
router.delete('/milestones/:milestoneId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_milestones WHERE id = $1', [req.params.milestoneId]);
    res.json({ message: 'Jalon supprimé' });
  } catch (error) {
    logger.error('Delete milestone error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// RISKS
// ==========================================

// Get risks by workspace
router.get('/risks/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { projectId, status } = req.query;

    let query = `
      SELECT r.*, p.name as project_name, p.code as project_code
      FROM sdsi_risks r
      JOIN sdsi_projects p ON p.id = r.project_id
      WHERE p.workspace_id = $1
    `;
    const params = [workspaceId];

    if (projectId) {
      params.push(projectId);
      query += ` AND r.project_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND r.status = $${params.length}`;
    }

    query += ' ORDER BY r.score DESC, r.created_at DESC';

    const result = await db.query(query, params);

    res.json(result.rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      projectCode: r.project_code,
      name: r.name,
      description: r.description,
      category: r.category,
      probability: r.probability,
      impact: r.impact,
      score: r.score,
      status: r.status,
      mitigationStrategy: r.mitigation_strategy,
      owner: r.owner,
      identifiedDate: r.identified_date,
      reviewDate: r.review_date,
      createdAt: r.created_at,
    })));
  } catch (error) {
    logger.error('Get risks error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Create risk
router.post('/projects/:projectId/risks', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name, description, category, probability, impact, mitigationStrategy, owner } = req.body;

    const score = (probability || 3) * (impact || 3);

    const result = await db.query(
      `INSERT INTO sdsi_risks (project_id, name, description, category, probability, impact, score, mitigation_strategy, owner, identified_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE) RETURNING *`,
      [projectId, name, description, category || 'operational', probability || 3, impact || 3, score, mitigationStrategy, owner]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create risk error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update risk
router.put('/risks/:riskId', authenticate, async (req, res) => {
  try {
    const { riskId } = req.params;
    const { name, description, category, probability, impact, status, mitigationStrategy, owner, reviewDate } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (category !== undefined) { updates.push(`category = $${paramCount++}`); values.push(category); }
    if (probability !== undefined) { updates.push(`probability = $${paramCount++}`); values.push(probability); }
    if (impact !== undefined) { updates.push(`impact = $${paramCount++}`); values.push(impact); }
    if (probability !== undefined || impact !== undefined) {
      const p = probability || 3;
      const i = impact || 3;
      updates.push(`score = $${paramCount++}`);
      values.push(p * i);
    }
    if (status !== undefined) { updates.push(`status = $${paramCount++}`); values.push(status); }
    if (mitigationStrategy !== undefined) { updates.push(`mitigation_strategy = $${paramCount++}`); values.push(mitigationStrategy); }
    if (owner !== undefined) { updates.push(`owner = $${paramCount++}`); values.push(owner); }
    if (reviewDate !== undefined) { updates.push(`review_date = $${paramCount++}`); values.push(reviewDate); }

    values.push(riskId);

    const result = await db.query(
      `UPDATE sdsi_risks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update risk error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete risk
router.delete('/risks/:riskId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_risks WHERE id = $1', [req.params.riskId]);
    res.json({ message: 'Risque supprimé' });
  } catch (error) {
    logger.error('Delete risk error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// APPLICATIONS INVENTORY
// ==========================================

router.get('/applications/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT a.*, p.name as replacement_project_name
       FROM sdsi_applications a
       LEFT JOIN sdsi_projects p ON p.id = a.replacement_project_id
       WHERE a.workspace_id = $1
       ORDER BY a.criticality DESC, a.name`,
      [workspaceId]
    );

    res.json(result.rows.map(app => ({
      id: app.id,
      name: app.name,
      code: app.code,
      description: app.description,
      category: app.category,
      vendor: app.vendor,
      version: app.version,
      technologyStack: app.technology_stack,
      status: app.status,
      criticality: app.criticality,
      dataSensitivity: app.data_sensitivity,
      usersCount: app.users_count,
      annualCost: app.annual_cost ? parseFloat(app.annual_cost) : null,
      currency: app.currency,
      owner: app.owner,
      technicalContact: app.technical_contact,
      goLiveDate: app.go_live_date,
      endOfLifeDate: app.end_of_life_date,
      replacementProjectId: app.replacement_project_id,
      replacementProjectName: app.replacement_project_name,
    })));
  } catch (error) {
    logger.error('Get applications error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/applications', authenticate, async (req, res) => {
  try {
    const {
      workspaceId, name, code, description, category, vendor, version,
      technologyStack, status, criticality, dataSensitivity, usersCount,
      annualCost, currency, owner, technicalContact, goLiveDate, endOfLifeDate
    } = req.body;

    const result = await db.query(
      `INSERT INTO sdsi_applications (
        workspace_id, name, code, description, category, vendor, version,
        technology_stack, status, criticality, data_sensitivity, users_count,
        annual_cost, currency, owner, technical_contact, go_live_date, end_of_life_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        workspaceId, name, code, description, category, vendor, version,
        technologyStack, status || 'production', criticality || 'medium',
        dataSensitivity || 'internal', usersCount || null, annualCost || null, currency || 'XAF',
        owner, technicalContact, parseDate(goLiveDate), parseDate(endOfLifeDate)
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create application error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// KPIs
// ==========================================

router.get('/kpis/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT k.*, 
        sa.name as axis_name,
        p.name as project_name,
        (SELECT value FROM sdsi_kpi_values WHERE kpi_id = k.id ORDER BY recorded_at DESC LIMIT 1) as latest_value
       FROM sdsi_kpis k
       LEFT JOIN sdsi_strategic_axes sa ON sa.id = k.axis_id
       LEFT JOIN sdsi_projects p ON p.id = k.project_id
       WHERE k.workspace_id = $1
       ORDER BY k.category, k.name`,
      [workspaceId]
    );

    res.json(result.rows.map(k => ({
      id: k.id,
      name: k.name,
      description: k.description,
      category: k.category,
      unit: k.unit,
      targetValue: k.target_value !== null ? parseFloat(k.target_value) : null,
      currentValue: k.latest_value !== null ? parseFloat(k.latest_value) : (k.current_value !== null ? parseFloat(k.current_value) : 0),
      baselineValue: k.baseline_value !== null ? parseFloat(k.baseline_value) : null,
      minThreshold: k.min_threshold !== null ? parseFloat(k.min_threshold) : null,
      maxThreshold: k.max_threshold !== null ? parseFloat(k.max_threshold) : null,
      trend: k.trend,
      frequency: k.frequency,
      calculationMethod: k.calculation_method,
      dataSource: k.data_source,
      axisId: k.axis_id,
      axisName: k.axis_name,
      projectId: k.project_id,
      projectName: k.project_name,
      isAutomatic: !!k.calculation_method,
    })));
  } catch (error) {
    logger.error('Get KPIs error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/kpis', authenticate, async (req, res) => {
  try {
    const {
      workspaceId, axisId, projectId, name, description, category, unit,
      targetValue, currentValue, baselineValue, minThreshold, maxThreshold,
      frequency, dataSource, calculationMethod
    } = req.body;

    const result = await db.query(
      `INSERT INTO sdsi_kpis (
        workspace_id, axis_id, project_id, name, description, category, unit,
        target_value, current_value, baseline_value, min_threshold, max_threshold,
        frequency, data_source, calculation_method, responsible
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        workspaceId, axisId, projectId, name, description, category, unit,
        targetValue, currentValue || 0, baselineValue, minThreshold, maxThreshold,
        frequency || 'monthly', dataSource, calculationMethod || null, req.userId
      ]
    );

    const k = result.rows[0];
    let syncedValue = k.current_value;
    
    // Auto-sync if calculation method is set
    if (calculationMethod && KPI_CALCULATIONS[calculationMethod]) {
      try {
        const calculatedValue = await KPI_CALCULATIONS[calculationMethod](k, db);
        if (calculatedValue !== null) {
          await db.query(
            'UPDATE sdsi_kpis SET current_value = $1 WHERE id = $2',
            [calculatedValue, k.id]
          );
          syncedValue = calculatedValue;
          logger.info(`KPI ${k.id} auto-synced on creation: ${calculatedValue}`);
        }
      } catch (e) {
        logger.warn(`Failed to auto-sync KPI ${k.id} on creation:`, e.message);
      }
    }
    
    // Format response properly
    res.status(201).json({
      id: k.id,
      name: k.name,
      description: k.description,
      category: k.category,
      unit: k.unit,
      targetValue: k.target_value ? parseFloat(k.target_value) : null,
      currentValue: syncedValue ? parseFloat(syncedValue) : 0,
      baselineValue: k.baseline_value ? parseFloat(k.baseline_value) : null,
      minThreshold: k.min_threshold ? parseFloat(k.min_threshold) : null,
      maxThreshold: k.max_threshold ? parseFloat(k.max_threshold) : null,
      trend: k.trend,
      frequency: k.frequency,
      calculationMethod: k.calculation_method,
      dataSource: k.data_source,
      axisId: k.axis_id,
      projectId: k.project_id,
      isAutomatic: !!k.calculation_method,
      createdAt: k.created_at,
    });
  } catch (error) {
    logger.error('Create KPI error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/kpis/:kpiId/values', authenticate, async (req, res) => {
  try {
    const { kpiId } = req.params;
    const { value, recordedAt, notes } = req.body;

    const result = await db.query(
      `INSERT INTO sdsi_kpi_values (kpi_id, value, recorded_at, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [kpiId, value, recordedAt || new Date(), notes, req.userId]
    );

    // Update current value and trend in KPI
    await db.query(`
      UPDATE sdsi_kpis SET 
        current_value = $1,
        trend = CASE 
          WHEN current_value IS NULL THEN 'stable'
          WHEN $1 > current_value THEN 'up'
          WHEN $1 < current_value THEN 'down'
          ELSE 'stable'
        END
      WHERE id = $2
    `, [value, kpiId]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Add KPI value error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// KPI AUTOMATION - Calculate values from project progress
// ==========================================

// Define calculation methods for KPIs
const KPI_CALCULATIONS = {
  // Average progress of linked project
  'project_progress': async (kpi, db) => {
    if (!kpi.project_id) return null;
    const result = await db.query(
      'SELECT progress FROM sdsi_projects WHERE id = $1',
      [kpi.project_id]
    );
    return result.rows[0]?.progress || 0;
  },

  // Percentage of completed milestones for linked project
  'milestones_completion': async (kpi, db) => {
    if (!kpi.project_id) return null;
    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
      FROM sdsi_milestones WHERE project_id = $1
    `, [kpi.project_id]);
    const { total, completed } = result.rows[0];
    return total > 0 ? Math.round((completed / total) * 100) : 0;
  },

  // Percentage of completed phases for linked project
  'phases_completion': async (kpi, db) => {
    if (!kpi.project_id) return null;
    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
      FROM sdsi_project_phases WHERE project_id = $1
    `, [kpi.project_id]);
    const { total, completed } = result.rows[0];
    return total > 0 ? Math.round((completed / total) * 100) : 0;
  },

  // Average phases progress
  'phases_avg_progress': async (kpi, db) => {
    if (!kpi.project_id) return null;
    const result = await db.query(
      'SELECT COALESCE(AVG(progress), 0) as avg_progress FROM sdsi_project_phases WHERE project_id = $1',
      [kpi.project_id]
    );
    return Math.round(result.rows[0].avg_progress);
  },

  // Budget consumption percentage
  'budget_consumption': async (kpi, db) => {
    if (!kpi.project_id) return null;
    const result = await db.query(
      'SELECT estimated_budget, actual_budget FROM sdsi_projects WHERE id = $1',
      [kpi.project_id]
    );
    const p = result.rows[0];
    if (!p || !p.estimated_budget || p.estimated_budget === 0) return 0;
    return Math.round((p.actual_budget || 0) / p.estimated_budget * 100);
  },

  // Risk score (average)
  'risk_score_avg': async (kpi, db) => {
    if (!kpi.project_id) return null;
    const result = await db.query(
      `SELECT COALESCE(AVG(score), 0) as avg_score FROM sdsi_risks 
       WHERE project_id = $1 AND status = 'active'`,
      [kpi.project_id]
    );
    return Math.round(result.rows[0].avg_score);
  },

  // Critical milestones on time (percentage)
  'critical_milestones_on_time': async (kpi, db) => {
    if (!kpi.project_id) return null;
    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed' AND (completed_date IS NULL OR completed_date <= due_date)) as on_time
      FROM sdsi_milestones 
      WHERE project_id = $1 AND is_critical = true
    `, [kpi.project_id]);
    const { total, on_time } = result.rows[0];
    return total > 0 ? Math.round((on_time / total) * 100) : 100;
  },

  // Average progress of all projects in an axis
  'axis_projects_progress': async (kpi, db) => {
    if (!kpi.axis_id) return null;
    const result = await db.query(
      'SELECT COALESCE(AVG(progress), 0) as avg_progress FROM sdsi_projects WHERE axis_id = $1',
      [kpi.axis_id]
    );
    return Math.round(result.rows[0].avg_progress);
  },

  // Projects completion rate for an axis
  'axis_projects_completion': async (kpi, db) => {
    if (!kpi.axis_id) return null;
    const result = await db.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed
      FROM sdsi_projects WHERE axis_id = $1
    `, [kpi.axis_id]);
    const { total, completed } = result.rows[0];
    return total > 0 ? Math.round((completed / total) * 100) : 0;
  },
};

// Sync a single KPI value based on calculation method
router.post('/kpis/:kpiId/sync', authenticate, async (req, res) => {
  try {
    const { kpiId } = req.params;

    // Get KPI details
    const kpiResult = await db.query('SELECT * FROM sdsi_kpis WHERE id = $1', [kpiId]);
    if (kpiResult.rows.length === 0) {
      return res.status(404).json({ error: 'KPI non trouvé' });
    }

    const kpi = kpiResult.rows[0];
    const method = kpi.calculation_method;

    if (!method || !KPI_CALCULATIONS[method]) {
      return res.status(400).json({ 
        error: 'Méthode de calcul non définie ou non supportée',
        supportedMethods: Object.keys(KPI_CALCULATIONS)
      });
    }

    // Calculate value
    const newValue = await KPI_CALCULATIONS[method](kpi, db);

    if (newValue === null) {
      return res.status(400).json({ error: 'Impossible de calculer la valeur (projet/axe non lié)' });
    }

    // Determine trend
    const oldValue = kpi.current_value;
    let trend = 'stable';
    if (oldValue !== null) {
      if (newValue > oldValue) trend = 'up';
      else if (newValue < oldValue) trend = 'down';
    }

    // Update KPI
    await db.query(`
      UPDATE sdsi_kpis SET current_value = $1, trend = $2, updated_at = NOW() WHERE id = $3
    `, [newValue, trend, kpiId]);

    // Record history
    await db.query(`
      INSERT INTO sdsi_kpi_values (kpi_id, value, recorded_at, notes, created_by)
      VALUES ($1, $2, NOW(), 'Calcul automatique', $3)
    `, [kpiId, newValue, req.userId]);

    logger.info(`KPI ${kpiId} synced: ${oldValue} -> ${newValue} (${method})`);

    res.json({
      message: 'KPI synchronisé',
      kpiId,
      previousValue: oldValue,
      newValue,
      trend,
      method,
    });
  } catch (error) {
    logger.error('Sync KPI error:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

// Sync all KPIs for a project (called when project is updated)
router.post('/projects/:projectId/sync-kpis', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;

    // Get all KPIs linked to this project
    const kpisResult = await db.query(
      'SELECT * FROM sdsi_kpis WHERE project_id = $1 AND calculation_method IS NOT NULL',
      [projectId]
    );

    const results = [];

    for (const kpi of kpisResult.rows) {
      const method = kpi.calculation_method;
      if (KPI_CALCULATIONS[method]) {
        try {
          const newValue = await KPI_CALCULATIONS[method](kpi, db);
          if (newValue !== null) {
            const oldValue = kpi.current_value;
            let trend = 'stable';
            if (oldValue !== null) {
              if (newValue > oldValue) trend = 'up';
              else if (newValue < oldValue) trend = 'down';
            }

            await db.query(`
              UPDATE sdsi_kpis SET current_value = $1, trend = $2, updated_at = NOW() WHERE id = $3
            `, [newValue, trend, kpi.id]);

            await db.query(`
              INSERT INTO sdsi_kpi_values (kpi_id, value, recorded_at, notes, created_by)
              VALUES ($1, $2, NOW(), 'Sync auto projet', $3)
            `, [kpi.id, newValue, req.userId]);

            results.push({ kpiId: kpi.id, name: kpi.name, oldValue, newValue, trend });
          }
        } catch (e) {
          logger.warn(`Failed to sync KPI ${kpi.id}:`, e.message);
        }
      }
    }

    res.json({
      message: 'KPIs synchronisés',
      projectId,
      synced: results.length,
      results,
    });
  } catch (error) {
    logger.error('Sync project KPIs error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Sync all KPIs for a workspace
router.post('/kpis/workspace/:workspaceId/sync-all', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Get all KPIs with calculation methods
    const kpisResult = await db.query(
      'SELECT * FROM sdsi_kpis WHERE workspace_id = $1 AND calculation_method IS NOT NULL',
      [workspaceId]
    );

    const results = [];
    let synced = 0;
    let failed = 0;

    for (const kpi of kpisResult.rows) {
      const method = kpi.calculation_method;
      if (KPI_CALCULATIONS[method]) {
        try {
          const newValue = await KPI_CALCULATIONS[method](kpi, db);
          if (newValue !== null) {
            const oldValue = kpi.current_value;
            let trend = 'stable';
            if (oldValue !== null) {
              if (newValue > oldValue) trend = 'up';
              else if (newValue < oldValue) trend = 'down';
            }

            await db.query(`
              UPDATE sdsi_kpis SET current_value = $1, trend = $2, updated_at = NOW() WHERE id = $3
            `, [newValue, trend, kpi.id]);

            await db.query(`
              INSERT INTO sdsi_kpi_values (kpi_id, value, recorded_at, notes, created_by)
              VALUES ($1, $2, NOW(), 'Sync global', $3)
            `, [kpi.id, newValue, req.userId]);

            results.push({ kpiId: kpi.id, name: kpi.name, oldValue, newValue, trend });
            synced++;
          }
        } catch (e) {
          logger.warn(`Failed to sync KPI ${kpi.id}:`, e.message);
          failed++;
        }
      }
    }

    logger.info(`Workspace ${workspaceId}: ${synced} KPIs synced, ${failed} failed`);

    res.json({
      message: 'Synchronisation terminée',
      total: kpisResult.rows.length,
      synced,
      failed,
      results,
    });
  } catch (error) {
    logger.error('Sync all KPIs error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get available calculation methods
router.get('/kpis/calculation-methods', authenticate, (req, res) => {
  const methods = [
    { id: 'project_progress', name: 'Progression du projet', description: 'Récupère le pourcentage d\'avancement du projet lié', requiresProject: true },
    { id: 'milestones_completion', name: 'Jalons complétés', description: 'Pourcentage de jalons terminés', requiresProject: true },
    { id: 'phases_completion', name: 'Phases complétées', description: 'Pourcentage de phases terminées', requiresProject: true },
    { id: 'phases_avg_progress', name: 'Progression moyenne des phases', description: 'Moyenne de progression de toutes les phases', requiresProject: true },
    { id: 'budget_consumption', name: 'Consommation budget', description: 'Pourcentage du budget consommé', requiresProject: true },
    { id: 'risk_score_avg', name: 'Score risque moyen', description: 'Score moyen des risques actifs', requiresProject: true },
    { id: 'critical_milestones_on_time', name: 'Jalons critiques à temps', description: 'Pourcentage de jalons critiques livrés à temps', requiresProject: true },
    { id: 'axis_projects_progress', name: 'Progression axe', description: 'Progression moyenne des projets de l\'axe', requiresAxis: true },
    { id: 'axis_projects_completion', name: 'Projets axe terminés', description: 'Pourcentage de projets terminés dans l\'axe', requiresAxis: true },
  ];
  res.json(methods);
});

// Update KPI (including calculation method)
router.put('/kpis/:kpiId', authenticate, async (req, res) => {
  try {
    const { kpiId } = req.params;
    const { 
      name, description, category, unit, targetValue, currentValue,
      baselineValue, minThreshold, maxThreshold, frequency, calculationMethod,
      axisId, projectId
    } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (category !== undefined) { updates.push(`category = $${paramCount++}`); values.push(category); }
    if (unit !== undefined) { updates.push(`unit = $${paramCount++}`); values.push(unit); }
    if (targetValue !== undefined) { updates.push(`target_value = $${paramCount++}`); values.push(targetValue); }
    if (currentValue !== undefined) { updates.push(`current_value = $${paramCount++}`); values.push(currentValue); }
    if (baselineValue !== undefined) { updates.push(`baseline_value = $${paramCount++}`); values.push(baselineValue); }
    if (minThreshold !== undefined) { updates.push(`min_threshold = $${paramCount++}`); values.push(minThreshold); }
    if (maxThreshold !== undefined) { updates.push(`max_threshold = $${paramCount++}`); values.push(maxThreshold); }
    if (frequency !== undefined) { updates.push(`frequency = $${paramCount++}`); values.push(frequency); }
    if (calculationMethod !== undefined) { updates.push(`calculation_method = $${paramCount++}`); values.push(calculationMethod || null); }
    if (axisId !== undefined) { updates.push(`axis_id = $${paramCount++}`); values.push(axisId || null); }
    if (projectId !== undefined) { updates.push(`project_id = $${paramCount++}`); values.push(projectId || null); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    }

    values.push(kpiId);

    const result = await db.query(
      `UPDATE sdsi_kpis SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const k = result.rows[0];
    
    // Get linked names
    let axisName = null;
    let projectName = null;
    
    if (k.axis_id) {
      const axisRes = await db.query('SELECT name FROM sdsi_strategic_axes WHERE id = $1', [k.axis_id]);
      axisName = axisRes.rows[0]?.name;
    }
    if (k.project_id) {
      const projRes = await db.query('SELECT name FROM sdsi_projects WHERE id = $1', [k.project_id]);
      projectName = projRes.rows[0]?.name;
    }

    res.json({
      id: k.id,
      name: k.name,
      description: k.description,
      category: k.category,
      unit: k.unit,
      targetValue: k.target_value ? parseFloat(k.target_value) : null,
      currentValue: k.current_value ? parseFloat(k.current_value) : null,
      baselineValue: k.baseline_value ? parseFloat(k.baseline_value) : null,
      minThreshold: k.min_threshold ? parseFloat(k.min_threshold) : null,
      maxThreshold: k.max_threshold ? parseFloat(k.max_threshold) : null,
      trend: k.trend,
      frequency: k.frequency,
      calculationMethod: k.calculation_method,
      dataSource: k.data_source,
      axisId: k.axis_id,
      axisName,
      projectId: k.project_id,
      projectName,
      isAutomatic: !!k.calculation_method,
      updatedAt: k.updated_at,
    });
  } catch (error) {
    logger.error('Update KPI error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete KPI
router.delete('/kpis/:kpiId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_kpi_values WHERE kpi_id = $1', [req.params.kpiId]);
    await db.query('DELETE FROM sdsi_kpis WHERE id = $1', [req.params.kpiId]);
    res.json({ message: 'KPI supprimé' });
  } catch (error) {
    logger.error('Delete KPI error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get KPI history
router.get('/kpis/:kpiId/history', authenticate, async (req, res) => {
  try {
    const { kpiId } = req.params;

    const result = await db.query(
      `SELECT * FROM sdsi_kpi_values WHERE kpi_id = $1 ORDER BY recorded_at DESC LIMIT 50`,
      [kpiId]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Get KPI history error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// RESOURCES
// ==========================================

router.get('/resources/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    const result = await db.query(
      `SELECT r.*,
        (SELECT COUNT(*) FROM sdsi_resource_allocations WHERE resource_id = r.id) as allocation_count,
        (SELECT SUM(allocation_percentage) FROM sdsi_resource_allocations 
         WHERE resource_id = r.id AND end_date >= CURRENT_DATE) as current_allocation
       FROM sdsi_resources r
       WHERE r.workspace_id = $1
       ORDER BY r.type, r.name`,
      [workspaceId]
    );

    res.json(result.rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      description: r.description,
      capacity: r.capacity ? parseFloat(r.capacity) : null,
      unit: r.unit,
      costPerUnit: r.cost_per_unit ? parseFloat(r.cost_per_unit) : null,
      currency: r.currency,
      skills: r.skills,
      allocationCount: parseInt(r.allocation_count),
      currentAllocation: r.current_allocation ? parseFloat(r.current_allocation) : 0,
    })));
  } catch (error) {
    logger.error('Get resources error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/resources', authenticate, async (req, res) => {
  try {
    const { workspaceId, name, type, description, capacity, unit, costPerUnit, currency, skills, email, phone, department } = req.body;

    const result = await db.query(
      `INSERT INTO sdsi_resources (workspace_id, name, type, description, capacity, unit, cost_per_unit, currency, skills, email, phone, department)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [workspaceId, name, type, description, capacity, unit, costPerUnit, currency || 'XAF', skills, email, phone, department]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create resource error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update resource
router.put('/resources/:resourceId', authenticate, async (req, res) => {
  try {
    const { resourceId } = req.params;
    const { name, type, description, capacity, unit, costPerUnit, currency, skills, email, phone, department } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) { updates.push(`name = $${paramCount++}`); values.push(name); }
    if (type !== undefined) { updates.push(`type = $${paramCount++}`); values.push(type); }
    if (description !== undefined) { updates.push(`description = $${paramCount++}`); values.push(description); }
    if (capacity !== undefined) { updates.push(`capacity = $${paramCount++}`); values.push(capacity); }
    if (unit !== undefined) { updates.push(`unit = $${paramCount++}`); values.push(unit); }
    if (costPerUnit !== undefined) { updates.push(`cost_per_unit = $${paramCount++}`); values.push(costPerUnit); }
    if (currency !== undefined) { updates.push(`currency = $${paramCount++}`); values.push(currency); }
    if (skills !== undefined) { updates.push(`skills = $${paramCount++}`); values.push(skills); }
    if (email !== undefined) { updates.push(`email = $${paramCount++}`); values.push(email); }
    if (phone !== undefined) { updates.push(`phone = $${paramCount++}`); values.push(phone); }
    if (department !== undefined) { updates.push(`department = $${paramCount++}`); values.push(department); }

    values.push(resourceId);

    const result = await db.query(
      `UPDATE sdsi_resources SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update resource error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete resource
router.delete('/resources/:resourceId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_resources WHERE id = $1', [req.params.resourceId]);
    res.json({ message: 'Ressource supprimée' });
  } catch (error) {
    logger.error('Delete resource error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get resource allocations
router.get('/resources/:resourceId/allocations', authenticate, async (req, res) => {
  try {
    const { resourceId } = req.params;

    const result = await db.query(
      `SELECT ra.*, p.name as project_name, p.code as project_code
       FROM sdsi_resource_allocations ra
       JOIN sdsi_projects p ON p.id = ra.project_id
       WHERE ra.resource_id = $1
       ORDER BY ra.start_date`,
      [resourceId]
    );

    res.json(result.rows.map(a => ({
      id: a.id,
      projectId: a.project_id,
      projectName: a.project_name,
      projectCode: a.project_code,
      percentage: parseFloat(a.allocation_percentage),
      startDate: a.start_date,
      endDate: a.end_date,
      role: a.role,
    })));
  } catch (error) {
    logger.error('Get allocations error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Create allocation
router.post('/resources/:resourceId/allocations', authenticate, async (req, res) => {
  try {
    const { resourceId } = req.params;
    const { projectId, percentage, startDate, endDate, role } = req.body;

    const result = await db.query(
      `INSERT INTO sdsi_resource_allocations (resource_id, project_id, allocation_percentage, start_date, end_date, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [resourceId, projectId, percentage || 100, parseDate(startDate), parseDate(endDate), role]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create allocation error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Update allocation
router.put('/allocations/:allocationId', authenticate, async (req, res) => {
  try {
    const { allocationId } = req.params;
    const { percentage, startDate, endDate, role } = req.body;

    const result = await db.query(
      `UPDATE sdsi_resource_allocations SET allocation_percentage = $1, start_date = $2, end_date = $3, role = $4
       WHERE id = $5 RETURNING *`,
      [percentage, parseDate(startDate), parseDate(endDate), role, allocationId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update allocation error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Delete allocation
router.delete('/allocations/:allocationId', authenticate, async (req, res) => {
  try {
    await db.query('DELETE FROM sdsi_resource_allocations WHERE id = $1', [req.params.allocationId]);
    res.json({ message: 'Allocation supprimée' });
  } catch (error) {
    logger.error('Delete allocation error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// ROADMAP DATA
// ==========================================

router.get('/roadmap/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { year } = req.query;

    let dateFilter = '';
    const params = [workspaceId];

    if (year) {
      params.push(year);
      dateFilter = ` AND (EXTRACT(YEAR FROM p.start_date) = $2 OR EXTRACT(YEAR FROM p.end_date) = $2)`;
    }

    // Get projects for roadmap
    const projectsResult = await db.query(
      `SELECT p.id, p.code, p.name, p.status, p.priority, p.progress,
        p.start_date, p.end_date, p.axis_id,
        sa.name as axis_name, sa.color as axis_color
       FROM sdsi_projects p
       LEFT JOIN sdsi_strategic_axes sa ON sa.id = p.axis_id
       WHERE p.workspace_id = $1 ${dateFilter}
       ORDER BY sa.position, p.start_date`,
      params
    );

    // Get milestones for roadmap
    const milestonesResult = await db.query(
      `SELECT m.id, m.name, m.due_date, m.status, m.is_critical, m.project_id,
        p.name as project_name
       FROM sdsi_milestones m
       JOIN sdsi_projects p ON p.id = m.project_id
       WHERE p.workspace_id = $1
       ORDER BY m.due_date`,
      [workspaceId]
    );

    res.json({
      projects: projectsResult.rows.map(p => ({
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
        priority: p.priority,
        progress: p.progress,
        startDate: p.start_date,
        endDate: p.end_date,
        axisId: p.axis_id,
        axisName: p.axis_name,
        axisColor: p.axis_color,
      })),
      milestones: milestonesResult.rows.map(m => ({
        id: m.id,
        name: m.name,
        dueDate: m.due_date,
        status: m.status,
        isCritical: m.is_critical,
        projectId: m.project_id,
        projectName: m.project_name,
      })),
    });
  } catch (error) {
    logger.error('Get roadmap error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// DASHBOARD / ANALYTICS
// ==========================================

router.get('/dashboard/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Get counts and stats
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM sdsi_strategic_axes WHERE workspace_id = $1) as axes_count,
        (SELECT COUNT(*) FROM sdsi_projects WHERE workspace_id = $1) as projects_count,
        (SELECT COUNT(*) FROM sdsi_projects WHERE workspace_id = $1 AND status = 'in_progress') as projects_in_progress,
        (SELECT COUNT(*) FROM sdsi_projects WHERE workspace_id = $1 AND status = 'completed') as projects_completed,
        (SELECT COUNT(*) FROM sdsi_projects WHERE workspace_id = $1 AND status = 'on_hold') as projects_on_hold,
        (SELECT COUNT(*) FROM sdsi_applications WHERE workspace_id = $1) as applications_count,
        (SELECT COUNT(*) FROM sdsi_kpis WHERE workspace_id = $1) as kpis_count,
        (SELECT COALESCE(SUM(estimated_budget), 0) FROM sdsi_projects WHERE workspace_id = $1) as total_budget,
        (SELECT COALESCE(SUM(actual_budget), 0) FROM sdsi_projects WHERE workspace_id = $1) as spent_budget
    `, [workspaceId]);

    // Projects by status
    const byStatus = await db.query(`
      SELECT status, COUNT(*) as count
      FROM sdsi_projects WHERE workspace_id = $1
      GROUP BY status
      ORDER BY 
        CASE status
          WHEN 'in_progress' THEN 1
          WHEN 'planned' THEN 2
          WHEN 'on_hold' THEN 3
          WHEN 'completed' THEN 4
          WHEN 'cancelled' THEN 5
        END
    `, [workspaceId]);

    // Projects by axis
    const byAxis = await db.query(`
      SELECT sa.name, sa.color, COUNT(p.id) as count
      FROM sdsi_strategic_axes sa
      LEFT JOIN sdsi_projects p ON p.axis_id = sa.id
      WHERE sa.workspace_id = $1
      GROUP BY sa.id
      ORDER BY count DESC
    `, [workspaceId]);

    // Upcoming milestones (include overdue ones)
    const upcomingMilestones = await db.query(`
      SELECT m.*, p.name as project_name
      FROM sdsi_milestones m
      JOIN sdsi_projects p ON p.id = m.project_id
      WHERE p.workspace_id = $1 AND m.status != 'completed'
      ORDER BY m.due_date ASC
      LIMIT 10
    `, [workspaceId]);

    // KPIs status
    const kpisStatus = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE current_value >= target_value) as on_target,
        COUNT(*) FILTER (WHERE current_value < target_value AND current_value >= COALESCE(min_threshold, target_value * 0.8)) as at_risk,
        COUNT(*) FILTER (WHERE current_value < COALESCE(min_threshold, target_value * 0.8)) as critical
      FROM sdsi_kpis WHERE workspace_id = $1 AND target_value IS NOT NULL
    `, [workspaceId]);

    // Get overdue milestones count for alerts
    const overdueMilestones = await db.query(`
      SELECT COUNT(*) as count
      FROM sdsi_milestones m
      JOIN sdsi_projects p ON p.id = m.project_id
      WHERE p.workspace_id = $1 AND m.status != 'completed' AND m.due_date < CURRENT_DATE
    `, [workspaceId]);

    // Get projects at risk (end date approaching but low progress)
    const projectsAtRisk = await db.query(`
      SELECT COUNT(*) as count
      FROM sdsi_projects
      WHERE workspace_id = $1 
        AND status = 'in_progress'
        AND end_date IS NOT NULL
        AND end_date <= CURRENT_DATE + INTERVAL '30 days'
        AND progress < 70
    `, [workspaceId]);

    const s = stats.rows[0];
    res.json({
      summary: {
        axesCount: parseInt(s.axes_count),
        projectsCount: parseInt(s.projects_count),
        projectsInProgress: parseInt(s.projects_in_progress),
        projectsCompleted: parseInt(s.projects_completed),
        projectsOnHold: parseInt(s.projects_on_hold),
        applicationsCount: parseInt(s.applications_count),
        kpisCount: parseInt(s.kpis_count),
        totalBudget: parseFloat(s.total_budget),
        spentBudget: parseFloat(s.spent_budget),
        overdueMilestones: parseInt(overdueMilestones.rows[0].count),
        projectsAtRisk: parseInt(projectsAtRisk.rows[0].count),
      },
      byStatus: byStatus.rows,
      byAxis: byAxis.rows,
      upcomingMilestones: upcomingMilestones.rows,
      kpisStatus: kpisStatus.rows[0] || { on_target: 0, at_risk: 0, critical: 0 },
    });
  } catch (error) {
    logger.error('Get dashboard error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==========================================
// AUTOMATIC PROGRESS TRACKING
// ==========================================

// Auto-update project progress based on phases/milestones
router.post('/projects/:projectId/sync-progress', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;

    // Calculate progress based on completed phases and milestones
    const progressResult = await db.query(`
      WITH phase_progress AS (
        SELECT 
          COALESCE(AVG(
            CASE WHEN status = 'completed' THEN 100 
                 WHEN status = 'in_progress' THEN progress
                 ELSE 0 END
          ), 0) as phase_avg
        FROM sdsi_project_phases WHERE project_id = $1
      ),
      milestone_progress AS (
        SELECT 
          CASE WHEN COUNT(*) > 0 
            THEN (COUNT(*) FILTER (WHERE status = 'completed')::float / COUNT(*)::float * 100)
            ELSE 0 END as milestone_pct
        FROM sdsi_milestones WHERE project_id = $1
      )
      SELECT 
        ROUND((COALESCE(pp.phase_avg, 0) * 0.6 + COALESCE(mp.milestone_pct, 0) * 0.4)::numeric, 0) as calculated_progress
      FROM phase_progress pp, milestone_progress mp
    `, [projectId]);

    const calculatedProgress = parseInt(progressResult.rows[0].calculated_progress) || 0;

    // Update project progress
    const updateResult = await db.query(`
      UPDATE sdsi_projects 
      SET progress = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [calculatedProgress, projectId]);

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Projet non trouvé' });
    }

    logger.info(`Project ${projectId} progress auto-synced to ${calculatedProgress}%`);

    // Also sync KPIs linked to this project
    const kpisResult = await db.query(
      'SELECT * FROM sdsi_kpis WHERE project_id = $1 AND calculation_method IS NOT NULL',
      [projectId]
    );

    let kpisSynced = 0;
    for (const kpi of kpisResult.rows) {
      const method = kpi.calculation_method;
      if (KPI_CALCULATIONS[method]) {
        try {
          const newValue = await KPI_CALCULATIONS[method](kpi, db);
          if (newValue !== null) {
            const oldValue = kpi.current_value;
            let trend = 'stable';
            if (oldValue !== null) {
              if (newValue > oldValue) trend = 'up';
              else if (newValue < oldValue) trend = 'down';
            }

            await db.query(
              'UPDATE sdsi_kpis SET current_value = $1, trend = $2, updated_at = NOW() WHERE id = $3',
              [newValue, trend, kpi.id]
            );
            
            // Insert into KPI values history for tracking
            await db.query(
              `INSERT INTO sdsi_kpi_values (kpi_id, value, recorded_at, notes, created_by)
               VALUES ($1, $2, NOW(), 'Sync automatique projet', $3)`,
              [kpi.id, newValue, req.userId]
            );
            
            logger.info(`KPI ${kpi.id} synced: ${oldValue} -> ${newValue}`);
            kpisSynced++;
          }
        } catch (e) {
          logger.warn(`Failed to sync KPI ${kpi.id}:`, e.message);
        }
      }
    }

    res.json({
      message: 'Progression synchronisée',
      progress: calculatedProgress,
      project: updateResult.rows[0],
      kpisSynced,
    });
  } catch (error) {
    logger.error('Sync project progress error:', error);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

// Auto-complete project when all phases/milestones are done
router.post('/projects/:projectId/check-completion', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;

    // Check if all phases and critical milestones are completed
    const checkResult = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM sdsi_project_phases WHERE project_id = $1 AND status != 'completed') as pending_phases,
        (SELECT COUNT(*) FROM sdsi_milestones WHERE project_id = $1 AND is_critical = true AND status != 'completed') as pending_critical_milestones
    `, [projectId]);

    const { pending_phases, pending_critical_milestones } = checkResult.rows[0];

    let newStatus = null;
    let message = '';

    if (parseInt(pending_phases) === 0 && parseInt(pending_critical_milestones) === 0) {
      // All done - suggest completion
      const updateResult = await db.query(`
        UPDATE sdsi_projects 
        SET status = 'completed', progress = 100, updated_at = NOW()
        WHERE id = $1 AND status != 'completed'
        RETURNING *
      `, [projectId]);

      if (updateResult.rows.length > 0) {
        newStatus = 'completed';
        message = 'Projet automatiquement marqué comme terminé';
        logger.info(`Project ${projectId} auto-completed`);
      }
    }

    res.json({
      canComplete: parseInt(pending_phases) === 0 && parseInt(pending_critical_milestones) === 0,
      pendingPhases: parseInt(pending_phases),
      pendingCriticalMilestones: parseInt(pending_critical_milestones),
      newStatus,
      message,
    });
  } catch (error) {
    logger.error('Check project completion error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

// Get alerts for a workspace
router.get('/alerts/workspace/:workspaceId', authenticate, checkWorkspaceAccess, async (req, res) => {
  try {
    const { workspaceId } = req.params;
    const alerts = [];

    // Check for overdue milestones
    const overdueMilestones = await db.query(`
      SELECT m.*, p.name as project_name
      FROM sdsi_milestones m
      JOIN sdsi_projects p ON p.id = m.project_id
      WHERE p.workspace_id = $1 AND m.status != 'completed' AND m.due_date < CURRENT_DATE
      ORDER BY m.due_date
      LIMIT 5
    `, [workspaceId]);

    overdueMilestones.rows.forEach(m => {
      alerts.push({
        type: 'critical',
        category: 'milestone',
        title: `Jalon en retard: ${m.name}`,
        message: `Projet: ${m.project_name}`,
        dueDate: m.due_date,
        entityId: m.id,
        projectId: m.project_id,
      });
    });

    // Check for critical KPIs
    const criticalKpis = await db.query(`
      SELECT k.*, sa.name as axis_name
      FROM sdsi_kpis k
      LEFT JOIN sdsi_strategic_axes sa ON sa.id = k.axis_id
      WHERE k.workspace_id = $1 
        AND k.target_value IS NOT NULL 
        AND k.current_value < COALESCE(k.min_threshold, k.target_value * 0.8)
      LIMIT 5
    `, [workspaceId]);

    criticalKpis.rows.forEach(k => {
      alerts.push({
        type: 'critical',
        category: 'kpi',
        title: `KPI critique: ${k.name}`,
        message: `Valeur: ${k.current_value} / Cible: ${k.target_value}`,
        entityId: k.id,
      });
    });

    // Check for projects ending soon with low progress
    const projectsAtRisk = await db.query(`
      SELECT p.*, sa.name as axis_name
      FROM sdsi_projects p
      LEFT JOIN sdsi_strategic_axes sa ON sa.id = p.axis_id
      WHERE p.workspace_id = $1 
        AND p.status = 'in_progress'
        AND p.end_date IS NOT NULL
        AND p.end_date <= CURRENT_DATE + INTERVAL '30 days'
        AND p.progress < 70
      ORDER BY p.end_date
      LIMIT 5
    `, [workspaceId]);

    projectsAtRisk.rows.forEach(p => {
      const daysLeft = Math.ceil((new Date(p.end_date) - new Date()) / (1000 * 60 * 60 * 24));
      alerts.push({
        type: 'warning',
        category: 'project',
        title: `Projet à risque: ${p.name}`,
        message: `${p.progress}% terminé, ${daysLeft} jours restants`,
        dueDate: p.end_date,
        entityId: p.id,
        progress: p.progress,
      });
    });

    // Check budget overruns
    const budgetAlerts = await db.query(`
      SELECT p.*
      FROM sdsi_projects p
      WHERE p.workspace_id = $1 
        AND p.estimated_budget > 0
        AND p.actual_budget > p.estimated_budget * 0.9
      LIMIT 5
    `, [workspaceId]);

    budgetAlerts.rows.forEach(p => {
      const percentage = ((p.actual_budget / p.estimated_budget) * 100).toFixed(1);
      alerts.push({
        type: percentage > 100 ? 'critical' : 'warning',
        category: 'budget',
        title: `Budget ${percentage > 100 ? 'dépassé' : 'élevé'}: ${p.name}`,
        message: `${percentage}% du budget consommé`,
        entityId: p.id,
      });
    });

    res.json({
      alerts,
      summary: {
        critical: alerts.filter(a => a.type === 'critical').length,
        warning: alerts.filter(a => a.type === 'warning').length,
        info: alerts.filter(a => a.type === 'info').length,
      },
    });
  } catch (error) {
    logger.error('Get alerts error:', error);
    res.status(500).json({ error: 'Erreur' });
  }
});

module.exports = router;
