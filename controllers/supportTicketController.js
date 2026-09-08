const SupportTicket = require('../models/supportTicketModel');
const SupportChecklist = require('../models/supportChecklistModel');
const Comment = require('../models/commentModel');
const Ticket = require('../models/ticketModel');
const db = require('../db');
const AuditService = require('../services/auditService');
const AuditLog = require('../models/auditLogModel');
const SlaService = require('../services/slaService');
const Webhook = require('../services/webhookService');
const { checklistLogMessage } = require('../utils/checklistLog');
const {
    AUDIT_ACTION, AUDIT_ENTITY, SUPPORT_TO_TICKET_TYPE,
    SUPPORT_BOARD_CLOSED_DAYS, SUPPORT_ARCHIVED_STATUSES,
} = require('../constants');

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

/**
 * The context the internal group needs to act on a new ticket: which project,
 * which client, and who leads it.
 *
 * Read here rather than left to the receiving system, because the tech lead is
 * a COALESCE of the ticket's override and the project's current lead — a rule
 * that lives in this codebase and should not be reimplemented elsewhere.
 */
async function createdEventContext(ticket, client) {
    const { rows: [ctx] } = await client.query(`
        SELECT COALESCE(p.name, sp.name)                    AS project,
               COALESCE(stco.name, co.name, p.client_name)  AS company,
               COALESCE(tlo.full_name, tlp.full_name)       AS tech_lead,
               dev.full_name                                AS assigned_dev
        FROM support_tickets st
        LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
        LEFT JOIN projects p ON p.id = COALESCE(st.project_id, sp.project_id)
        LEFT JOIN companies co ON co.id = p.company_id
        LEFT JOIN companies stco ON stco.id = st.company_id
        LEFT JOIN users tlo ON tlo.id = st.tech_lead_id
        LEFT JOIN users tlp ON tlp.id = p.tech_lead_id
        LEFT JOIN users dev ON dev.id = st.assigned_dev_id
        WHERE st.id = $1
    `, [ticket.id]);

    return {
        title: ticket.title,
        request_type: ticket.request_type,
        project: ctx?.project || null,
        company: ctx?.company || null,
        tech_lead: ctx?.tech_lead || null,
        assigned_dev: ctx?.assigned_dev || null,
        // The board, not a per-ticket page: support tickets have no deep link
        // of their own yet.
        app_url: `${process.env.APP_URL || 'https://task.ips.com.my'}/#support`,
    };
}

/**
 * Column updates implied by a status change. Kept next to recordStatusChange()
 * so the two halves of "the ticket moved" cannot drift apart.
 */
function statusColumnUpdates(ticket, nextStatus) {
    const updates = { status: nextStatus };

    if ((nextStatus === 'CLOSED' || nextStatus === 'CANCELLED') && !ticket.closed_at) {
        updates.closed_at = new Date().toISOString();
    } else if (nextStatus !== 'CLOSED' && nextStatus !== 'CANCELLED' && ticket.closed_at) {
        // Reopened. Without this a ticket dragged back out of Closed keeps its
        // closed date forever, and the Closed column and the delay report both
        // go on reporting it as finished on a day it plainly was not.
        updates.closed_at = null;
        // The sign-off was for work that has now been reopened, so it no longer
        // stands — same rule a rejection follows. `reviewed_at` means "signed
        // off, and still true", or it means nothing.
        updates.reviewed_at = null;
        updates.reviewed_by_user_id = null;
    }
    return updates;
}

/**
 * The side effects of a support ticket changing status: the transition row, the
 * SLA pause/resume, and the outbox event.
 *
 * Extracted because status is now settable from the unified edit modal as well
 * as from the board drag and the review buttons. Four code paths writing
 * `status` but only one of them opening an sla_pause would leave the resolution
 * clock silently wrong for every ticket parked in WAITING_FOR_CLIENT from the
 * modal.
 *
 * Must run on the caller's transaction client — the outbox event has to commit
 * with the change it describes.
 */
