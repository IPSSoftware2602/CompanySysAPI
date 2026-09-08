const express = require('express');
const router = express.Router();
const ctl = require('../controllers/apiKeyController');
const { authenticateToken, requireAnyRole } = require('../middleware/authMiddleware');
const { MANAGER_ROLES } = require('../constants');

/**
 * API client management, for the humans who run the integrations.
 *
 * Ordinary JWT auth, never an API key: a key must not be able to mint another
 * key, or revoking a leaked one would not contain it.
 *
 * Gated to MANAGER_ROLES, matching how the rest of the app gates sensitive
 * actions. These credentials let an outside system file and read tickets, so
 * narrow this to CEO/ADMIN if that turns out to be too broad.
 */
router.use(authenticateToken, requireAnyRole(MANAGER_ROLES));

router.get('/', ctl.listKeys);
router.post('/', ctl.createKey);
router.delete('/:id', ctl.revokeKey);

module.exports = router;
