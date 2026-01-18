const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth.middleware');
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

// Upload single file
router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const { itemId, columnId } = req.body;

    // Build the public URL for the file
    const baseUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;
    const fileUrl = `${baseUrl}/uploads/${req.file.filename}`;

    const fileData = {
      id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: req.file.originalname,
      storedName: req.file.filename,
      size: req.file.size,
      type: req.file.mimetype,
      url: fileUrl,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.user.id
    };

    logger.info(`File uploaded: ${req.file.originalname} -> ${req.file.filename}`);

    res.json({
      success: true,
      file: fileData
    });
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

    const baseUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;

    const filesData = req.files.map(file => ({
      id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: file.originalname,
      storedName: file.filename,
      size: file.size,
      type: file.mimetype,
      url: `${baseUrl}/uploads/${file.filename}`,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.user.id
    }));

    logger.info(`${req.files.length} files uploaded`);

    res.json({
      success: true,
      files: filesData
    });
  } catch (error) {
    logger.error('Multiple file upload error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'upload des fichiers' });
  }
});

// Delete file
router.delete('/:filename', authenticate, async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(uploadsDir, filename);

    // Security check - prevent directory traversal
    if (!filePath.startsWith(uploadsDir)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`File deleted: ${filename}`);
      res.json({ success: true, message: 'Fichier supprimé' });
    } else {
      res.status(404).json({ error: 'Fichier non trouvé' });
    }
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
