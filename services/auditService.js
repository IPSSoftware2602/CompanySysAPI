const AuditLog = require('../models/auditLogModel');

/**
 * Thin wrapper that pulls actor/IP/user-agent off the Express request so
 * controllers only pass the domain-specific parts. Audit failures are logged
 * but never throw — an audit-write problem must not fail the user's action.
 */
class AuditService {
    /**
     * Works out who is acting.
     *
     * A NULL user_id used to be ambiguous — it could mean a background job or a
     * bug that lost the user. actor_type makes it explicit, which matters most
     * now that an external system can change tickets: "who cancelled this?" has
     * to have an answer, and "the AI workflow" is a real answer.
     */
    static resolveActor(req) {
        if (req?.apiKey) {
            return { actor_type: 'SERVICE', user_id: null, api_key_id: req.apiKey.id };
        }
        if (req?.user?.id) {
            return { actor_type: 'USER', user_id: req.user.id, api_key_id: null };
        }
        return { actor_type: 'SYSTEM', user_id: null, api_key_id: null };
    }

    /**
     * @param {import('express').Request} req
     * @param {object} entry - { action, entity_type, entity_id, before_data?, after_data?, reason? }
     * @param {object} [client] - optional pg client to run inside a transaction
     */
    static async record(req, entry, client) {
        try {
            return await AuditLog.create(
                {
                    ...AuditService.resolveActor(req),
                    ip_address: req?.ip || req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress,
                    user_agent: req?.headers?.['user-agent'],
                    ...entry,
                },
                client
            );
        } catch (err) {
            console.error('[audit] failed to write audit log:', err.message);
            return null;
        }
    }
}

module.exports = AuditService;
