const CreditModel = require('../models/creditModel');
const pool = require('../db');
const { calculateTicketScore } = require('../utils/workingHours');

// Default ticket marks
const SUPPORT_DEFAULT_MARKS = 60;

// Fetch user credits (Kanban + Support) for a month
exports.getUserCredits = async (req, res) => {
    try {
        const { userId } = req.params;
        const { month } = req.query;

        // 1. Get Kanban Tickets with dates
        const kanbanTickets = await pool.query(`
            SELECT t.*, 
                   p.name as project_name, 
                   p.client_name, 
                   ce.id as evaluation_id, 
                   ce.final_score, 
                   ce.status as evaluation_status,
                   ce.ticket_mark
            FROM tickets t
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN credit_evaluations ce ON t.id = ce.ticket_id
            WHERE t.assigned_to_user_id = $1
            ORDER BY p.name, t.created_at DESC
        `, [userId]);

        // Calculate ticket scores for Kanban
        const kanbanWithScores = kanbanTickets.rows.map(ticket => ({
            ...ticket,
            ticket_score: ticket.ticket_mark || calculateTicketScore(ticket.start_date, ticket.end_date)
        }));

        // 2. Get Support Tickets with dates
        const supportTickets = await pool.query(`
            SELECT st.*, 
                   COALESCE(p.name, sp.name, 'Unknown Project') as project_name, 
                   p.client_name, 
                   ce.id as evaluation_id, 
                   ce.final_score, 
                   ce.status as evaluation_status,
                   ce.ticket_mark
            FROM support_tickets st
            LEFT JOIN projects p ON st.project_id = p.id
            LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
            LEFT JOIN credit_evaluations ce ON st.id = ce.support_ticket_id
            WHERE st.assigned_dev_id = $1
            ORDER BY project_name, st.created_at DESC
        `, [userId]);

        // Support tickets use default 60 marks (can be overridden by admin)
        const supportWithScores = supportTickets.rows.map(ticket => ({
            ...ticket,
            ticket_score: ticket.ticket_mark || SUPPORT_DEFAULT_MARKS
        }));

        res.json({
            kanban: kanbanWithScores,
            support: supportWithScores
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.saveEvaluation = async (req, res) => {
    try {
        const data = req.body;
        const currentUser = req.user;

        // Permission check: Admin can edit all, others can only edit own
        if (currentUser.role !== 'ADMIN') {
            if (data.assignee_user_id !== currentUser.id) {
                return res.status(403).json({ error: 'You can only evaluate your own tickets' });
            }
        }

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

exports.getEvaluation = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM credit_evaluations WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Evaluation not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};
