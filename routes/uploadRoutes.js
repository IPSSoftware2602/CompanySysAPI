const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * Uploads are served back from this same origin (server.js mounts
 * /uploads as static), so an uploaded file that the browser will EXECUTE is
 * script execution on our own domain — and with the JWT in the browser, that is
 * session theft. The extension allowlist is therefore a security control, not
 * tidiness.
 *
 * Deliberately excluded, all of which execute in a browser context:
 *   .html .htm .xhtml .svg .js .mjs .xml .swf
 *
 * Current live uploads are pdf/xlsx/png only, so this allowlist breaks nothing
 * in use today. Widen it if the team needs a format — but never with one of the
 * above.
 */
const ALLOWED = new Map([
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.xls', 'application/vnd.ms-excel'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.doc', 'application/msword'],
    ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['.csv', 'text/csv'],
    ['.txt', 'text/plain'],
    ['.log', 'text/plain'],
    ['.zip', 'application/zip'],
]);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        // Random name, allowlisted extension only. The original filename never
        // reaches the filesystem, which removes path traversal ("../../x") and
        // double-extension ("evil.pdf.html") tricks in one move. The real name
        // is returned to the client for display and stored on the ticket.
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `attachment-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
});

function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED.has(ext)) {
        return cb(new Error(`File type "${ext || 'unknown'}" is not allowed`));
    }
    // The browser-declared MIME must agree with the extension, so a .pdf that
    // announces itself as text/html cannot slip past.
    const expected = ALLOWED.get(ext);
    if (file.mimetype !== expected && !(ext === '.txt' || ext === '.log' || ext === '.csv')) {
        return cb(new Error(`Content type "${file.mimetype}" does not match extension "${ext}"`));
    }
    cb(null, true);
}

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
        files: 1,
    },
});

router.post('/', authenticateToken, (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            // Rejections here are user error (wrong type, too big), not faults.
            const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
                ? 'File exceeds the 10MB limit'
                : err.message;
            return res.status(400).json({
                error: message,
                allowed_types: [...ALLOWED.keys()],
            });
        }

        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        res.json({
            name: req.file.originalname, // display name, never a filesystem path
            url: fileUrl,
            type: req.file.mimetype,
            size: req.file.size,
        });
    });
});

module.exports = router;
// Exported so a test can assert no browser-executable type ever creeps back in.
module.exports.ALLOWED = ALLOWED;
