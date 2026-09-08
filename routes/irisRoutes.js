const express = require('express');
const router = express.Router();
const iris = require('../controllers/irisWebhookController');

/**
 * IRIS's outbound webhook lands here.
 *
 * Deliberately NOT under /api/integration/v1: that router runs
 * authenticateApiKey over everything, and IRIS cannot send an Authorization
 * header. Its credential is the HMAC signature, checked in the controller.
 */
router.post('/events', iris.receive);

module.exports = router;
