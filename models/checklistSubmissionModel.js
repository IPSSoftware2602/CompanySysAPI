const db = require('../db');

class ChecklistSubmission {
    static async getByTicketAndTemplate(ticketId, templateId) {
        const result = await db.query(
            'SELECT * FROM checklist_submissions WHERE ticket_id = $1 AND template_id = $2',
            [ticketId, templateId]
        );
        return result.rows[0];
    }

    static async create({ ticket_id, template_id, submitted_by_user_id, completed_items }) {
        const result = await db.query(
            `INSERT INTO checklist_submissions (ticket_id, template_id, submitted_by_user_id, completed_items)
       VALUES ($1, $2, $3, $4) RETURNING *`,
            [ticket_id, template_id, submitted_by_user_id, completed_items]
        );
        return result.rows[0];
    }
}

module.exports = ChecklistSubmission;