async function recordStatusChange(client, ticket, nextStatus, reason, userId) {
    await client.query(
        `INSERT INTO support_ticket_transitions
             (support_ticket_id, from_status, to_status, performed_by_user_id, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [ticket.id, ticket.status, nextStatus, userId || null, reason || null]
    );

    // Resume BEFORE any deadline recalculation the caller does afterwards, so
    // paused time is banked against the deadline it actually accrued under.
    const wasPaused = ticket.status === PAUSED_STATUS;
    const nowPaused = nextStatus === PAUSED_STATUS;

    if (!wasPaused && nowPaused) {
        await SlaService.pause(
            ticket.id,
            { reason: reason || 'Waiting for client', userId },
            client
        );
    } else if (wasPaused && !nowPaused) {
        await SlaService.resume(ticket.id, {}, client);
    }

    await Webhook.enqueue({
        event: Webhook.EVENTS.STATUS_CHANGED,
        ticket: { ...ticket, status: nextStatus },
        extra: { from: ticket.status, to: nextStatus, reason: reason || null },
    }, client);
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
            assigned_dev_id,
            tech_lead_id,
            reviewer_user_id,
            start_date // Optional
        } = req.body;

        // A cleared <select> posts an empty string, which Postgres cannot cast
        // to uuid. Normalised centrally so no caller has to remember.
        const blankToNull = (v) => (v === '' || v === undefined ? null : v);

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
        const projectId = blankToNull(req.body.project_id)
            || (blankToNull(supporting_project_id)
                ? (await client.query('SELECT project_id FROM supporting_projects WHERE id = $1', [supporting_project_id])).rows[0]?.project_id
                : null);

        const companyId = blankToNull(req.body.company_id)
            || (projectId
                ? (await client.query('SELECT company_id FROM projects WHERE id = $1', [projectId])).rows[0]?.company_id
                : null);

        // 3. Create Ticket
        const ticket = await SupportTicket.create({
            supporting_project_id: blankToNull(supporting_project_id),
            project_id: blankToNull(projectId),
            company_id: blankToNull(companyId),
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
            assigned_dev_id: blankToNull(assigned_dev_id),
            // Left NULL unless the creator deliberately overrode it, so the
            // ticket keeps following the project's tech lead.
            tech_lead_id: blankToNull(tech_lead_id),
            reviewer_user_id: blankToNull(reviewer_user_id)
        }, client);

        // Tells the internal WhatsApp group a ticket now exists. Queued on the
        // same transaction as the insert, so the group can never be told about
        // a ticket that failed to save.
        await Webhook.enqueue({
            event: Webhook.EVENTS.CREATED,
            ticket,
            extra: await createdEventContext(ticket, client),
            channel: Webhook.CHANNELS.WHATSAPP,
        }, client);

        await client.query('COMMIT');

        // Send the announcement now rather than waiting for the cron. Not
        // awaited: the person filing the ticket should not wait on WhatsApp.
        Webhook.flushSoon();

        // Re-read so the response carries project name and the effective tech
        // lead, which the modal shows immediately after create.
        res.status(201).json(await SupportTicket.getById(ticket.id) || ticket);

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

        const statusChanged = Boolean(status) && status !== ticket.status;

        const updateData = {};
        if (statusChanged) Object.assign(updateData, statusColumnUpdates(ticket, status));
        if (actual_end_date) updateData.actual_end_date = actual_end_date;

        // Recompute both deadlines if the clock's starting point moves.
        if (start_date && start_date !== ticket.start_date) {
            updateData.start_date = start_date;
        }

        const updatedTicket = Object.keys(updateData).length
            ? await SupportTicket.update(id, updateData, client)
            : ticket;

        // Transactional outbox, transition row and SLA pause/resume all live in
        // recordStatusChange, shared with the edit modal and the review buttons.
        if (statusChanged) {
            await recordStatusChange(client, ticket, status, reason, req.user?.id);
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

/**
 * PUT /api/support-tickets/:id
 *
 * The one write the unified modal uses. Every field a ticket has is editable
 * here — including project, priority and status — because the edit modal now
 * shows the same fields as the create form and saves them in one go.
 *
 * `status` is handled through the same helper the board drag uses, so a status
 * set from the modal still writes its transition row, opens or closes its SLA
 * pause, and queues its webhook.
 */
const EDITABLE_FIELDS = [
    'title', 'description', 'steps_to_reproduce', 'request_type', 'priority',
    'risk_level', 'assigned_dev_id', 'tech_lead_id',
    'reviewer_user_id', 'start_date', 'actual_end_date', 'project_id',
    'supporting_project_id', 'company_id',
];

exports.updateTicket = async (req, res) => {
    const { id } = req.params;
    const { status, reason } = req.body;

    // Transactional so the assignment webhook is enqueued on the same client as
    // the change it announces — the event cannot exist without the assignment,
    // or the assignment without the event.
    const client = await db.pool.connect();
    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const updateData = {};
        for (const field of EDITABLE_FIELDS) {
            if (req.body[field] !== undefined) updateData[field] = req.body[field];
        }
        // Blank strings arrive from cleared <select>s and <input type=date>s.
        // Written straight through they would fail the UUID / timestamp cast.
        for (const key of Object.keys(updateData)) {
            if (updateData[key] === '') updateData[key] = null;
        }
        if (req.body.attachments !== undefined) {
            updateData.attachments = JSON.stringify(req.body.attachments);
        }

        // Company attribution follows the project unless it was set explicitly.
        // Without this, moving a ticket to another client's project leaves its
        // logged time billing to the old one.
        if (updateData.project_id && updateData.project_id !== ticket.project_id
            && req.body.company_id === undefined) {
            const { rows } = await client.query(
                'SELECT company_id FROM projects WHERE id = $1', [updateData.project_id]
            );
            if (rows[0]) updateData.company_id = rows[0].company_id;
        }

        const statusChanged = Boolean(status) && status !== ticket.status;
        if (statusChanged) Object.assign(updateData, statusColumnUpdates(ticket, status));

        await client.query('BEGIN');

        const updatedTicket = Object.keys(updateData).length
            ? await SupportTicket.update(id, updateData, client)
            : ticket;

        if (statusChanged) {
            await recordStatusChange(client, ticket, status, reason || 'Updated from ticket', req.user?.id);
        }

        // Someone picking the ticket up is news the customer can use, so the
        // workflow is told. No-ops for human-filed tickets.
        const assignmentChanged = updateData.assigned_dev_id !== undefined
            && updateData.assigned_dev_id !== ticket.assigned_dev_id;
        if (assignmentChanged) {
            await Webhook.enqueue({
                event: Webhook.EVENTS.ASSIGNED,
                ticket: updatedTicket,
                extra: { assigned: Boolean(updateData.assigned_dev_id) },
            }, client);
        }

        // Recompute both deadlines when the priority or the clock's start moves.
        // A ticket escalated P3 -> P0 keeping its lazy 80-hour deadline would
        // report as comfortably on time while a customer waits.
        const priorityChanged = updateData.priority !== undefined && updateData.priority !== ticket.priority;
        const startMoved = updateData.start_date !== undefined && updateData.start_date !== ticket.start_date;
        if (priorityChanged || startMoved) {
            await SlaService.applyDeadlines(id, {
                priority: updateData.priority || ticket.priority,
                startAt: updateData.start_date || ticket.start_date || ticket.created_at,
            }, client);
        }

        await client.query('COMMIT');

        if (statusChanged) {
            await AuditService.record(req, {
                action: AUDIT_ACTION.STATUS_CHANGE,
                entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
                entity_id: id,
                before_data: { status: ticket.status },
                after_data: { status },
                reason,
            });
        }

        res.json(await SupportTicket.getById(id));
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('Error in updateTicket:', err);
        res.status(500).json({ error: 'Failed to update ticket', details: err.message });
    } finally {
        client.release();
    }
};

/**
 * POST /api/support-tickets/:id/review/approve
 *
 * Review is deliberately soft: anyone may approve, including the person who did
 * the work, and nothing forces a ticket through it. Approving stamps who signed
 * off and closes the ticket in one action, because "reviewed but still open"
 * was not a state anyone wanted to manage.
 */
exports.approveReview = async (req, res) => {
    const { id } = req.params;
    const client = await db.pool.connect();
    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const now = new Date().toISOString();
        const updates = {
            reviewed_by_user_id: req.user?.id || null,
            reviewed_at: now,
        };

        // Approving is the moment the work is accepted as finished, so the end
        // date is stamped here rather than left to someone remembering. An end
        // date already entered by hand is kept — the person who did the work
        // knows better than the clock when it actually finished.
        if (!ticket.actual_end_date) updates.actual_end_date = now;

        const statusChanged = ticket.status !== 'CLOSED';
        if (statusChanged) Object.assign(updates, statusColumnUpdates(ticket, 'CLOSED'));

        await client.query('BEGIN');
        await SupportTicket.update(id, updates, client);
        if (statusChanged) {
            await recordStatusChange(client, ticket, 'CLOSED', req.body?.note || 'Review approved', req.user?.id);
        }
        await client.query('COMMIT');

        if (statusChanged) {
            await AuditService.record(req, {
                action: AUDIT_ACTION.STATUS_CHANGE,
                entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
                entity_id: id,
                before_data: { status: ticket.status },
                after_data: { status: 'CLOSED', reviewed_by_user_id: req.user?.id },
                reason: 'Review approved',
            });
        }

        res.json(await SupportTicket.getById(id));
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('Approve review error:', err);
        res.status(500).json({ error: 'Failed to approve review', details: err.message });
    } finally {
        client.release();
    }
};

/**
 * POST /api/support-tickets/:id/review/reject
 *
 * The reason is required and lands in the ticket's comment thread — that thread
 * is where the person who has to redo the work will look, and it survives the
 * next round of review. The review stamp is cleared rather than set, so
 * `reviewed_at` never means anything but "signed off".
 */
exports.rejectReview = async (req, res) => {
    const { id } = req.params;
    const reason = (req.body?.reason || '').trim();
    if (!reason) {
        return res.status(400).json({ error: 'A reason is required to reject a review' });
    }

    const client = await db.pool.connect();
    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const updates = { reviewed_by_user_id: null, reviewed_at: null };
        const statusChanged = ticket.status !== 'DOING';
        if (statusChanged) {
            Object.assign(updates, statusColumnUpdates(ticket, 'DOING'));
            // Sent back to work, so it is no longer finished.
            updates.actual_end_date = null;
            updates.closed_at = null;
        }

        await client.query('BEGIN');
        await SupportTicket.update(id, updates, client);
        await Comment.create({
            support_ticket_id: id,
            user_id: req.user?.id,
            content: `Review rejected: ${reason}`,
            is_internal: true,
        }, client);
        if (statusChanged) {
            await recordStatusChange(client, ticket, 'DOING', `Review rejected: ${reason}`, req.user?.id);
        }
        await client.query('COMMIT');

        await AuditService.record(req, {
            action: AUDIT_ACTION.STATUS_CHANGE,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: id,
            before_data: { status: ticket.status },
            after_data: { status: 'DOING' },
            reason: `Review rejected: ${reason}`,
        });

        res.json(await SupportTicket.getById(id));
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('Reject review error:', err);
        res.status(500).json({ error: 'Failed to reject review', details: err.message });
    } finally {
        client.release();
    }
};

// ---- Checklist ----------------------------------------------------------
// A helper list on the ticket, not a gate: nothing here blocks a status change.

/**
 * Records a checklist change against the ticket, in audit_logs.
 *
 * Reuses the audit table rather than adding a checklist_logs one: it already
 * stores actor, before/after and a reason, and already survives a rollback the
 * same way everything else here does.
 */
async function logChecklistChange(req, action, before, after) {
    const message = checklistLogMessage(action, before, after);
    if (!message) return;
    await AuditService.record(req, {
        action: action === 'ADD' ? AUDIT_ACTION.CREATE
            : action === 'DELETE' ? AUDIT_ACTION.DELETE : AUDIT_ACTION.UPDATE,
        entity_type: AUDIT_ENTITY.SUPPORT_CHECKLIST,
        entity_id: req.params.id,
        before_data: before?.id ? { content: before.content, is_done: before.is_done } : null,
        after_data: after?.id ? { content: after.content, is_done: after.is_done } : null,
        reason: message,
    });
}

exports.getChecklist = async (req, res) => {
    try {
        res.json(await SupportChecklist.listByTicket(req.params.id));
    } catch (err) {
        console.error('Checklist read error:', err);
        res.status(500).json({ error: 'Failed to load checklist' });
    }
};

exports.addChecklistItem = async (req, res) => {
    try {
        const content = (req.body?.content || '').trim();
        if (!content) return res.status(400).json({ error: 'content is required' });

        const ticket = await SupportTicket.getById(req.params.id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const item = await SupportChecklist.addItem(req.params.id, {
            content,
            created_by_user_id: req.user?.id,
        });
        await logChecklistChange(req, 'ADD', {}, item);
        res.status(201).json(item);
    } catch (err) {
        console.error('Checklist add error:', err);
        res.status(500).json({ error: 'Failed to add checklist item' });
    }
};

exports.updateChecklistItem = async (req, res) => {
    try {
        const { content, is_done, position } = req.body || {};
        const before = await SupportChecklist.getItem(req.params.itemId, req.params.id);
        const item = await SupportChecklist.updateItem(
            req.params.itemId, req.params.id, { content, is_done, position }, req.user?.id
        );
        if (!item) return res.status(404).json({ error: 'Checklist item not found' });
        await logChecklistChange(req, 'UPDATE', before || {}, item);
        res.json(item);
    } catch (err) {
        console.error('Checklist update error:', err);
        res.status(500).json({ error: 'Failed to update checklist item' });
    }
};

/**
 * GET /api/support-tickets/:id/checklist/log
 *
 * What changed on this ticket's checklist and who changed it. Readable by
 * anyone who can see the ticket — unlike /api/audit-logs, which is manager-only
 * because it carries IP addresses and credit values. Only the change itself
 * goes out here.
 */
exports.getChecklistLog = async (req, res) => {
    try {
        const rows = await AuditLog.getByEntity(AUDIT_ENTITY.SUPPORT_CHECKLIST, req.params.id);
        res.json(rows.map((r) => ({
            id: r.id,
            message: r.reason,
            user_name: r.user_name || null,
            created_at: r.created_at,
        })));
    } catch (err) {
        console.error('Checklist log error:', err);
        res.status(500).json({ error: 'Failed to load checklist log' });
    }
};

exports.deleteChecklistItem = async (req, res) => {
    try {
        const item = await SupportChecklist.deleteItem(req.params.itemId, req.params.id);
        if (!item) return res.status(404).json({ error: 'Checklist item not found' });
        await logChecklistChange(req, 'DELETE', item, {});
        res.json({ message: 'Checklist item deleted', item });
    } catch (err) {
        console.error('Checklist delete error:', err);
        res.status(500).json({ error: 'Failed to delete checklist item' });
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
        // Joined through COALESCE(st.project_id, sp.project_id): the old query
        // only knew about supporting_projects, so every ticket created the
        // modern way (and every ticket the AI workflow files) showed a blank
        // project — which also made a project filter impossible.
        const result = await db.query(`
            SELECT st.*,
                   COALESCE(p.name, sp.name)                              AS project_name,
                   COALESCE(p.id, sp.project_id)                          AS resolved_project_id,
                   COALESCE(stco.name, co.name, p.client_name)            AS client_name,
                   assignee.full_name                                     AS assigned_to_name,
                   assignee.full_name                                     AS assigned_dev_name,
                   COALESCE(st.tech_lead_id, p.tech_lead_id)              AS effective_tech_lead_id,
                   COALESCE(tlo.full_name, tlp.full_name)                 AS tech_lead_name,
                   rev.full_name                                          AS reviewer_name,
                   revby.full_name                                        AS reviewed_by_name
            FROM support_tickets st
            LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
            LEFT JOIN projects p ON p.id = COALESCE(st.project_id, sp.project_id)
            LEFT JOIN companies co ON co.id = p.company_id
            LEFT JOIN companies stco ON stco.id = st.company_id
            LEFT JOIN users assignee ON st.assigned_dev_id = assignee.id
            LEFT JOIN users tlo ON st.tech_lead_id = tlo.id
            LEFT JOIN users tlp ON p.tech_lead_id = tlp.id
            LEFT JOIN users rev ON st.reviewer_user_id = rev.id
            LEFT JOIN users revby ON st.reviewed_by_user_id = revby.id
            WHERE st.deleted_at IS NULL
              -- A finished ticket stays on the board for a while so it can be
              -- seen and reopened, then belongs to History. closed_at can be
              -- null on older rows, hence the fallback.
              AND (
                    st.status NOT IN (${SUPPORT_ARCHIVED_STATUSES.map((x) => `'${x}'`).join(',')})
                 OR COALESCE(st.closed_at, st.updated_at) >= now() - interval '${SUPPORT_BOARD_CLOSED_DAYS} days'
              )
            ORDER BY st.created_at DESC
        `);

        // One grouped query for every card's "3/5 done", rather than a checklist
        // read per ticket.
        const progress = await SupportChecklist.progressFor(result.rows.map((r) => r.id));
        res.json(result.rows.map((r) => ({
            ...r,
            checklist: progress.get(r.id) || { total: 0, done: 0 },
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch support tickets' });
    }
};

/**
 * GET /api/support-tickets/history
 *
 * Every ticket that has finished, however long ago.
 *
 * Separate from the board rather than a filter on it, because the two answer
 * different questions: the board is "what is happening", history is "what
 * happened to that ticket in March". The board drops a ticket
 * SUPPORT_BOARD_CLOSED_DAYS after it closes; nothing ever leaves here.
 *
 * Paged, filtered and searched on the server. This table only grows, and a page
 * that fetches every closed ticket a company has ever had gets slower every
 * week until someone notices.
 *
 * Query: q, project_id, assigned_dev_id, priority, request_type, status,
 *        from, to, page, limit
 */
exports.getHistory = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const offset = (page - 1) * limit;

        const where = [
            'st.deleted_at IS NULL',
            `st.status IN (${SUPPORT_ARCHIVED_STATUSES.map((x) => `'${x}'`).join(',')})`,
        ];
        const params = [];
        const add = (clause, value) => { params.push(value); where.push(clause.replace('$?', `$${params.length}`)); };

        if (req.query.project_id) add('COALESCE(st.project_id, sp.project_id) = $?', req.query.project_id);
        if (req.query.assigned_dev_id) {
            // "unassigned" is a real thing to filter for, and it is not a uuid.
            if (req.query.assigned_dev_id === 'unassigned') where.push('st.assigned_dev_id IS NULL');
            else add('st.assigned_dev_id = $?', req.query.assigned_dev_id);
        }
        if (req.query.priority) add('st.priority = $?', req.query.priority);
        if (req.query.request_type) add('st.request_type = $?', req.query.request_type);
        if (req.query.status) add('st.status = $?', req.query.status);
        if (req.query.from) add('COALESCE(st.closed_at, st.updated_at) >= $?::date', req.query.from);
        if (req.query.to) add("COALESCE(st.closed_at, st.updated_at) < ($?::date + INTERVAL '1 day')", req.query.to);

        if (req.query.q && String(req.query.q).trim()) {
            params.push(`%${String(req.query.q).trim()}%`);
            const i = params.length;
            where.push(`(st.ticket_key ILIKE $${i} OR st.title ILIKE $${i} OR st.description ILIKE $${i})`);
        }

        const from = `
            FROM support_tickets st
            LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
            LEFT JOIN projects p ON p.id = COALESCE(st.project_id, sp.project_id)
            LEFT JOIN companies co ON co.id = p.company_id
            LEFT JOIN companies stco ON stco.id = st.company_id
            LEFT JOIN users dev ON st.assigned_dev_id = dev.id
            LEFT JOIN users tlo ON tlo.id = st.tech_lead_id
            LEFT JOIN users tlp ON tlp.id = p.tech_lead_id
            LEFT JOIN users revby ON revby.id = st.reviewed_by_user_id
            WHERE ${where.join(' AND ')}
        `;

        const { rows: [{ total }] } = await db.query(`SELECT count(*)::int AS total ${from}`, params);

        const { rows } = await db.query(`
            SELECT st.*,
                   COALESCE(p.name, sp.name)                   AS project_name,
                   COALESCE(stco.name, co.name, p.client_name) AS client_name,
                   dev.full_name                               AS assigned_dev_name,
                   dev.full_name                               AS assigned_to_name,
                   COALESCE(tlo.full_name, tlp.full_name)      AS tech_lead_name,
                   revby.full_name                             AS reviewed_by_name,
                   COALESCE(st.closed_at, st.updated_at)       AS archived_at
            ${from}
            ORDER BY COALESCE(st.closed_at, st.updated_at) DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);

        res.json({
            tickets: rows,
            total,
            page,
            limit,
            pages: Math.max(1, Math.ceil(total / limit)),
            board_retention_days: SUPPORT_BOARD_CLOSED_DAYS,
        });
    } catch (err) {
        console.error('Support history error:', err);
        res.status(500).json({ error: 'Failed to load history', details: err.message });
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
