const pool = require('../db');

class CreditModel {
    static async createEvaluation(data) {
        const {
            ticket_id, support_ticket_id, ticket_type,
            assignee_user_id, evaluator_user_id,
            period_month,
            complexity_score, effectiveness_score, completeness_score,
            sla_response_score, sla_resolve_score, sla_score,
            error_level, ticket_mark,
            final_score, final_credit,
            notes, status, source
        } = data;

        const result = await pool.query(
            `INSERT INTO credit_evaluations (
                ticket_id, support_ticket_id, ticket_type,
                assignee_user_id, evaluator_user_id,
                period_month,
                complexity_score, effectiveness_score, completeness_score,
                sla_response_score, sla_resolve_score, sla_score,
                error_level, ticket_mark,
                final_score, final_credit,
                notes, status, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            RETURNING *`,
            [
                ticket_id, support_ticket_id, ticket_type,
                assignee_user_id, evaluator_user_id,
                period_month,
                complexity_score, effectiveness_score, completeness_score,
                sla_response_score, sla_resolve_score, sla_score,
                error_level, ticket_mark,
                final_score, final_credit,
                notes, status, source
            ]
        );
        return result.rows[0];
    }

    // Columns a client is permitted to update. Prevents arbitrary/injected
    // column names reaching the SQL string and blocks tampering with system
    // columns (id, locked_at, deleted_at, created_at).
    static get UPDATABLE_COLUMNS() {
        return [
            'ticket_id', 'support_ticket_id', 'ticket_type',
            'assignee_user_id', 'evaluator_user_id', 'period_month',
            'complexity_score', 'effectiveness_score', 'completeness_score',
            'sla_response_score', 'sla_resolve_score', 'sla_score',
            'error_level', 'ticket_mark',
            'final_score', 'final_credit',
            'notes', 'status', 'source', 'version', 'original_evaluation_id',
        ];
    }

    static async getById(id) {
        const result = await pool.query(
            'SELECT * FROM credit_evaluations WHERE id = $1 AND deleted_at IS NULL',
            [id]
        );
        return result.rows[0];
    }

    static async updateEvaluation(id, data) {
        // Dynamic update query, restricted to whitelisted columns.
        const fields = [];
        const values = [];
        let idx = 1;

        for (const [key, value] of Object.entries(data)) {
            if (!CreditModel.UPDATABLE_COLUMNS.includes(key)) continue;
            fields.push(`${key} = $${idx}`);
            values.push(value);
            idx++;
        }

        if (fields.length === 0) return CreditModel.getById(id);

        values.push(id); // ID is the last param

        const result = await pool.query(
            `UPDATE credit_evaluations SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx} AND deleted_at IS NULL RETURNING *`,
            values
        );
        return result.rows[0];
    }

    static async getByUserAndMonth(userId, month) {
        // Gets evaluations for a specific user and month
        // Useful for the User Tab view
        const result = await pool.query(
            `SELECT * FROM credit_evaluations
             WHERE assignee_user_id = $1
             AND TO_CHAR(period_month, 'YYYY-MM') = $2
             AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [userId, month]
        );
        return result.rows;
    }

    static async getByTicket(ticketId, ticketType) {
        let query = 'SELECT * FROM credit_evaluations WHERE deleted_at IS NULL AND ticket_type = $1 ';
        const params = [ticketType];

        if (ticketType === 'KANBAN') {
            query += 'AND ticket_id = $2';
            params.push(ticketId);
        } else {
            query += 'AND support_ticket_id = $2';
            params.push(ticketId);
        }

        const result = await pool.query(query, params);
        return result.rows;
    }

    static async getAdminSummary(month) {
        // Aggregates scores per user for the month
        const result = await pool.query(
            `SELECT 
                u.id as user_id,
                u.full_name,
                COUNT(ce.id) as total_evaluations,
                SUM(ce.final_credit) as total_credits
             FROM users u
             LEFT JOIN credit_evaluations ce ON u.id = ce.assignee_user_id AND TO_CHAR(ce.period_month, 'YYYY-MM') = $1 AND ce.deleted_at IS NULL
             WHERE u.deleted_at IS NULL
             GROUP BY u.id, u.full_name
             ORDER BY u.full_name`,
            [month]
        );
        return result.rows;
    }
}

module.exports = CreditModel;
