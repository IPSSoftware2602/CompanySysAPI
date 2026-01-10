const CreditModel = require('../models/creditModel');
const pool = require('../db');

// Fetch user credits (Kanban + Support) for a month
exports.getUserCredits = async (req, res) => {
    try {
        const { userId } = req.params; // or req.query
        const { month } = req.query; // YYYY-MM

        // This is a complex unified view. We need to fetch tickets AND their evaluations.
        // For simplicity, we'll fetch them separately and merge, or do a big join.
        // Let's do a tailored query here or helper in Model.

        // Actually, the requirements say "Show My Kanban Tickets + My Support Tickets"
        // So we need to fetch ALL tickets assigned to user in that month (or generally active?)
        // and attach their credit info if it exists.

        // 1. Get Kanban Tickets created/active in month OR assigned to user
        // Simplified: Tickets assigned to user.
        const kanbanTickets = await pool.query(`
            SELECT t.*, ce.id as evaluation_id, ce.final_score, ce.status as evaluation_status
            FROM tickets t
            LEFT JOIN credit_evaluations ce ON t.id = ce.ticket_id
            WHERE t.assigned_to_user_id = $1
            ORDER BY t.created_at DESC
        `, [userId]);

        // 2. Get Support Tickets
        const supportTickets = await pool.query(`
            SELECT st.*, ce.id as evaluation_id, ce.final_score, ce.status as evaluation_status
            FROM support_tickets st
            LEFT JOIN credit_evaluations ce ON st.id = ce.support_ticket_id
            WHERE st.assigned_dev_id = $1
            ORDER BY st.created_at DESC
        `, [userId]);

        res.json({
            kanban: kanbanTickets.rows,
            support: supportTickets.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.saveEvaluation = async (req, res) => {
    try {
        const data = req.body;
        // Basic validation/calculation could go here or in frontend.
        // Assuming frontend sends calculated final_score for now or we recalc.

        const { id, ...payload } = data;
        let result;
        if (id) {
            result = await CreditModel.updateEvaluation(id, payload);
        } else {
            result = await CreditModel.createEvaluation(payload);
        }
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.getAdminSummary = async (req, res) => {
    try {
        const { month } = req.query;
        const summary = await CreditModel.getAdminSummary(month);
        res.json(summary);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};
