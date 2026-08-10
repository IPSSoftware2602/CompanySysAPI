const AuditLog = require('../models/auditLogModel');
const { AUDIT_ENTITY, AUDIT_ACTION } = require('../constants');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * GET /api/audit-logs
 *
 * Manager-only. Audit records contain IP addresses and before/after credit
 * values, so this is deliberately not self-service — route-level role
 * middleware gates access before this handler runs.
 */
exports.getAuditLogs = async (req, res) => {
    try {
        const { entity_type, entity_id, user_id, action, from, to } = req.query;

        // Clamp pagination so a client cannot request an unbounded scan.
        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
            MAX_LIMIT
        );
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        // Reject unknown enum values rather than silently returning nothing.
        if (entity_type && !Object.values(AUDIT_ENTITY).includes(entity_type)) {
            return res.status(400).json({
                error: `entity_type must be one of: ${Object.values(AUDIT_ENTITY).join(', ')}`,
            });
        }
        if (action && !Object.values(AUDIT_ACTION).includes(action)) {
            return res.status(400).json({
                error: `action must be one of: ${Object.values(AUDIT_ACTION).join(', ')}`,
            });
        }

        const { rows, total } = await AuditLog.getFiltered({
            entity_type, entity_id, user_id, action, from, to, limit, offset,
        });

        res.json({
            total,
            limit,
            offset,
            has_more: offset + rows.length < total,
            logs: rows,
        });
    } catch (err) {
        console.error('Audit log query error:', err);
        res.status(500).json({ error: 'Failed to fetch audit logs', details: err.message });
    }
};

/**
 * GET /api/audit-logs/:entityType/:entityId
 * Convenience view: the full trail for one record.
 */
exports.getEntityAuditLogs = async (req, res) => {
    try {
        const { entityType, entityId } = req.params;

        if (!Object.values(AUDIT_ENTITY).includes(entityType)) {
            return res.status(400).json({
                error: `entityType must be one of: ${Object.values(AUDIT_ENTITY).join(', ')}`,
            });
        }

        const logs = await AuditLog.getByEntity(entityType, entityId);
        res.json({ entity_type: entityType, entity_id: entityId, logs });
    } catch (err) {
        console.error('Entity audit log error:', err);
        res.status(500).json({ error: 'Failed to fetch audit logs', details: err.message });
    }
};
