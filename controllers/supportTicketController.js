const SupportTicket = require('../models/supportTicketModel');
const Ticket = require('../models/ticketModel');
const db = require('../db');
const AuditService = require('../services/auditService');
const { AUDIT_ACTION, AUDIT_ENTITY, SUPPORT_TO_TICKET_TYPE } = require('../constants');

// Helper for SLA Calculation
// Helper for SLA Calculation
function calculateSLA(priority, startDate) {
    const start = startDate ? new Date(startDate) : new Date();
    // Simplified logic: P0=2h, P1=24h, P2=5d, P3=14d
    // TODO: Implement business hours logic
    switch (priority) {
        case 'P0':
            return new Date(start.getTime() + 2 * 60 * 60 * 1000); // 2 hours
        case 'P1':
            return new Date(start.getTime() + 24 * 60 * 60 * 1000); // 24 hours
        case 'P2':
            const p2Date = new Date(start);
            p2Date.setDate(p2Date.getDate() + 5);
            return p2Date;
        case 'P3':
            const p3Date = new Date(start);
            p3Date.setDate(p3Date.getDate() + 14);
            return p3Date;
        default:
            return null;
    }
}

exports.createTicket = async (req, res) => {
    try {
        const {
            supporting_project_id,
            request_type,
            priority,
            risk_level,
            title,
            description,
            steps_to_reproduce,
            attachments,
            assigned_pm_id,
            assigned_dev_id,
            start_date // Optional
        } = req.body;

        // 1. Generate ID SC-YYYYMM-XXXX
        const dateObj = new Date();
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const prefix = `SC-${yyyy}${mm}`;

        const latestKey = await SupportTicket.getLatestKey(prefix);
        let sequence = 1;
        if (latestKey) {
            const parts = latestKey.split('-');
            const lastNum = parseInt(parts[2], 10);
            if (!isNaN(lastNum)) sequence = lastNum + 1;
        }
        const ticket_key = `${prefix}-${String(sequence).padStart(4, '0')}`;

        // 2. Calculate SLA
        const sla_due_at = calculateSLA(priority, start_date);

        // 3. Create Ticket
        const ticket = await SupportTicket.create({
            supporting_project_id,
            ticket_key,
            request_type,
            priority,
            risk_level,
            title,
            description,
            steps_to_reproduce,
            description,
            steps_to_reproduce,
            attachments,
            start_date,
            sla_due_at,
            created_by_user_id: req.user?.id, // Assuming auth middleware
            assigned_pm_id,
            assigned_dev_id
        });

        res.status(201).json(ticket);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create support ticket' });
    }
};

exports.transitionTicket = async (req, res) => {
    // Similar to existing transition but simpler initially (just status update)
    const { id } = req.params;
    const { status, reason, start_date, actual_end_date, priority } = req.body; // Allow updating dates/priority here too?

    console.log('Support Ticket Transition:', { id, status, reason });

    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        console.log('Current ticket status:', ticket.status, '-> New status:', status);

        const updateData = {};
        if (status) updateData.status = status;
        if (actual_end_date) updateData.actual_end_date = actual_end_date;

        // If start_date changes, recalculate SLA
        // Also if priority changes (not in req.body usually for transition, but if edited, handled elsewhere? 
        // Let's assume this endpoint might handle edits too or we create a separate update endpoint. 
        // For now, let's assume this handles Updates + Transitions.
        let newSla = null;
        if (start_date && start_date !== ticket.start_date) {
            updateData.start_date = start_date;
            newSla = calculateSLA(priority || ticket.priority, start_date);
            updateData.sla_due_at = newSla;
        }

        if (status === 'CLOSED' && !ticket.closed_at) {
            updateData.closed_at = new Date().toISOString();
        }

        console.log('Update data:', updateData);
        const updatedTicket = await SupportTicket.update(id, updateData);
        console.log('Updated ticket:', updatedTicket?.status);

        // Log transition ONLY if status changed (wrap in try-catch to not fail the main operation)
        if (status && status !== ticket.status) {
            try {
                await db.query(
                    'INSERT INTO support_ticket_transitions (support_ticket_id, from_status, to_status, performed_by_user_id, reason) VALUES ($1, $2, $3, $4, $5)',
                    [id, ticket.status, status, req.user?.id, reason]
                );
            } catch (logErr) {
                console.log('Transition log failed (non-critical):', logErr.message);
            }

            await AuditService.record(req, {
                action: AUDIT_ACTION.STATUS_CHANGE,
                entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
                entity_id: id,
                before_data: { status: ticket.status },
                after_data: { status },
                reason,
            });
        }

        res.json(updatedTicket);

    } catch (err) {
        console.error('Transition error:', err);
        res.status(500).json({ error: 'Failed to transition ticket' });
    }
};

