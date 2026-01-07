const db = require('../db');

class ActivityLog {
    static async create({ ticket_id, user_id, action, field_changed, old_value, new_value }) {
        const result = await db.query(
            `INSERT INTO ticket_activity_logs (ticket_id, user_id, action, field_changed, old_value, new_value)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [ticket_id, user_id, action, field_changed, old_value || null, new_value || null]
        );
        return result.rows[0];
    }

    static async getByTicket(ticketId) {
        const result = await db.query(
            `SELECT tal.*, u.full_name as user_name
             FROM ticket_activity_logs tal
             LEFT JOIN users u ON tal.user_id = u.id
             WHERE tal.ticket_id = $1
             ORDER BY tal.created_at DESC
             LIMIT 50`,
            [ticketId]
        );
        return result.rows;
    }

    static formatLogMessage(log) {
        const userName = log.user_name || 'Someone';
        switch (log.action) {
            case 'created':
                return `${userName} created this ticket`;
            case 'updated':
                if (log.field_changed) {
                    const oldVal = log.old_value || 'empty';
                    const newVal = log.new_value || 'empty';
                    return `${userName} changed ${log.field_changed} from "${oldVal}" to "${newVal}"`;
                }
                return `${userName} updated this ticket`;
            case 'deleted':
                return `${userName} deleted this ticket`;
            case 'moved':
                return `${userName} moved this ticket from "${log.old_value}" to "${log.new_value}"`;
            default:
                return `${userName} performed ${log.action}`;
        }
    }
}

module.exports = ActivityLog;
