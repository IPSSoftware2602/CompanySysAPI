const db = require('../db');

class AuditLog {
    /**
     * Insert an audit record. `client` is optional — pass a pg client to enrol
     * the write in an existing transaction; otherwise it uses the pool.
     */
    static async create(
        {
            user_id, action, entity_type, entity_id, before_data, after_data, reason,
            ip_address, user_agent,
            // Defaults keep existing callers working unchanged; AuditService
            // supplies these explicitly.
            actor_type = 'USER', api_key_id = null,
        },
        client = db
    ) {
        const result = await client.query(
            `INSERT INTO audit_logs
                (user_id, action, entity_type, entity_id, before_data, after_data, reason, ip_address, user_agent,
                 actor_type, api_key_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
                actor_type,
                api_key_id,
            ]
        );
        return result.rows[0];
    }

    /**
     * Filtered, paginated audit query. Every filter is parameterized; `limit`
     * is clamped by the caller so a client cannot request an unbounded scan.
     * Returns { rows, total } so the UI can paginate.
     */
    static async getFiltered({ entity_type, entity_id, user_id, action, from, to, limit, offset }) {
        const conditions = [];
        const values = [];
        let idx = 1;

        if (entity_type) { conditions.push(`al.entity_type = $${idx++}`); values.push(entity_type); }
        if (entity_id) { conditions.push(`al.entity_id = $${idx++}`); values.push(entity_id); }
        if (user_id) { conditions.push(`al.user_id = $${idx++}`); values.push(user_id); }
        if (action) { conditions.push(`al.action = $${idx++}`); values.push(action); }
        if (from) { conditions.push(`al.created_at >= $${idx++}`); values.push(from); }
        if (to) { conditions.push(`al.created_at <= $${idx++}`); values.push(to); }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const countRes = await db.query(
            `SELECT COUNT(*)::int AS total FROM audit_logs al ${where}`,
            values
        );

        const rowsRes = await db.query(
            `SELECT al.*, u.full_name AS user_name, u.email AS user_email
             FROM audit_logs al
             LEFT JOIN users u ON al.user_id = u.id
             ${where}
             ORDER BY al.created_at DESC
             LIMIT $${idx++} OFFSET $${idx}`,
            [...values, limit, offset]
        );

        return { rows: rowsRes.rows, total: countRes.rows[0].total };
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