exports.updateTicket = async (req, res) => {
    const { id } = req.params;
    const { title, description, priority, risk_level, steps_to_reproduce, expected_result, actual_result, user_impact, assigned_dev_id, start_date, actual_end_date } = req.body;

    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const updateData = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (priority !== undefined) updateData.priority = priority;
        if (risk_level !== undefined) updateData.risk_level = risk_level;
        if (steps_to_reproduce !== undefined) updateData.steps_to_reproduce = steps_to_reproduce;
        if (assigned_dev_id !== undefined) updateData.assigned_dev_id = assigned_dev_id;
        if (start_date !== undefined) updateData.start_date = start_date;
        if (actual_end_date !== undefined) updateData.actual_end_date = actual_end_date;
        if (req.body.attachments !== undefined) {
            updateData.attachments = JSON.stringify(req.body.attachments);
        }

        // Recalculate SLA if priority changes
        if (priority && priority !== ticket.priority) {
            const newSla = calculateSLA(priority, ticket.start_date);
            updateData.sla_due_at = newSla;
        }

        const updatedTicket = await SupportTicket.update(id, updateData);
        res.json(updatedTicket);
    } catch (err) {
        console.error('Error in updateTicket:', err); // Debug Log
        console.error('Update Data was:', updateData); // Debug Log
        res.status(500).json({ error: 'Failed to update ticket', details: err.message });
    }
};

