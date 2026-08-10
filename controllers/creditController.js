const CreditModel = require('../models/creditModel');
const pool = require('../db');
const { calculateTicketScore } = require('../utils/workingHours');
const AuditService = require('../services/auditService');
const { AUDIT_ACTION, AUDIT_ENTITY } = require('../constants');

// Default ticket marks
const SUPPORT_DEFAULT_MARKS = 60;

// Fetch user credits (Kanban + Support) for a month or date range
exports.getUserCredits = async (req, res) => {
    try {
        const { userId } = req.params;
        const { month, startDate, endDate } = req.query;

        let dateFilter = '';
        const params = [userId];

        if (startDate && endDate) {
            // Filter by date range (e.g. for Weekly view)
            params.push(startDate, endDate);
            dateFilter = `AND t.start_date >= $2 AND t.start_date <= $3`;
        } else if (month) {
            // Filter by month
            params.push(month);
            dateFilter = `AND TO_CHAR(t.start_date, 'YYYY-MM') = $2`;
        }

        // 1. Get Kanban Tickets with dates - using ticket_assignments junction table
        const kanbanQuery = `
            SELECT t.*, 
                   ta.user_id as assigned_to_user_id,
                   p.name as project_name, 
                   COALESCE(co.name, p.client_name) as client_name, 
                   ce.id as evaluation_id, 
                   ce.final_score, 
                   ce.status as evaluation_status,
                   ce.ticket_mark
            FROM tickets t
            JOIN ticket_assignments ta ON t.id = ta.ticket_id
            LEFT JOIN projects p ON t.project_id = p.id
            LEFT JOIN companies co ON co.id = p.company_id
            LEFT JOIN credit_evaluations ce ON t.id = ce.ticket_id AND ce.assignee_user_id = $1 AND ce.deleted_at IS NULL
            WHERE ta.user_id = $1 AND t.deleted_at IS NULL ${dateFilter}
            ORDER BY p.name, t.start_date DESC
        `;

        const kanbanTickets = await pool.query(kanbanQuery, params);

        // Calculate ticket scores for Kanban
        const kanbanWithScores = kanbanTickets.rows.map(ticket => ({
            ...ticket,
            ticket_score: ticket.ticket_mark || calculateTicketScore(ticket.start_date, ticket.end_date)
        }));

        // 2. Get Support Tickets with dates
        let supportDateFilter = '';
        if (startDate && endDate) {
            supportDateFilter = `AND st.start_date >= $2 AND st.start_date <= $3`;
        } else if (month) {
            supportDateFilter = `AND TO_CHAR(st.start_date, 'YYYY-MM') = $2`;
        }

        const supportQuery = `
            SELECT st.*, 
                   COALESCE(p.name, sp.name, 'Unknown Project') as project_name, 
                   COALESCE(stco.name, co.name, p.client_name) as client_name, 
                   ce.id as evaluation_id, 
                   ce.final_score, 
                   ce.status as evaluation_status,
                   ce.ticket_mark
            FROM support_tickets st
            LEFT JOIN projects p ON st.project_id = p.id
            LEFT JOIN companies co ON co.id = p.company_id
            LEFT JOIN companies stco ON stco.id = st.company_id
            LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
            LEFT JOIN credit_evaluations ce ON st.id = ce.support_ticket_id AND ce.deleted_at IS NULL
            WHERE st.assigned_dev_id = $1 AND st.deleted_at IS NULL ${supportDateFilter}
            ORDER BY project_name, st.created_at DESC
        `;

        const supportTickets = await pool.query(supportQuery, params);

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
            // Load the existing row: enforce the monthly lock and capture before-state for audit.
            const existing = await CreditModel.getById(id);
            if (!existing) {
                return res.status(404).json({ error: 'Evaluation not found' });
            }
            if (existing.locked_at && currentUser.role !== 'ADMIN') {
                return res.status(403).json({ error: 'This evaluation is locked. Only an admin can adjust it.' });
            }
            result = await CreditModel.updateEvaluation(id, payload);
            await AuditService.record(req, {
                action: AUDIT_ACTION.UPDATE,
                entity_type: AUDIT_ENTITY.CREDIT_EVALUATION,
                entity_id: id,
                before_data: {
                    final_score: existing.final_score,
                    final_credit: existing.final_credit,
                    status: existing.status,
                    ticket_mark: existing.ticket_mark,
                },
                after_data: {
                    final_score: result.final_score,
                    final_credit: result.final_credit,
                    status: result.status,
                    ticket_mark: result.ticket_mark,
                },
            });
        } else {
            result = await CreditModel.createEvaluation(payload);
            await AuditService.record(req, {
                action: AUDIT_ACTION.CREATE,
                entity_type: AUDIT_ENTITY.CREDIT_EVALUATION,
                entity_id: result.id,
                after_data: { final_score: result.final_score, final_credit: result.final_credit, status: result.status },
            });
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
        const result = await pool.query('SELECT * FROM credit_evaluations WHERE id = $1 AND deleted_at IS NULL', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Evaluation not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};
