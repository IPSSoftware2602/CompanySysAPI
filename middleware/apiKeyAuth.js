const ApiKeyService = require('../services/apiKeyService');

/**
 * Bearer auth for machine clients.
 *
 * Deliberately separate from authenticateToken: a service is not a user. It has
 * no id in `users`, no role, and must be revocable without touching anyone's
 * account. Mixing the two would mean every downstream permission check has to
 * ask "is this a person or a robot", which is exactly the ambiguity that leads
 * to a service accidentally inheriting a human's privileges.
 *
 * Sets `req.apiKey` and leaves `req.user` undefined.
 */
exports.authenticateApiKey = async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Missing API key' });
    }

    try {
        const key = await ApiKeyService.verify(token);
        if (!key) {
            // One message for malformed, unknown, revoked and wrong-secret, so
            // the endpoint cannot be used to enumerate valid keys.
            return res.status(401).json({ error: 'Invalid or revoked API key' });
        }

        req.apiKey = key;
        next();
    } catch (err) {
        console.error('[apikey] verification error:', err.message);
        res.status(500).json({ error: 'Could not verify API key' });
    }
};

/**
 * Requires a scope on the presented key. An empty `scopes` array grants
 * nothing — a key must be explicitly given what it may do.
 */
exports.requireScope = (scope) => (req, res, next) => {
    const scopes = req.apiKey?.scopes || [];
    if (!scopes.includes(scope)) {
        return res.status(403).json({ error: `API key lacks required scope: ${scope}` });
    }
    next();
};