exports.getBoardTickets = async (req, res) => {
    try {
        // Fetch all support tickets, ordered by created_at DESC or updated_at
        // In real app, filter by project if needed. For now, fetch all visibility.
        const result = await db.query(`
            SELECT st.*, 
                   sp.name as project_name,
                   assignee.full_name as assigned_to_name
            FROM support_tickets st
            LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
            LEFT JOIN users assignee ON st.assigned_dev_id = assignee.id
            WHERE st.deleted_at IS NULL
            ORDER BY st.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch support tickets' });
    }
};

exports.deleteSupportTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};

        // Soft delete: preserve the row and its transitions/evaluations.
        const ticket = await SupportTicket.softDelete(id);
        if (!ticket) {
            return res.status(404).json({ error: 'Support ticket not found' });
        }

        await AuditService.record(req, {
            action: AUDIT_ACTION.DELETE,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: id,
            before_data: { ticket_key: ticket.ticket_key, title: ticket.title, status: ticket.status },
            reason,
        });

        res.json({ message: 'Support ticket deleted successfully', ticket });
    } catch (err) {
        console.error('Delete support ticket error:', err);
        res.status(500).json({ error: 'Failed to delete support ticket' });
    }
};

exports.restoreSupportTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};

        const ticket = await SupportTicket.restore(id);
        if (!ticket) {
            const existing = await SupportTicket.getByIdIncludingDeleted(id);
            if (!existing) return res.status(404).json({ error: 'Support ticket not found' });
            return res.status(409).json({ error: 'Support ticket is not deleted', ticket: existing });
        }

        await AuditService.record(req, {
            action: AUDIT_ACTION.RESTORE,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: id,
            after_data: { ticket_key: ticket.ticket_key, status: ticket.status },
            reason,
        });

        // A linked dev ticket may have been deleted while this was gone —
        // surface that rather than returning a silently dangling reference.
        const withLink = await SupportTicket.getByIdIncludingDeleted(id);

        res.json({
            message: 'Support ticket restored successfully',
            ticket,
            linked_ticket_active: withLink?.linked_ticket_active ?? null,
        });
    } catch (err) {
        console.error('Restore support ticket error:', err);
        res.status(500).json({ error: 'Failed to restore support ticket', details: err.message });
    }
};

exports.blockSupportTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;
        const ticket = await SupportTicket.setBlocked(id, { reason, userId: req.user?.id });
        if (!ticket) return res.status(404).json({ error: 'Support ticket not found' });

        await AuditService.record(req, {
            action: AUDIT_ACTION.BLOCK,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: id,
            after_data: { blocked_reason: reason },
            reason,
        });
        res.json(ticket);
    } catch (err) {
        console.error('Block support ticket error:', err);
        res.status(500).json({ error: 'Failed to block support ticket' });
    }
};

exports.unblockSupportTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await SupportTicket.clearBlocked(id);
        if (!ticket) return res.status(404).json({ error: 'Support ticket not found' });

        await AuditService.record(req, {
            action: AUDIT_ACTION.UNBLOCK,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: id,
        });
        res.json(ticket);
    } catch (err) {
        console.error('Unblock support ticket error:', err);
        res.status(500).json({ error: 'Failed to unblock support ticket' });
    }
};

// Link an existing dev ticket to this support ticket (no new ticket created).
exports.linkTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { ticket_id } = req.body;

        const support = await SupportTicket.getById(id);
        if (!support) return res.status(404).json({ error: 'Support ticket not found' });

        const target = await Ticket.getById(ticket_id);
        if (!target) return res.status(404).json({ error: 'Target dev ticket not found' });

        const updated = await SupportTicket.setLinkedTicket(id, ticket_id);
        await AuditService.record(req, {
            action: AUDIT_ACTION.LINK,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: id,
            after_data: { linked_ticket_id: ticket_id },
        });
        res.json(updated);
    } catch (err) {
        console.error('Link support ticket error:', err);
        res.status(500).json({ error: 'Failed to link support ticket' });
    }
};

// Convert a support ticket into a new development ticket, inheriting its context.
exports.convertToTicket = async (req, res) => {
    const { id } = req.params;
    const { project_id, list_id } = req.body;

    const client = await db.pool.connect();
    try {
        const support = await SupportTicket.getById(id);
        if (!support) {
            client.release();
            return res.status(404).json({ error: 'Support ticket not found' });
        }
        if (support.linked_ticket_id) {
            client.release();
            return res.status(409).json({
                error: 'This support ticket is already linked to a dev ticket',
                linked_ticket_id: support.linked_ticket_id,
            });
        }

        await client.query('BEGIN');

        // Pick a target list: the caller's, else the project's first list by position.
        let targetListId = list_id || null;
        if (!targetListId) {
            const listRes = await client.query(
                'SELECT id FROM lists WHERE project_id = $1 ORDER BY position ASC NULLS LAST, created_at ASC LIMIT 1',
                [project_id]
            );
            targetListId = listRes.rows[0]?.id || null;
        }

        const ticketType = SUPPORT_TO_TICKET_TYPE[support.request_type] || 'CHANGE_REQUEST';
        const title = `[${support.ticket_key}] ${support.title}`;
        const descriptionParts = [];
        if (support.description) descriptionParts.push(support.description);
        if (support.steps_to_reproduce) descriptionParts.push(`\n\nSteps to reproduce:\n${support.steps_to_reproduce}`);
        descriptionParts.push(`\n\n(Converted from support ticket ${support.ticket_key})`);

        const insertRes = await client.query(
            `INSERT INTO tickets (project_id, title, description, type, assigned_to_user_id, list_id, start_date, attachments)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
             RETURNING *`,
            [
                project_id,
                title,
                descriptionParts.join(''),
                ticketType,
                support.assigned_dev_id || null,
                targetListId,
                JSON.stringify(support.attachments || []),
            ]
        );
        const newTicket = insertRes.rows[0];

        // Mirror assignment into the members junction so it shows in My Work / boards.
        if (support.assigned_dev_id) {
            await client.query(
                'INSERT INTO ticket_assignments (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [newTicket.id, support.assigned_dev_id]
            );
        }

        await SupportTicket.setLinkedTicket(id, newTicket.id, client);

        await AuditService.record(req, {
            action: AUDIT_ACTION.CONVERT,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: id,
            after_data: { linked_ticket_id: newTicket.id, project_id, ticket_type: ticketType },
        }, client);

        await client.query('COMMIT');
        res.status(201).json({ support_ticket_id: id, ticket: newTicket });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Convert support ticket error:', err);
        res.status(500).json({ error: 'Failed to convert support ticket', details: err.message });
    } finally {
        client.release();
    }
};
