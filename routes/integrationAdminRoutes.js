const express = require('express');
const router = express.Router();
const ctl = require('../controllers/integrationAdminController');
const { authenticateToken } = require('../middleware/authMiddleware');

/**
 * Human-facing views onto the integration. Ordinary user JWT auth, not API
 * keys — these are for the PM looking at a dashboard, not for the workflow.
 */
router.get('/dead-letters', authenticateToken, ctl.deadLetters);
router.post('/dead-letters/:id/retry', authenticateToken, ctl.retryDeadLetter);
router.get('/cancellation-requests', authenticateToken, ctl.cancellationRequests);
router.post('/cancellation-requests/:id/resolve', authenticateToken, ctl.resolveCancellation);

module.exports = router;
