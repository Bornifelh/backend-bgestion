const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const db = require("../database/db");
const { cache } = require("../database/redis");
const {
  authenticate,
  checkWorkspaceAccess,
  checkBoardAccess,
} = require("../middleware/auth.middleware");
const logger = require("../utils/logger");

// Get all boards for a workspace
router.get(
  "/workspace/:workspaceId",
  authenticate,
  checkWorkspaceAccess,
  async (req, res) => {
    try {
      const { workspaceId } = req.params;

      const result = await db.query(
        `SELECT b.*, u.first_name as owner_first_name, u.last_name as owner_last_name,
        (SELECT COUNT(*) FROM items WHERE board_id = b.id) as item_count,
        (SELECT COUNT(*) FROM groups WHERE board_id = b.id) as group_count
       FROM boards b
       LEFT JOIN users u ON u.id = b.owner_id
       WHERE b.workspace_id = $1
       ORDER BY b.position ASC, b.created_at DESC`,
        [workspaceId]
      );

      res.json(
        result.rows.map((b) => ({
          id: b.id,
          workspaceId: b.workspace_id,
          name: b.name,
          description: b.description,
          type: b.type,
          icon: b.icon,
          color: b.color,
          isPrivate: b.is_private,
          ownerId: b.owner_id,
          ownerName: b.owner_first_name
            ? `${b.owner_first_name} ${b.owner_last_name}`
            : null,
          position: b.position,
          itemCount: parseInt(b.item_count),
          groupCount: parseInt(b.group_count),
          createdAt: b.created_at,
        }))
      );
    } catch (error) {
      logger.error("Get boards error:", error);
      res
        .status(500)
        .json({ error: "Erreur lors de la récupération des boards" });
    }
  }
);

