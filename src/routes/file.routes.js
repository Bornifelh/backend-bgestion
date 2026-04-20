const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth.middleware');
const db = require('../database/db');
const logger = require('../utils/logger');

const router = express.Router();

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with original extension
    const uniqueId = uuidv4();
    const ext = path.extname(file.originalname);
    const safeName = `${uniqueId}${ext}`;
    cb(null, safeName);
  }
});

// File filter - allow common file types
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    // Images
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    // Archives
    'application/zip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    // Other
    'application/octet-stream'
  ];

  if (allowedTypes.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error(`Type de fichier non autorisé: ${file.mimetype}`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max
  }
});

// Get attachments for an item
router.get('/item/:itemId', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.*, u.first_name, u.last_name
       FROM attachments a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.item_id = $1
       ORDER BY a.created_at DESC`,
      [req.params.itemId]
    );
    res.json(rows.map(r => ({
      id: r.id,
      itemId: r.item_id,
      fileName: r.file_name,
      fileUrl: r.file_url,
      fileSize: r.file_size,
      fileType: r.file_type,
      firstName: r.first_name,
      lastName: r.last_name,
      createdAt: r.created_at,
    })));
  } catch (error) {
    logger.error('Get attachments error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des fichiers' });
  }
});

// Upload single file
router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const { itemId } = req.body;
    const baseUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;
    const fileUrl = `${baseUrl}/uploads/${req.file.filename}`;

    let fileData;

    if (itemId) {
      const result = await db.query(
        `INSERT INTO attachments (item_id, user_id, file_name, file_url, file_size, file_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [itemId, req.userId, req.file.originalname, fileUrl, req.file.size, req.file.mimetype]
      );
      const r = result.rows[0];
      fileData = {
        id: r.id,
        itemId: r.item_id,
        fileName: r.file_name,
        fileUrl: r.file_url,
        fileSize: r.file_size,
        fileType: r.file_type,
        createdAt: r.created_at,
      };
    } else {
      fileData = {
        id: uuidv4(),
        fileName: req.file.originalname,
        storedName: req.file.filename,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        fileUrl: fileUrl,
        createdAt: new Date().toISOString(),
      };
    }

    logger.info(`File uploaded: ${req.file.originalname} -> ${req.file.filename}`);
    res.json({ success: true, file: fileData });
  } catch (error) {
    logger.error('File upload error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'upload du fichier' });
  }
});

// Upload multiple files
router.post('/upload-multiple', authenticate, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const { itemId } = req.body;
    const baseUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;
    const filesData = [];

    for (const file of req.files) {
      const fileUrl = `${baseUrl}/uploads/${file.filename}`;
      if (itemId) {
        const result = await db.query(
          `INSERT INTO attachments (item_id, user_id, file_name, file_url, file_size, file_type)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [itemId, req.userId, file.originalname, fileUrl, file.size, file.mimetype]
        );
        const r = result.rows[0];
        filesData.push({
          id: r.id,
          itemId: r.item_id,
          fileName: r.file_name,
          fileUrl: r.file_url,
          fileSize: r.file_size,
          fileType: r.file_type,
          createdAt: r.created_at,
        });
      } else {
        filesData.push({
          id: uuidv4(),
          fileName: file.originalname,
          fileSize: file.size,
          fileType: file.mimetype,
          fileUrl: fileUrl,
          createdAt: new Date().toISOString(),
        });
      }
    }

    logger.info(`${req.files.length} files uploaded`);
    res.json({ success: true, files: filesData });
  } catch (error) {
    logger.error('Multiple file upload error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'upload des fichiers' });
  }
});

// Delete attachment
router.delete('/:attachmentId', authenticate, async (req, res) => {
  try {
    const { attachmentId } = req.params;

    const result = await db.query(
      'SELECT * FROM attachments WHERE id = $1',
      [attachmentId]
    );

    if (result.rows.length > 0) {
      const attachment = result.rows[0];
      const storedName = attachment.file_url.split('/uploads/').pop();
      const filePath = path.join(uploadsDir, storedName);
      if (filePath.startsWith(uploadsDir) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      await db.query('DELETE FROM attachments WHERE id = $1', [attachmentId]);
      logger.info(`Attachment deleted: ${attachmentId}`);
      return res.json({ success: true, message: 'Fichier supprimé' });
    }

    const filePath = path.join(uploadsDir, attachmentId);
    if (filePath.startsWith(uploadsDir) && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`File deleted: ${attachmentId}`);
      return res.json({ success: true, message: 'Fichier supprimé' });
    }

    res.status(404).json({ error: 'Fichier non trouvé' });
  } catch (error) {
    logger.error('File delete error:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression du fichier' });
  }
});

// Error handling for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Le fichier est trop volumineux (max 50MB)' });
    }
    return res.status(400).json({ error: error.message });
  }
  if (error.message.includes('Type de fichier')) {
    return res.status(400).json({ error: error.message });
  }
  next(error);
});

module.exports = router;
