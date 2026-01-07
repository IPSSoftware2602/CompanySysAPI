const Ticket = require('../models/ticketModel');
const db = require('../db');

exports.createTicket = async (req, res) => {
    try {
        const ticket = await Ticket.create(req.body);
        res.status(201).json(ticket);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create ticket' });
    }
};

exports.getProjectTickets = async (req, res) => {
    try {
        const tickets = await Ticket.getByProject(req.params.projectId);
        res.json(tickets);
    } catch (err) {
        console.error(err);
    }
};

exports.getTicketById = async (req, res) => {
    try {
        const ticket = await Ticket.getById(req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }
        res.json(ticket);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch ticket' });
    }
};

exports.transitionTicket = async (req, res) => {
    const { id } = req.params;
    const { to_status, targetStatus, to_list_id, reason } = req.body;

    try {
        let target = targetStatus || to_status;
        let targetListId = to_list_id;

        // If moving to a list, determine the status
        if (to_list_id) {
            const db = require('../db');
            const listRes = await db.query('SELECT mapped_status FROM lists WHERE id = $1', [to_list_id]);
            if (listRes.rows.length > 0) {
                // If list has a mapped status, use it. Otherwise default to BACKLOG (or keep current? let's default to BACKLOG for safety)
                target = listRes.rows[0].mapped_status || 'BACKLOG';
            }
        }

        // 1. Gatekeeping: Check for required checklists for the target status
        const ChecklistTemplate = require('../models/checklistTemplateModel');
        const ChecklistSubmission = require('../models/checklistSubmissionModel');

        // Get required templates for the target status
        const templates = await ChecklistTemplate.getByRequiredStatus(target);

        for (const template of templates) {
            const submission = await ChecklistSubmission.getByTicketAndTemplate(id, template.id);
            if (!submission) {
                return res.status(403).json({
                    error: `Missing required checklist: ${template.name}`,
                    required_checklist: template.id
                });
            }
        }

        // Update ticket
        const updateData = { status: target };
        if (targetListId) updateData.list_id = targetListId;

        // Get the ticket's previous status for logging BEFORE updating
        const db = require('../db');
        const previousTicket = await db.query('SELECT status FROM tickets WHERE id = $1', [id]);
        const fromStatus = previousTicket.rows[0]?.status;

        const ticket = await Ticket.update(id, updateData);

        // Log transition
        await db.query(
            'INSERT INTO ticket_transitions (ticket_id, from_status, to_status, performed_by_user_id, reason) VALUES ($1, $2, $3, $4, $5)',
            [id, fromStatus, target, req.user?.id, reason]
        );
        res.json(ticket);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to transition ticket' });
    }
};

exports.addMember = async (req, res) => {
    try {
        await Ticket.addMember(req.params.id, req.body.userId);
        res.status(200).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add member' });
    }
};

exports.removeMember = async (req, res) => {
    try {
        await Ticket.removeMember(req.params.id, req.params.userId);
        res.status(200).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to remove member' });
    }
};

exports.updateTicket = async (req, res) => {
    try {
        const ticket = await Ticket.update(req.params.id, req.body);
        res.json(ticket);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update ticket' });
    }
};
exports.reorderTickets = async (req, res) => {
    try {
        await Ticket.reorder(req.body.ticketIds);
        res.status(200).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reorder tickets' });
    }
};

exports.searchTickets = async (req, res) => {
    const { query, fields } = req.body;
    if (!query) return res.json([]);

    try {
        const searchTerm = `%${query}%`;
        let whereConditions = [];
        let params = [searchTerm];
        let paramIdx = 1; // $1 is searchTerm

        // Base query
        let sql = `
            SELECT DISTINCT t.id, t.title, t.status, t.project_id, p.name as project_name, t.created_at
            FROM tickets t
            LEFT JOIN projects p ON t.project_id = p.id
        `;

        if (fields.includes('title')) {
            whereConditions.push(`t.title ILIKE $1`);
        }
        if (fields.includes('description')) {
            whereConditions.push(`t.description ILIKE $1`);
        }
        if (fields.includes('comments')) {
            whereConditions.push(`EXISTS (SELECT 1 FROM comments c WHERE c.ticket_id = t.id AND c.content ILIKE $1)`);
        }
        if (fields.includes('checklists')) {
            // Search checklist names OR items content
            whereConditions.push(`
                EXISTS (
                    SELECT 1 FROM ticket_checklists tc 
                    LEFT JOIN ticket_checklist_items tci ON tc.id = tci.checklist_id
                    WHERE tc.ticket_id = t.id AND (tc.name ILIKE $1 OR tci.content ILIKE $1)
                )
            `);
        }
        if (fields.includes('members')) {
            whereConditions.push(`
                EXISTS (
                    SELECT 1 FROM ticket_assignments ta
                    JOIN users u ON ta.user_id = u.id
                    WHERE ta.ticket_id = t.id AND u.full_name ILIKE $1
                )
             `);
        }

        if (whereConditions.length > 0) {
            sql += ` WHERE ` + whereConditions.join(' OR ');
        } else {
            return res.json([]); // No fields selected
        }

        sql += ` ORDER BY t.created_at DESC LIMIT 50`;

        const result = await db.query(sql, params);
        res.json(result.rows);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Search failed' });
    }
};