// Create board
router.post(
  "/",
  authenticate,
  [
    body("workspaceId").isUUID().withMessage("ID workspace invalide"),
    body("name").trim().notEmpty().withMessage("Nom du board requis"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { workspaceId, name, description, type, icon, color, isPrivate } =
        req.body;

      // Check workspace access
      const memberCheck = await db.query(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, req.userId]
      );

      if (memberCheck.rows.length === 0) {
        return res
          .status(403)
          .json({ error: "Accès au workspace non autorisé" });
      }

      // Get max position
      const posResult = await db.query(
        "SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM boards WHERE workspace_id = $1",
        [workspaceId]
      );

      const client = await db.getClient();

      try {
        await client.query("BEGIN");

        // Create board
        const boardResult = await client.query(
          `INSERT INTO boards (workspace_id, name, description, type, icon, color, is_private, owner_id, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
          [
            workspaceId,
            name,
            description || null,
            type || "board",
            icon || "📋",
            color || "#6366f1",
            isPrivate || false,
            req.userId,
            posResult.rows[0].next_pos,
          ]
        );

        const board = boardResult.rows[0];

        // Get column types
        const columnTypesResult = await client.query(
          "SELECT id, name FROM column_types WHERE name IN ($1, $2, $3)",
          ["status", "person", "date"]
        );

        const columnTypes = {};
        columnTypesResult.rows.forEach((ct) => {
          columnTypes[ct.name] = ct.id;
        });

        // Create default columns
        const defaultColumns = [
          { title: "Statut", type_id: columnTypes.status, position: 0 },
          { title: "Responsable", type_id: columnTypes.person, position: 1 },
          { title: "Date limite", type_id: columnTypes.date, position: 2 },
        ];

        const columnIds = [];
        for (const col of defaultColumns) {
          const colResult = await client.query(
            `INSERT INTO columns (board_id, column_type_id, title, position)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
            [board.id, col.type_id, col.title, col.position]
          );
          columnIds.push({
            id: colResult.rows[0].id,
            type: col.title === "Statut" ? "status" : null,
          });
        }

        // Add default status labels
        const statusColumnId = columnIds.find((c) => c.type === "status")?.id;
        if (statusColumnId) {
          const statusLabels = [
            { label: "À faire", color: "#9ca3af", position: 0 },
            { label: "En cours", color: "#3b82f6", position: 1 },
            { label: "Terminé", color: "#22c55e", position: 2 },
          ];

          for (const status of statusLabels) {
            await client.query(
              `INSERT INTO status_labels (column_id, label, color, position)
             VALUES ($1, $2, $3, $4)`,
              [statusColumnId, status.label, status.color, status.position]
            );
          }
        }

        // Create default group
        await client.query(
          `INSERT INTO groups (board_id, name, color, position)
         VALUES ($1, $2, $3, $4)`,
          [board.id, "Nouveau groupe", "#6366f1", 0]
        );

        // Create default view
        await client.query(
          `INSERT INTO views (board_id, name, type, created_by)
         VALUES ($1, $2, $3, $4)`,
          [board.id, "Vue principale", "table", req.userId]
        );

        await client.query("COMMIT");

        // Emit socket event
        const io = req.app.get("io");
        io.to(`workspace:${workspaceId}`).emit("board:created", {
          id: board.id,
          workspaceId: board.workspace_id,
          name: board.name,
          description: board.description,
          icon: board.icon,
          color: board.color,
        });

        logger.info(`Board created: ${board.id} by user ${req.userId}`);

        res.status(201).json({
          id: board.id,
          workspaceId: board.workspace_id,
          name: board.name,
          description: board.description,
          type: board.type,
          icon: board.icon,
          color: board.color,
          isPrivate: board.is_private,
          ownerId: board.owner_id,
          position: board.position,
          createdAt: board.created_at,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error("Create board error:", error);
      res.status(500).json({ error: "Erreur lors de la création du board" });
    }
  }
);

// Get board with full data
router.get("/:boardId", authenticate, checkBoardAccess, async (req, res) => {
  try {
    const { boardId } = req.params;

    // Get board
    const boardResult = await db.query(
      `SELECT b.*, u.first_name as owner_first_name, u.last_name as owner_last_name
       FROM boards b
       LEFT JOIN users u ON u.id = b.owner_id
       WHERE b.id = $1`,
      [boardId]
    );

    const board = boardResult.rows[0];

    // Get columns with types
    const columnsResult = await db.query(
      `SELECT c.*, ct.name as type_name, ct.component, ct.default_settings
       FROM columns c
       JOIN column_types ct ON ct.id = c.column_type_id
       WHERE c.board_id = $1
       ORDER BY c.position ASC`,
      [boardId]
    );

    // Get status labels for status columns
    const statusColumnIds = columnsResult.rows
      .filter((c) => c.type_name === "status")
      .map((c) => c.id);

    let statusLabels = {};
    if (statusColumnIds.length > 0) {
      const labelsResult = await db.query(
        `SELECT * FROM status_labels WHERE column_id = ANY($1) ORDER BY position ASC`,
        [statusColumnIds]
      );
      labelsResult.rows.forEach((label) => {
        if (!statusLabels[label.column_id]) {
          statusLabels[label.column_id] = [];
        }
        statusLabels[label.column_id].push({
          id: label.id,
          label: label.label,
          color: label.color,
        });
      });
    }

    // Get groups
    const groupsResult = await db.query(
      `SELECT * FROM groups WHERE board_id = $1 ORDER BY position ASC`,
      [boardId]
    );

    // Get items with values
    const itemsResult = await db.query(
      `SELECT i.*, iv.column_id, iv.value
       FROM items i
       LEFT JOIN item_values iv ON iv.item_id = i.id
       WHERE i.board_id = $1
       ORDER BY i.position ASC`,
      [boardId]
    );

    // Group items and their values
    const itemsMap = new Map();
    itemsResult.rows.forEach((row) => {
      if (!itemsMap.has(row.id)) {
        itemsMap.set(row.id, {
          id: row.id,
          name: row.name,
          groupId: row.group_id,
          position: row.position,
          createdBy: row.created_by,
          createdAt: row.created_at,
          values: {},
        });
      }
      if (row.column_id) {
        itemsMap.get(row.id).values[row.column_id] = row.value;
      }
    });

    // Get views
    const viewsResult = await db.query(
      `SELECT * FROM views WHERE board_id = $1 ORDER BY position ASC`,
      [boardId]
    );

    res.json({
      id: board.id,
      workspaceId: board.workspace_id,
      name: board.name,
      description: board.description,
      type: board.type,
      icon: board.icon,
      color: board.color,
      isPrivate: board.is_private,
      ownerId: board.owner_id,
      ownerName: board.owner_first_name
        ? `${board.owner_first_name} ${board.owner_last_name}`
        : null,
      createdAt: board.created_at,
      columns: columnsResult.rows.map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type_name,
        component: c.component,
        width: c.width,
        position: c.position,
        settings: c.settings,
        isVisible: c.is_visible,
        labels: statusLabels[c.id] || [],
      })),
      groups: groupsResult.rows.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        position: g.position,
        isCollapsed: g.is_collapsed,
      })),
      items: Array.from(itemsMap.values()),
      views: viewsResult.rows.map((v) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        settings: v.settings,
        filters: v.filters,
        sorts: v.sorts,
      })),
    });
  } catch (error) {
    logger.error("Get board error:", error);
    res.status(500).json({ error: "Erreur lors de la récupération du board" });
  }
});

