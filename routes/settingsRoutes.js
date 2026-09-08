const express = require('express');
const router = express.Router();
const ctl = require('../controllers/settingsController');
const { authenticateToken, requireAnyRole } = require('../middleware/authMiddleware');
const { MANAGER_ROLES } = require('../constants');

/**
 * These settings hold a live API token. Reading them is as sensitive as writing
 * them, so both are gated — and the read never returns the token itself, only
 * a masked hint.
 */
router.use(authenticateToken, requireAnyRole(MANAGER_ROLES));

router.get('/', ctl.getSettings);
router.put('/', ctl.updateSettings);
router.post('/xtech/preview', ctl.previewMessage);
router.post('/xtech/test', ctl.testXTech);

module.exports = router;
