const SupportTicket = require('../models/supportTicketModel');
const Ticket = require('../models/ticketModel');
const db = require('../db');
const AuditService = require('../services/auditService');
const SlaService = require('../services/slaService');
const { AUDIT_ACTION, AUDIT_ENTITY, SUPPORT_TO_TICKET_TYPE } = require('../constants');

// The status that stops the resolution clock. Entering it opens an sla_pause;
// leaving it closes the pause and pushes resolution_due_at forward.
const PAUSED_STATUS = 'WAITING_FOR_CLIENT';

/**
 * Business-hours SLA deadlines for a ticket.
 * Replaces the old wall-clock calculateSLA(), which gave a P0 raised at 17:30
 * on a Friday a deadline of 19:30 that same evening.
 */
async function deadlinesFor(priority, startDate, client) {
    const { holidays, targets } = await SlaService.loadCalendar(client);
    return SlaService.computeDeadlines({
        priority,
        startAt: startDate || new Date(),
        targets,
        holidays,
    });
}

exports.createTicket = async (req, res) => {
    // Key allocation and the insert share a transaction: a failed insert rolls
    // the counter back rather than burning a number, and two concurrent callers
    // serialise on the counter row instead of racing.
    const client = await db.pool.connect();
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

        await client.query('BEGIN');

        // 1. Allocate ID SC-YYYYMM-XXXX atomically
        const dateObj = new Date();
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const prefix = `SC-${yyyy}${mm}`;

        const ticket_key = await SupportTicket.nextTicketKey(prefix, client);

        // 2. Calculate SLA deadlines on the business calendar
        const { first_response_due_at, resolution_due_at } = await deadlinesFor(priority, start_date, client);

        // 2b. Resolve project and company.
        //
        // project_id is the path forward; supporting_project_id is legacy and
        // still accepted so existing clients keep working. company_id is copied
        // onto the ticket rather than always joined through the project, so
        // attribution survives a project being reassigned later.
        const projectId = req.body.project_id
            || (supporting_project_id
                ? (await client.query('SELECT project_id FROM supporting_projects WHERE id = $1', [supporting_project_id])).rows[0]?.project_id
                : null);

        const companyId = req.body.company_id
            || (projectId
                ? (await client.query('SELECT company_id FROM projects WHERE id = $1', [projectId])).rows[0]?.company_id
                : null);

        // 3. Create Ticket
        const ticket = await SupportTicket.create({
            supporting_project_id,
            project_id: projectId,
            company_id: companyId,
            ticket_key,
            request_type,
            priority,
            risk_level,
            title,
            description,
            steps_to_reproduce,
            attachments,
            start_date,
            // sla_due_at is kept in step with resolution_due_at so existing
            // callers and dashboards reading the old column stay correct.
            sla_due_at: resolution_due_at,
            first_response_due_at,
            resolution_due_at,
            created_by_user_id: req.user?.id, // Assuming auth middleware
            assigned_pm_id,
            assigned_dev_id
        }, client);

        await client.query('COMMIT');

        res.status(201).json(ticket);

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('Create support ticket error:', err);
        res.status(500).json({ error: 'Failed to create support ticket' });
    } finally {
        client.release();
    }
};