// Update board
router.put("/:boardId", authenticate, checkBoardAccess, async (req, res) => {
  try {
    const { boardId } = req.params;
    const { name, description, icon, color, isPrivate } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (icon) {
      updates.push(`icon = $${paramCount++}`);
      values.push(icon);
    }
    if (color) {
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }
    if (isPrivate !== undefined) {
      updates.push(`is_private = $${paramCount++}`);
      values.push(isPrivate);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Aucune donnée à mettre à jour" });
    }

    values.push(boardId);

    const result = await db.query(
      `UPDATE boards SET ${updates.join(", ")}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    const board = result.rows[0];

    // Emit socket event
    const io = req.app.get("io");
    io.to(`board:${boardId}`).emit("board:updated", {
      id: board.id,
      name: board.name,
      description: board.description,
      icon: board.icon,
      color: board.color,
    });

    res.json({
      id: board.id,
      name: board.name,
      description: board.description,
      icon: board.icon,
      color: board.color,
      isPrivate: board.is_private,
    });
  } catch (error) {
    logger.error("Update board error:", error);
    res.status(500).json({ error: "Erreur lors de la mise à jour du board" });
  }
});

// Delete board
router.delete("/:boardId", authenticate, checkBoardAccess, async (req, res) => {
  try {
    const { boardId } = req.params;

    // Check if user is owner or workspace admin
    if (
      !["owner", "admin"].includes(req.workspaceRole) &&
      req.board.owner_id !== req.userId
    ) {
      return res.status(403).json({ error: "Permission insuffisante" });
    }

    const workspaceId = req.board.workspace_id;

    await db.query("DELETE FROM boards WHERE id = $1", [boardId]);

    // Emit socket event
    const io = req.app.get("io");
    io.to(`workspace:${workspaceId}`).emit("board:deleted", {
      boardId,
      workspaceId,
    });

    res.json({ message: "Board supprimé avec succès" });
  } catch (error) {
    logger.error("Delete board error:", error);
    res.status(500).json({ error: "Erreur lors de la suppression du board" });
  }
});

// Duplicate board
router.post(
  "/:boardId/duplicate",
  authenticate,
  checkBoardAccess,
  async (req, res) => {
    try {
      const { boardId } = req.params;
      const { name } = req.body;

      const client = await db.getClient();

      try {
        await client.query("BEGIN");

        // Get original board
        const originalBoard = await client.query(
          "SELECT * FROM boards WHERE id = $1",
          [boardId]
        );

        if (originalBoard.rows.length === 0) {
          return res.status(404).json({ error: "Board non trouvé" });
        }

        const original = originalBoard.rows[0];

        // Get max position
        const posResult = await client.query(
          "SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM boards WHERE workspace_id = $1",
          [original.workspace_id]
        );

        // Create new board
        const newBoardResult = await client.query(
          `INSERT INTO boards (workspace_id, name, description, type, icon, color, is_private, owner_id, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
          [
            original.workspace_id,
            name || `${original.name} (copie)`,
            original.description,
            original.type,
            original.icon,
            original.color,
            original.is_private,
            req.userId,
            posResult.rows[0].next_pos,
          ]
        );

        const newBoard = newBoardResult.rows[0];

        // Copy columns
        const columnsResult = await client.query(
          "SELECT * FROM columns WHERE board_id = $1 ORDER BY position",
          [boardId]
        );

        const columnMapping = {};
        for (const col of columnsResult.rows) {
          const newColResult = await client.query(
            `INSERT INTO columns (board_id, column_type_id, title, width, position, settings, is_visible)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
            [
              newBoard.id,
              col.column_type_id,
              col.title,
              col.width,
              col.position,
              col.settings,
              col.is_visible,
            ]
          );
          columnMapping[col.id] = newColResult.rows[0].id;

          // Copy status labels
          const labelsResult = await client.query(
            "SELECT * FROM status_labels WHERE column_id = $1",
            [col.id]
          );
          for (const label of labelsResult.rows) {
            await client.query(
              `INSERT INTO status_labels (column_id, label, color, position)
             VALUES ($1, $2, $3, $4)`,
              [
                newColResult.rows[0].id,
                label.label,
                label.color,
                label.position,
              ]
            );
          }
        }

        // Copy groups
        const groupsResult = await client.query(
          "SELECT * FROM groups WHERE board_id = $1 ORDER BY position",
          [boardId]
        );

        const groupMapping = {};
        for (const group of groupsResult.rows) {
          const newGroupResult = await client.query(
            `INSERT INTO groups (board_id, name, color, position, is_collapsed)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
            [
              newBoard.id,
              group.name,
              group.color,
              group.position,
              group.is_collapsed,
            ]
          );
          groupMapping[group.id] = newGroupResult.rows[0].id;
        }

        // Copy items and values
        const itemsResult = await client.query(
          "SELECT * FROM items WHERE board_id = $1 ORDER BY position",
          [boardId]
        );

        for (const item of itemsResult.rows) {
          const newItemResult = await client.query(
            `INSERT INTO items (board_id, group_id, name, position, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
            [
              newBoard.id,
              item.group_id ? groupMapping[item.group_id] : null,
              item.name,
              item.position,
              req.userId,
            ]
          );

          // Copy item values
          const valuesResult = await client.query(
            "SELECT * FROM item_values WHERE item_id = $1",
            [item.id]
          );

          for (const value of valuesResult.rows) {
            if (columnMapping[value.column_id]) {
              await client.query(
                `INSERT INTO item_values (item_id, column_id, value)
               VALUES ($1, $2, $3)`,
                [
                  newItemResult.rows[0].id,
                  columnMapping[value.column_id],
                  value.value,
                ]
              );
            }
          }
        }

        // Copy views
        const viewsResult = await client.query(
          "SELECT * FROM views WHERE board_id = $1",
          [boardId]
        );

        for (const view of viewsResult.rows) {
          await client.query(
            `INSERT INTO views (board_id, name, type, settings, filters, sorts, position, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              newBoard.id,
              view.name,
              view.type,
              view.settings,
              view.filters,
              view.sorts,
              view.position,
              req.userId,
            ]
          );
        }

        await client.query("COMMIT");

        res.status(201).json({
          id: newBoard.id,
          name: newBoard.name,
          workspaceId: newBoard.workspace_id,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error("Duplicate board error:", error);
      res.status(500).json({ error: "Erreur lors de la duplication du board" });
    }
  }
);

// ==========================================
// GROUPS ROUTES
// ==========================================

// Create a new group
router.post(
  "/:boardId/groups",
  authenticate,
  checkBoardAccess,
  async (req, res) => {
    try {
      const { boardId } = req.params;
      const { name, color } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ error: "Le nom du groupe est requis" });
      }

      // Get next position
      const posResult = await db.query(
        "SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM groups WHERE board_id = $1",
        [boardId]
      );

      const result = await db.query(
        `INSERT INTO groups (board_id, name, color, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
        [boardId, name.trim(), color || "#6366f1", posResult.rows[0].next_pos]
      );

      const group = result.rows[0];

      // Emit socket event
      const io = req.app.get("io");
      io.to(`board:${boardId}`).emit("group:created", {
        id: group.id,
        name: group.name,
        color: group.color,
        position: group.position,
        isCollapsed: group.is_collapsed,
      });

      res.status(201).json({
        id: group.id,
        name: group.name,
        color: group.color,
        position: group.position,
        isCollapsed: group.is_collapsed,
      });
    } catch (error) {
      logger.error("Create group error:", error);
      res.status(500).json({ error: "Erreur lors de la création du groupe" });
    }
  }
);

// Update a group
router.put("/groups/:groupId", authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, color, isCollapsed } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (color !== undefined) {
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }
    if (isCollapsed !== undefined) {
      updates.push(`is_collapsed = $${paramCount++}`);
      values.push(isCollapsed);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Aucune donnée à mettre à jour" });
    }

    values.push(groupId);

    const result = await db.query(
      `UPDATE groups SET ${updates.join(
        ", "
      )} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Groupe non trouvé" });
    }

    const group = result.rows[0];

    // Emit socket event
    const io = req.app.get("io");
    io.to(`board:${group.board_id}`).emit("group:updated", {
      id: group.id,
      name: group.name,
      color: group.color,
      isCollapsed: group.is_collapsed,
    });

    res.json({
      id: group.id,
      name: group.name,
      color: group.color,
      position: group.position,
      isCollapsed: group.is_collapsed,
    });
  } catch (error) {
    logger.error("Update group error:", error);
    res.status(500).json({ error: "Erreur lors de la mise à jour du groupe" });
  }
});

// Delete a group
router.delete("/groups/:groupId", authenticate, async (req, res) => {
  try {
    const { groupId } = req.params;

    // Get board_id before deleting
    const groupResult = await db.query(
      "SELECT board_id FROM groups WHERE id = $1",
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: "Groupe non trouvé" });
    }

    const boardId = groupResult.rows[0].board_id;

    // Move items to no group before deleting
    await db.query("UPDATE items SET group_id = NULL WHERE group_id = $1", [
      groupId,
    ]);

    // Delete the group
    await db.query("DELETE FROM groups WHERE id = $1", [groupId]);

    // Emit socket event
    const io = req.app.get("io");
    io.to(`board:${boardId}`).emit("group:deleted", { groupId });

    res.json({ message: "Groupe supprimé" });
  } catch (error) {
    logger.error("Delete group error:", error);
    res.status(500).json({ error: "Erreur lors de la suppression du groupe" });
  }
});

module.exports = router;
