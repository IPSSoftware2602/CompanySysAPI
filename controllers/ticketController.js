const Ticket = require('../models/ticketModel');
const db = require('../db');
const AuditService = require('../services/auditService');
const { AUDIT_ACTION, AUDIT_ENTITY } = require('../constants');

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
            console.log(`Transition Debug: to_list_id=${to_list_id}, found=${listRes.rows.length}, mapped_status=${listRes.rows[0]?.mapped_status}`);

            if (listRes.rows.length > 0) {
                // If list has a mapped status, use it. Otherwise default to BACKLOG (or keep current? let's default to BACKLOG for safety)
                target = listRes.rows[0].mapped_status || 'BACKLOG';
                console.log(`Transition Debug: target resolved to ${target}`);
            }
        }

        // 1. Gatekeeping: Check for required checklists for the target status
        const ChecklistTemplate = require('../models/checklistTemplateModel');
        const ChecklistSubmission = require('../models/checklistSubmissionModel');

        // Get required templates for the target status
        console.log(`Transition Debug: Checking templates for target=${target}`);
        const templates = await ChecklistTemplate.getByRequiredStatus(target);
        console.log(`Transition Debug: Found ${templates.length} templates`);

        for (const template of templates) {
            const submission = await ChecklistSubmission.getByTicketAndTemplate(id, template.id);
            if (!submission) {
                console.log(`Transition Debug: Missing submission for template ${template.name}`);
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
        const previousTicket = await db.query('SELECT status FROM tickets WHERE id = $1 AND deleted_at IS NULL', [id]);
        const fromStatus = previousTicket.rows[0]?.status;
        console.log(`Transition Debug: Updating ticket ${id} from ${fromStatus} to ${target}`);

        const ticket = await Ticket.update(id, updateData);
        console.log(`Transition Debug: Ticket updated`, ticket);

        // Log transition
        console.log(`Transition Debug: Logging transition`);
        await db.query(
            'INSERT INTO ticket_transitions (ticket_id, from_status, to_status, performed_by_user_id, reason) VALUES ($1, $2, $3, $4, $5)',
            [id, fromStatus, target, req.user?.id, reason]
        );

        // Audit the status override
        await AuditService.record(req, {
            action: AUDIT_ACTION.STATUS_CHANGE,
            entity_type: AUDIT_ENTITY.TICKET,
            entity_id: id,
            before_data: { status: fromStatus },
            after_data: { status: target },
            reason,
        });
        res.json(ticket);
    } catch (err) {
        console.error('Transition Error Details:', err);
        res.status(500).json({ error: 'Failed to transition ticket', details: err.message });
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
            sql += ` WHERE t.deleted_at IS NULL AND (` + whereConditions.join(' OR ') + `)`;
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

exports.deleteTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};

        // Soft delete: mark deleted_at, keep the row and all related records intact.
        const ticket = await Ticket.softDelete(id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        await AuditService.record(req, {
            action: AUDIT_ACTION.DELETE,
            entity_type: AUDIT_ENTITY.TICKET,
            entity_id: id,
            before_data: { title: ticket.title, status: ticket.status, project_id: ticket.project_id },
            reason,
        });

        res.json({ message: 'Ticket deleted successfully', ticket });
    } catch (err) {
        console.error('Delete ticket error:', err);
        res.status(500).json({ error: 'Failed to delete ticket', details: err.message });
    }
};

exports.restoreTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};

        const ticket = await Ticket.restore(id);
        if (!ticket) {
            // Distinguish "no such ticket" from "it was never deleted".
            const existing = await Ticket.getByIdIncludingDeleted(id);
            if (!existing) return res.status(404).json({ error: 'Ticket not found' });
            return res.status(409).json({ error: 'Ticket is not deleted', ticket: existing });
        }

        await AuditService.record(req, {
            action: AUDIT_ACTION.RESTORE,
            entity_type: AUDIT_ENTITY.TICKET,
            entity_id: id,
            after_data: { title: ticket.title, status: ticket.status },
            reason,
        });

        res.json({ message: 'Ticket restored successfully', ticket });
    } catch (err) {
        console.error('Restore ticket error:', err);
        res.status(500).json({ error: 'Failed to restore ticket', details: err.message });
    }
};

exports.blockTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const ticket = await Ticket.setBlocked(id, { reason, userId: req.user?.id });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        await AuditService.record(req, {
            action: AUDIT_ACTION.BLOCK,
            entity_type: AUDIT_ENTITY.TICKET,
            entity_id: id,
            after_data: { blocked_reason: reason },
            reason,
        });
        res.json(ticket);
    } catch (err) {
        console.error('Block ticket error:', err);
        res.status(500).json({ error: 'Failed to block ticket' });
    }
};

exports.unblockTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await Ticket.clearBlocked(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        await AuditService.record(req, {
            action: AUDIT_ACTION.UNBLOCK,
            entity_type: AUDIT_ENTITY.TICKET,
            entity_id: id,
        });
        res.json(ticket);
    } catch (err) {
        console.error('Unblock ticket error:', err);
        res.status(500).json({ error: 'Failed to unblock ticket' });
    }
};