exports.transitionTicket = async (req, res) => {
    const { id } = req.params;
    const { status, reason, start_date, actual_end_date, priority } = req.body;

    // Status change, transition log and SLA pause/resume all move together or
    // not at all. The transition insert used to be a swallowing try/catch —
    // acceptable for a log line, not for a pause record the resolution clock
    // is computed from.
    const client = await db.pool.connect();
    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        await client.query('BEGIN');

        const updateData = {};
        if (status) updateData.status = status;
        if (actual_end_date) updateData.actual_end_date = actual_end_date;

        // Recompute both deadlines if the clock's starting point moves.
        if (start_date && start_date !== ticket.start_date) {
            updateData.start_date = start_date;
        }

        if (status === 'CLOSED' && !ticket.closed_at) {
            updateData.closed_at = new Date().toISOString();
        }

        const updatedTicket = Object.keys(updateData).length
            ? await SupportTicket.update(id, updateData, client)
            : ticket;

        const statusChanged = Boolean(status) && status !== ticket.status;

        if (statusChanged) {
            await client.query(
                'INSERT INTO support_ticket_transitions (support_ticket_id, from_status, to_status, performed_by_user_id, reason) VALUES ($1, $2, $3, $4, $5)',
                [id, ticket.status, status, req.user?.id, reason]
            );

            // --- SLA pause / resume ---
            // Resuming BEFORE any deadline recalculation below, so the paused
            // time is banked against the deadline it actually accrued under.
            const wasPaused = ticket.status === PAUSED_STATUS;
            const nowPaused = status === PAUSED_STATUS;

            if (!wasPaused && nowPaused) {
                await SlaService.pause(
                    id,
                    { reason: reason || 'Waiting for client', userId: req.user?.id },
                    client
                );
            } else if (wasPaused && !nowPaused) {
                await SlaService.resume(id, {}, client);
            }
        }

        // A moved start_date or changed priority invalidates both deadlines.
        // Done last so it overwrites anything resume() just wrote.
        const priorityChanged = Boolean(priority) && priority !== ticket.priority;
        const startMoved = Boolean(start_date) && start_date !== ticket.start_date;
        if (priorityChanged || startMoved) {
            await SlaService.applyDeadlines(
                id,
                {
                    priority: priority || ticket.priority,
                    startAt: start_date || ticket.start_date || ticket.created_at,
                },
                client
            );
        }

        await client.query('COMMIT');

        if (statusChanged) {
            // Outside the transaction: an audit write must never roll back the
            // user's action (AuditService already swallows its own failures).
            await AuditService.record(req, {
                action: AUDIT_ACTION.STATUS_CHANGE,
                entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
                entity_id: id,
                before_data: { status: ticket.status },
                after_data: { status },
                reason,
            });
        }

        // Re-read so the response carries the deadlines slaService just wrote.
        const fresh = await SupportTicket.getById(id);
        res.json(fresh || updatedTicket);

    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('Transition error:', err);
        res.status(500).json({ error: 'Failed to transition ticket' });
    } finally {
        client.release();
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

        const updatedTicket = Object.keys(updateData).length
            ? await SupportTicket.update(id, updateData)
            : ticket;

        // Recompute both deadlines when the priority or the clock's start moves.
        // Done after the update so it reads the ticket's new values.
        const priorityChanged = priority !== undefined && priority !== ticket.priority;
        const startMoved = start_date !== undefined && start_date !== ticket.start_date;
        if (priorityChanged || startMoved) {
            await SlaService.applyDeadlines(id, {
                priority: priority || ticket.priority,
                startAt: start_date || ticket.start_date || ticket.created_at,
            });
            return res.json(await SupportTicket.getById(id));
        }

        res.json(updatedTicket);
    } catch (err) {
        console.error('Error in updateTicket:', err);
        res.status(500).json({ error: 'Failed to update ticket', details: err.message });
    }
};

/**
 * GET /api/support-tickets/:id/sla
 *
 * Computed SLA state for one ticket: both clocks, consumption, paused time and
 * whether it has actually breached. Kept separate from the ticket payload
 * because it is derived at read time from the business calendar, not stored —
 * and because the columns it needs only exist after migrate_sla_v2.
 */
exports.getSlaStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const { rows: [openPause] } = await db.query(
            `SELECT paused_at, reason FROM sla_pauses
             WHERE support_ticket_id = $1 AND resumed_at IS NULL
             ORDER BY paused_at DESC LIMIT 1`,
            [id]
        );

        const { holidays, targets } = await SlaService.loadCalendar();
        const sla = SlaService.slaStatus(ticket, { holidays, targets, openPause });

        const { rows: pauses } = await db.query(
            `SELECT paused_at, resumed_at, reason FROM sla_pauses
             WHERE support_ticket_id = $1 ORDER BY paused_at`,
            [id]
        );

        res.json({
            ...sla,
            breached: SlaService.isBreached(sla),
            target: targets[ticket.priority] || null,
            pauses,
        });
    } catch (err) {
        // The SLA tables may not exist yet on an un-migrated database. That is
        // a missing feature, not a server fault — say so plainly so the UI can
        // hide the panel instead of showing an error.
        if (err.code === '42P01' || err.code === '42703') {
            return res.status(501).json({ error: 'SLA tracking is not enabled on this database' });
        }
        console.error('SLA status error:', err);
        res.status(500).json({ error: 'Failed to compute SLA status', details: err.message });
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
            return res.status(404).json({ error: 'Support ticket not found' });
        }
        if (support.linked_ticket_id) {
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
