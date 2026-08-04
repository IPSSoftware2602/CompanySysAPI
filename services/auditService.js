const AuditLog = require('../models/auditLogModel');

/**
 * Thin wrapper that pulls actor/IP/user-agent off the Express request so
 * controllers only pass the domain-specific parts. Audit failures are logged
 * but never throw — an audit-write problem must not fail the user's action.
 */
class AuditService {
    /**
     * @param {import('express').Request} req
     * @param {object} entry - { action, entity_type, entity_id, before_data?, after_data?, reason? }
     * @param {object} [client] - optional pg client to run inside a transaction
     */
    static async record(req, entry, client) {
        try {
            return await AuditLog.create(
                {
                    user_id: req.user?.id,
                    ip_address: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
                    user_agent: req.headers['user-agent'],
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
