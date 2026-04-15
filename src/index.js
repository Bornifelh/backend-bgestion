const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createServer } = require("http");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const workspaceRoutes = require("./routes/workspace.routes");
const boardRoutes = require("./routes/board.routes");
const itemRoutes = require("./routes/item.routes");
const columnRoutes = require("./routes/column.routes");
const notificationRoutes = require("./routes/notification.routes");
const budgetRoutes = require("./routes/budget.routes");
const memberRoutes = require("./routes/member.routes");
const sdsiRoutes = require("./routes/sdsi.routes");
const permissionRoutes = require("./routes/permission.routes");
const commentRoutes = require("./routes/comment.routes");
const subtaskRoutes = require("./routes/subtask.routes");
const activityRoutes = require("./routes/activity.routes");
const searchRoutes = require("./routes/search.routes");
const exportRoutes = require("./routes/export.routes");
const automationRoutes = require("./routes/automation.routes");
const ticketRoutes = require("./routes/ticket.routes");
const fileRoutes = require("./routes/file.routes");
const timeEntryRoutes = require("./routes/timeEntry.routes");
const favoriteRoutes = require("./routes/favorite.routes");
const dependencyRoutes = require("./routes/dependency.routes");
const sprintRoutes = require("./routes/sprint.routes");
const templateRoutes = require("./routes/template.routes");
const savedFilterRoutes = require("./routes/savedFilter.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const reportRoutes = require("./routes/report.routes");
const itAssetRoutes = require("./routes/itAsset.routes");

const { authenticateSocket } = require("./middleware/auth.middleware");
const logger = require("./utils/logger");
const db = require("./database/db");

const app = express();
const httpServer = createServer(app);

// Trust proxy - required for rate limiting behind reverse proxy (Coolify/nginx)
app.set("trust proxy", 1);

// CORS origins configuration
const getCorsOrigins = () => {
  const corsOrigins = process.env.CORS_ORIGINS || process.env.FRONTEND_URL;
  if (corsOrigins) {
    return corsOrigins.split(",").map((origin) => origin.trim());
  }
  return ["http://localhost:5173", "http://localhost:3000"];
};

const allowedOrigins = getCorsOrigins();

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  pingTimeout: 30000,
  pingInterval: 15000,
  allowUpgrades: true,
  allowEIO3: true,
  connectTimeout: 10000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: {
    threshold: 1024,
  },
});

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically (for Office 365 Online access)
app.use(
  "/uploads",
  express.static(path.join(__dirname, "../uploads"), {
    setHeaders: (res, filePath) => {
      // Allow cross-origin access for Office Online
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    },
  }),
);

// Rate limiting - disabled in development
const isDev = process.env.NODE_ENV !== "production";
if (!isDev) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    message: { error: "Trop de requêtes, veuillez réessayer plus tard." },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api", limiter);
}

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/boards", boardRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/columns", columnRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/members", memberRoutes);
app.use("/api/sdsi", sdsiRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/subtasks", subtaskRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/automations", automationRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/time-entries", timeEntryRoutes);
app.use("/api/favorites", favoriteRoutes);
app.use("/api/dependencies", dependencyRoutes);
app.use("/api/sprints", sprintRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/saved-filters", savedFilterRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/it", itAssetRoutes);
app.use("/api/reports", reportRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Debug endpoints — uniquement en développement
if (isDev) {
  app.get("/api/test-email-config", async (req, res) => {
    const { testEmailConnection } = require("./services/email.service");
    const result = await testEmailConnection();
    res.json({
      ...result,
      smtpHost: process.env.SMTP_HOST,
      smtpPort: process.env.SMTP_PORT,
      smtpUser: process.env.SMTP_USER ? "***configured***" : "NOT SET",
      smtpPassword: process.env.SMTP_PASSWORD ? "***configured***" : "NOT SET",
      emailFrom: process.env.EMAIL_FROM || "NOT SET",
    });
  });

  app.get("/api/socket-status", (req, res) => {
    res.json({
      status: "ok",
      socketPath: "/socket.io",
      transports: ["websocket", "polling"],
      connectedClients: io.engine.clientsCount || 0,
      corsOrigins: allowedOrigins,
    });
  });
}

// Socket.IO middleware
io.use(authenticateSocket);

io.on("connection", (socket) => {
  logger.info(`User connected: ${socket.userId}`);

  socket.on("join:workspace", (workspaceId) => {
    if (!workspaceId) return;
    const room = `workspace:${workspaceId}`;
    if (!socket.rooms.has(room)) {
      socket.join(room);
    }
  });

  socket.on("join:board", (boardId) => {
    if (!boardId) return;
    const room = `board:${boardId}`;
    if (!socket.rooms.has(room)) {
      socket.join(room);
    }
  });

  socket.on("leave:workspace", (workspaceId) => {
    if (workspaceId) socket.leave(`workspace:${workspaceId}`);
  });

  socket.on("leave:board", (boardId) => {
    if (boardId) socket.leave(`board:${boardId}`);
  });

  socket.on("disconnect", (reason) => {
    logger.info(`User disconnected: ${socket.userId} (${reason})`);
  });
});

// Make io available to routes
app.set("io", io);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`[${req.method} ${req.originalUrl}] ${err.message}`, {
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userId: req.userId || null,
  });

  if (err.name === "ValidationError" || err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: err.message || "Requête invalide",
    });
  }

  if (err.name === "UnauthorizedError" || err.status === 401) {
    return res.status(401).json({
      success: false,
      error: err.message || "Non authentifié",
    });
  }

  if (err.status === 403) {
    return res.status(403).json({
      success: false,
      error: err.message || "Accès refusé",
    });
  }

  if (err.code === "23505") {
    return res.status(409).json({
      success: false,
      error: "Cette ressource existe déjà",
    });
  }

  if (err.code === "23503") {
    return res.status(400).json({
      success: false,
      error: "Référence invalide — la ressource liée n'existe pas",
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: statusCode === 500 ? "Une erreur interne est survenue" : err.message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route non trouvée" });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  logger.info(`🚀 Server running on ${HOST}:${PORT}`);
  logger.info(`📡 Socket.IO ready for connections`);
  logger.info(`🔒 CORS origins: ${JSON.stringify(allowedOrigins)}`);
});

module.exports = { app, io };
