const db = require('../db');

class SupportTicket {
    static async create({
        supporting_project_id,
        ticket_key,
        request_type,
        priority,
        risk_level,
        status,
        title,
        description,
        steps_to_reproduce,
        attachments,
        start_date,
        sla_due_at,
        created_by_user_id,
        assigned_pm_id,
        assigned_dev_id
    }) {
        const result = await db.query(
            `INSERT INTO support_tickets (
                supporting_project_id, ticket_key, request_type, priority, risk_level, status,
                title, description, steps_to_reproduce, attachments, start_date, sla_due_at,
                created_by_user_id, assigned_pm_id, assigned_dev_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING *`,
            [
                supporting_project_id, ticket_key, request_type, priority, risk_level, status || 'NEW',
                title, description, steps_to_reproduce, JSON.stringify(attachments || []),
                start_date || new Date(), sla_due_at,
                created_by_user_id, assigned_pm_id, assigned_dev_id
            ]
        );
        return result.rows[0];
    }

    static async getLatestKey(prefix) {
        const result = await db.query(
            `SELECT ticket_key FROM support_tickets WHERE ticket_key LIKE $1 ORDER BY ticket_key DESC LIMIT 1`,
            [`${prefix}%`]
        );
        return result.rows.length > 0 ? result.rows[0].ticket_key : null;
    }

    static async getById(id) {
        const result = await db.query(
            `SELECT st.*, 
                    sp.name as project_name,
                    c.full_name as created_by_name,
                    pm.full_name as assigned_pm_name,
                    dev.full_name as assigned_dev_name
             FROM support_tickets st
             LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
             LEFT JOIN users c ON st.created_by_user_id = c.id
             LEFT JOIN users pm ON st.assigned_pm_id = pm.id
             LEFT JOIN users dev ON st.assigned_dev_id = dev.id
             WHERE st.id = $1`,
            [id]
        );
        return result.rows[0];
    }

    static async update(id, updates) {
        const allowed = [
            'supporting_project_id', 'request_type', 'priority', 'risk_level', 'status',
            'title', 'description', 'steps_to_reproduce', 'attachments',
            'assigned_pm_id', 'assigned_dev_id', 'start_date', 'actual_end_date', 'sla_due_at', 'closed_at'
        ];

        const fields = [];
        const values = [];
        let idx = 1;

        for (const key of Object.keys(updates)) {
            if (allowed.includes(key)) {
                fields.push(`${key} = $${idx++}`);
                values.push(updates[key]);
            }
        }

        if (fields.length === 0) return null; // No updates

        values.push(id);
        const queryText = `UPDATE support_tickets SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx} RETURNING *`;
        console.log('Executing Query:', queryText);
        console.log('Values:', values);

        const result = await db.query(queryText, values);
        return result.rows[0];
    }
}

module.exports = SupportTicket;
