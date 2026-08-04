const db = require('../db');

class AuditLog {
    /**
     * Insert an audit record. `client` is optional — pass a pg client to enrol
     * the write in an existing transaction; otherwise it uses the pool.
     */
    static async create(
        { user_id, action, entity_type, entity_id, before_data, after_data, reason, ip_address, user_agent },
        client = db
    ) {
        const result = await client.query(
            `INSERT INTO audit_logs
                (user_id, action, entity_type, entity_id, before_data, after_data, reason, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                user_id || null,
                action,
                entity_type,
                entity_id || null,
                before_data ? JSON.stringify(before_data) : null,
                after_data ? JSON.stringify(after_data) : null,
                reason || null,
                ip_address || null,
                user_agent || null,
            ]
        );
        return result.rows[0];
    }

    static async getByEntity(entity_type, entity_id) {
        const result = await db.query(
            `SELECT al.*, u.full_name AS user_name
             FROM audit_logs al
             LEFT JOIN users u ON al.user_id = u.id
             WHERE al.entity_type = $1 AND al.entity_id = $2
             ORDER BY al.created_at DESC
             LIMIT 100`,
            [entity_type, entity_id]
        );
        return result.rows;
    }
}

module.exports = AuditLog;
