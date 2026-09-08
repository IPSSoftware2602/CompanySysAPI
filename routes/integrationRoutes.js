const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router = express.Router();

const ctl = require('../controllers/integrationTicketController');
const projectCtl = require('../controllers/integrationProjectController');
const { authenticateApiKey, requireScope } = require('../middleware/apiKeyAuth');

/**
 * Machine-facing API for the AI workflow system.
 *
 * Versioned and namespaced separately from /api/*, which serves the React app
 * and must stay free to change. This is a contract with an external system.
 *
 * Auth is an API key, never a user JWT — see middleware/apiKeyAuth.
 */

// A misbehaving workflow should not be able to fill the ticket table faster
// than a human can look at it. Generous for normal traffic (client staff volume
// is tens of messages a day), tight enough to bound a runaway loop.
const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Keyed on the API key, so one workflow cannot exhaust another's budget.
    // authenticateApiKey runs first, so req.apiKey is always present; the IP
    // fallback exists only for completeness and must go through
    // ipKeyGenerator — a raw req.ip lets an IPv6 client claim a fresh bucket
    // per address in its /64 and bypass the limit entirely.
    keyGenerator: (req, res) => req.apiKey?.id || ipKeyGenerator(req, res),
    message: { error: 'Rate limit exceeded for this API key' },
});

router.use(authenticateApiKey);

// Reads are separately scoped, so a write-only key cannot enumerate tickets.
// Listed before /tickets/:ticket_key so neither shadows the other.
// The project library the workflow matches customers against. Read scope: it
// is reference data, and a write-only key has no business enumerating clients.
router.get('/projects', requireScope('tickets:read'), projectCtl.list);

router.get('/tickets', requireScope('tickets:read'), ctl.list);
router.get('/tickets/:ticket_key', requireScope('tickets:read'), ctl.get);

router.post('/tickets', writeLimiter, requireScope('tickets:write'), ctl.submit);
router.patch('/tickets/:ticket_key', writeLimiter, requireScope('tickets:write'), ctl.update);
router.post('/tickets/:ticket_key/cancel', writeLimiter, requireScope('tickets:write'), ctl.cancel);
router.post('/tickets/:ticket_key/notes', writeLimiter, requireScope('tickets:write'), ctl.addNote);

module.exports = router;
