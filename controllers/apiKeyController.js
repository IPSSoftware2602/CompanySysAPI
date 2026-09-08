const ApiKeyService = require('../services/apiKeyService');
const AuditService = require('../services/auditService');
const db = require('../db');

/**
 * Managing the credentials external systems use to reach the integration API.
 *
 * The plaintext key is returned exactly once, by create(), and is not
 * recoverable afterwards — the database stores only a bcrypt hash. A lost key
 * is replaced, never looked up.
 *
 * Revoking is preferred to deleting: the row is what tells you a key existed,
 * who made it and when it was last used, which is the only trail there is if a
 * key is ever misused.
 */

/** The scopes an integration key can hold, with what each one permits. */
const AVAILABLE_SCOPES = [
    { scope: 'tickets:read', description: 'List and read support tickets, and read the project library' },
    { scope: 'tickets:write', description: 'File tickets, update them, add notes, request cancellation' },
];
const VALID_SCOPES = AVAILABLE_SCOPES.map((s) => s.scope);

exports.listKeys = async (req, res) => {
    try {
        const keys = await ApiKeyService.list();
        // created_by is a uuid on the row; the name is what a person needs.
        const { rows: users } = await db.query('SELECT id, full_name FROM users');
        const nameFor = new Map(users.map((u) => [u.id, u.full_name]));

        res.json({
            keys: keys.map((k) => ({
                ...k,
                created_by_name: nameFor.get(k.created_by) || null,
                active: !k.revoked_at,
            })),
            available_scopes: AVAILABLE_SCOPES,
        });
    } catch (err) {
        console.error('List API keys error:', err);
        res.status(500).json({ error: 'Failed to list API clients' });
    }
};

exports.createKey = async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : [];

        if (!name) return res.status(400).json({ error: 'A name is required' });

        const invalid = scopes.filter((s) => !VALID_SCOPES.includes(s));
        if (invalid.length) {
            return res.status(400).json({
                error: `Unknown scope(s): ${invalid.join(', ')}`,
                available_scopes: VALID_SCOPES,
            });
        }
        // A key with no scopes can authenticate but do nothing, which looks
        // like a broken integration rather than a misconfigured key.
        if (!scopes.length) {
            return res.status(400).json({ error: 'Pick at least one scope, or the key can do nothing' });
        }

        const created = await ApiKeyService.create({ name, scopes, createdBy: req.user?.id });

        await AuditService.record(req, {
            action: 'CREATE',
            entity_type: 'API_KEY',
            entity_id: created.id,
            after_data: { name: created.name, key_prefix: created.key_prefix, scopes },
            reason: 'API client created',
        });

        // The only time the plaintext ever leaves this process.
        res.status(201).json({
            ...created,
            warning: 'This is the only time the key is shown. Store it now — it cannot be recovered.',
        });
    } catch (err) {
        console.error('Create API key error:', err);
        res.status(500).json({ error: 'Failed to create API client', details: err.message });
    }
};

exports.revokeKey = async (req, res) => {
    try {
        const revoked = await ApiKeyService.revoke(req.params.id);
        if (!revoked) {
            return res.status(404).json({ error: 'No active API client with that id' });
        }

        await AuditService.record(req, {
            action: 'DELETE',
            entity_type: 'API_KEY',
            entity_id: req.params.id,
            before_data: { name: revoked.name, key_prefix: revoked.key_prefix },
            reason: req.body?.reason || 'API client revoked',
        });

        res.json({ message: 'API client revoked. Requests using it now fail immediately.', key: revoked });
    } catch (err) {
        console.error('Revoke API key error:', err);
        res.status(500).json({ error: 'Failed to revoke API client' });
    }
};

exports.AVAILABLE_SCOPES = AVAILABLE_SCOPES;
