require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createServer } = require("http");
const { Server } = require("socket.io");

const path = require("path");

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

const { authenticateSocket } = require("./middleware/auth.middleware");
const logger = require("./utils/logger");
const db = require("./database/db");

const app = express();
const httpServer = createServer(app);

// Trust proxy - required for rate limiting behind reverse proxy (Coolify/nginx)
app.set('trust proxy', 1);

// CORS origins configuration
const getCorsOrigins = () => {
  const corsOrigins = process.env.CORS_ORIGINS || process.env.FRONTEND_URL;
  if (corsOrigins) {
    return corsOrigins.split(',').map(origin => origin.trim());
  }
  return ["http://localhost:5173", "http://localhost:3000"];
};

const allowedOrigins = getCorsOrigins();

// Socket.IO configuration
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
});

// Middleware
app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files statically (for Office 365 Online access)
app.use("/uploads", express.static(path.join(__dirname, "../uploads"), {
  setHeaders: (res, filePath) => {
    // Allow cross-origin access for Office Online
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  }
}));

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

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Socket.IO middleware
io.use(authenticateSocket);

// Socket.IO events
io.on("connection", (socket) => {
  logger.info(`User connected: ${socket.userId}`);

  // Join workspace room
  socket.on("join:workspace", (workspaceId) => {
    socket.join(`workspace:${workspaceId}`);
    logger.info(`User ${socket.userId} joined workspace ${workspaceId}`);
  });

  // Join board room
  socket.on("join:board", (boardId) => {
    socket.join(`board:${boardId}`);
    logger.info(`User ${socket.userId} joined board ${boardId}`);
  });

  // Leave workspace room
  socket.on("leave:workspace", (workspaceId) => {
    socket.leave(`workspace:${workspaceId}`);
  });

  // Leave board room
  socket.on("leave:board", (boardId) => {
    socket.leave(`board:${boardId}`);
  });

  socket.on("disconnect", () => {
    logger.info(`User disconnected: ${socket.userId}`);
  });
});

// Make io available to routes
app.set("io", io);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || "Une erreur interne est survenue",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route non trouvée" });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  logger.info(`🚀 Server running on ${HOST}:${PORT}`);
  logger.info(`📡 Socket.IO ready for connections`);
  logger.info(`🔒 CORS origins: ${JSON.stringify(allowedOrigins)}`);
});

module.exports = { app, io };
