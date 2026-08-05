const express = require('express');
const router = express.Router();
const auditLogController = require('../controllers/auditLogController');
const { authenticateToken, requireAnyRole } = require('../middleware/authMiddleware');
const { MANAGER_ROLES } = require('../constants');

// Audit records contain IP addresses and before/after credit values.
// Manager-only across the board — never self-service.
router.use(authenticateToken);
router.use(requireAnyRole(MANAGER_ROLES));

router.get('/', auditLogController.getAuditLogs);
router.get('/:entityType/:entityId', auditLogController.getEntityAuditLogs);

module.exports = router;
