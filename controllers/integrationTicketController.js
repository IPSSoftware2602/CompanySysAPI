const db = require('../db');
const SupportTicket = require('../models/supportTicketModel');
const SlaService = require('../services/slaService');
const AuditService = require('../services/auditService');
const Idempotency = require('../services/idempotencyService');
const Webhook = require('../services/webhookService');
const { AUDIT_ACTION, AUDIT_ENTITY, SUPPORT_PRIORITIES, SUPPORT_REQUEST_TYPES } = require('../constants');

/**
 * The AI workflow's view of a ticket.
 *
 * Deliberately not the raw row: internal assignment, SLA internals and audit
 * detail are ours, not the workflow's. It only needs enough to correlate and to
 * tell the customer where things stand.
 */
function present(t) {
    return {
        ticket_key: t.ticket_key,
        external_ref: t.external_ref,
        status: t.status,
        priority: t.priority,
        suggested_priority: t.suggested_priority,
        request_type: t.request_type,
        title: t.title,
        company: t.client_name || null,
        project: t.project_name || null,
        created_at: t.created_at,
        updated_at: t.updated_at,
        resolved_at: t.actual_end_date || null,
        closed_at: t.closed_at || null,
        cancellation_requested_at: t.cancellation_requested_at || null,
    };
}

/** Statuses where cancelling costs nobody any work. */
const CANCELLABLE_DIRECTLY = ['NEW', 'TRIAGING'];
/** Already finished — cancelling is meaningless. */
const TERMINAL = ['COMPLETED', 'CLOSED', 'CANCELLED'];

/** Resolves company_code / project_code to ids. */
async function resolveContext({ company_code, project_code }, client) {
    let company = null;
    let project = null;

    if (company_code) {
        const { rows } = await client.query(
            `SELECT id, name FROM companies
             WHERE (account_code = $1 OR lower(name) = lower($1)) AND deleted_at IS NULL`,
            [company_code]
        );
        company = rows[0] || null;
    }

    if (project_code) {
        const { rows } = await client.query(
            `SELECT id, name, company_id FROM projects
             WHERE lower(name) = lower($1) ${company ? 'AND company_id = $2' : ''}`,
            company ? [project_code, company.id] : [project_code]
        );
        project = rows[0] || null;
    }

    return { company, project };
}

/**
 * POST /api/integration/v1/tickets
 * Header: Idempotency-Key
 */
exports.submit = async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
        return res.status(400).json({
            error: 'Idempotency-Key header is required',
            hint: 'Use a stable UUID per customer issue so a retry cannot file a second ticket.',
        });
    }

    const {
        external_ref, company_code, project_code,
        request_type, suggested_priority,
        title, description, steps_to_reproduce,
        reported_by_name, reported_by_contact,
        ai_summary, ai_preliminary_diagnosis,
        first_responded_at, attachments,
    } = req.body || {};

    // --- validation before claiming, so a bad request does not burn the key ---
    const errors = [];
    if (!title || !String(title).trim()) errors.push('title is required');
    if (!request_type) errors.push('request_type is required');
    else if (!SUPPORT_REQUEST_TYPES.includes(request_type)) {
        errors.push(`request_type must be one of: ${SUPPORT_REQUEST_TYPES.join(', ')}`);
    }
    if (suggested_priority && !SUPPORT_PRIORITIES.includes(suggested_priority)) {
        errors.push(`suggested_priority must be one of: ${SUPPORT_PRIORITIES.join(', ')}`);
    }
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const claimed = await Idempotency.claim({
        key: idempotencyKey,
        endpoint: 'POST /tickets',
        apiKeyId: req.apiKey?.id,
    });

    if (claimed.outcome === 'REPLAY') {
        // Same key, same endpoint, already done — hand back exactly what the
        // original request got. 200 not 201: nothing was created this time.
        return res.status(200).json({ ...claimed.stored.response_body, replayed: true });
    }
    if (claimed.outcome === 'IN_FLIGHT') {
        return res.status(409).json({ error: 'A request with this Idempotency-Key is still being processed' });
    }
    if (claimed.outcome === 'CONFLICT_ENDPOINT') {
        return res.status(422).json({ error: 'This Idempotency-Key was already used for a different endpoint' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const { company, project } = await resolveContext({ company_code, project_code }, client);

        // The AI proposes a priority; the system picks the starting value. P3
        // is the deliberate default — an unreviewed ticket should not be able
        // to page anyone until a human has looked at it.
        const priority = suggested_priority || 'P3';

        const now = new Date();
        const prefix = `SC-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
        const ticket_key = await SupportTicket.nextTicketKey(prefix, client);

        const { holidays, targets } = await SlaService.loadCalendar(client);
        const deadlines = SlaService.computeDeadlines({ priority, startAt: now, targets, holidays });

        const ticket = await SupportTicket.create({
            ticket_key,
            project_id: project?.id || null,
            company_id: company?.id || project?.company_id || null,
            request_type,
            priority,
            title: String(title).trim(),
            description,
            steps_to_reproduce,
            attachments,
            start_date: now,
            sla_due_at: deadlines.resolution_due_at,
            first_response_due_at: deadlines.first_response_due_at,
            resolution_due_at: deadlines.resolution_due_at,
            created_by_user_id: null,
        }, client);

        // Fields the model's create() does not take, plus first_responded_at:
        // the AI already replied on WhatsApp before this ticket existed, so
        // without it every AI-filed ticket looks like an instant SLA breach.
        await client.query(
            `UPDATE support_tickets
             SET source = 'AI_WORKFLOW', external_ref = $2, suggested_priority = $3,
                 reported_by_name = $4, reported_by_contact = $5,
                 ai_summary = $6, ai_preliminary_diagnosis = $7,
                 first_response_at = COALESCE($8, first_response_at)
             WHERE id = $1`,
            [ticket.id, external_ref || null, suggested_priority || null,
                reported_by_name || null, reported_by_contact || null,
                ai_summary || null, ai_preliminary_diagnosis || null,
                first_responded_at || null]
        );

        await client.query('COMMIT');

        const fresh = await SupportTicket.getById(ticket.id);
        const body = present(fresh);

        await Idempotency.complete({ key: idempotencyKey, statusCode: 201, body, ticketId: ticket.id });

        await AuditService.record(req, {
            action: AUDIT_ACTION.CREATE,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: ticket.id,
            after_data: { source: 'AI_WORKFLOW', external_ref, ticket_key, suggested_priority },
            reason: 'Filed by AI workflow',
        });

        // Be precise about what actually happened. An unknown company_code that
        // still resolved through the project IS attributed, and saying
        // "unattributed" would send someone hunting a billing problem that does
        // not exist.
        const warnings = [];
        if (company_code && !company) {
            warnings.push(project?.company_id
                ? `Unknown company_code "${company_code}" — attributed via project "${project.name}" instead`
                : `Unknown company_code "${company_code}" — ticket is unattributed and will reach no invoice`);
        }
        if (project_code && !project) warnings.push(`Unknown project_code "${project_code}"`);
        if (!company && !project?.company_id) {
            warnings.push('Ticket has no company — time logged against it cannot be billed');
        }

        res.status(201).json(warnings.length ? { ...body, warnings } : body);
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        // Release the claim so a genuine retry can succeed. Leaving it would
        // poison the key: every retry would see an in-flight claim forever.
        await Idempotency.release(idempotencyKey).catch(() => {});
        console.error('[integration] submit failed:', err);
        res.status(500).json({ error: 'Failed to create ticket' });
    } finally {
        client.release();
    }
};

/** PATCH /api/integration/v1/tickets/:ticket_key */
exports.update = async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT * FROM support_tickets WHERE ticket_key = $1 AND deleted_at IS NULL',
            [req.params.ticket_key]
        );
        const ticket = rows[0];
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        // The workflow proposes; CompanySys decides. status, priority,
        // assignment and every SLA field are ours -- accepting them here would
        // let an external system mark its own ticket resolved.
        const ALLOWED = [
            'description', 'steps_to_reproduce', 'suggested_priority',
            'ai_summary', 'ai_preliminary_diagnosis',
            'reported_by_name', 'reported_by_contact', 'external_ref',
        ];
        const REJECTED = ['status', 'priority', 'assigned_dev_id', 'assigned_pm_id',
            'first_response_due_at', 'resolution_due_at', 'sla_due_at', 'actual_end_date', 'closed_at'];

        const attempted = Object.keys(req.body || {});
        const forbidden = attempted.filter((k) => REJECTED.includes(k));
        if (forbidden.length) {
            return res.status(403).json({
                error: 'These fields are managed by CompanySys and cannot be set externally',
                fields: forbidden,
            });
        }

        if (TERMINAL.includes(ticket.status)) {
            return res.status(409).json({ error: `Ticket is ${ticket.status} and can no longer be updated` });
        }

        const updates = {};
        for (const k of ALLOWED) if (req.body[k] !== undefined) updates[k] = req.body[k];
        if (!Object.keys(updates).length) {
            return res.status(400).json({ error: 'No updatable fields supplied', allowed: ALLOWED });
        }
        if (updates.suggested_priority && !SUPPORT_PRIORITIES.includes(updates.suggested_priority)) {
            return res.status(400).json({ error: `suggested_priority must be one of: ${SUPPORT_PRIORITIES.join(', ')}` });
        }

        const fields = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
        await db.query(
            `UPDATE support_tickets SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [ticket.id, ...Object.values(updates)]
        );

        await AuditService.record(req, {
            action: AUDIT_ACTION.UPDATE,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: ticket.id,
            after_data: updates,
            reason: 'Updated by AI workflow',
        });

        res.json(present(await SupportTicket.getById(ticket.id)));
    } catch (err) {
        console.error('[integration] update failed:', err);
        res.status(500).json({ error: 'Failed to update ticket' });
    }
};

/**
 * POST /api/integration/v1/tickets/:ticket_key/cancel
 *
 * Cancels outright only while nobody has invested work. Past triage it becomes
 * a request a human confirms — a customer saying "never mind" must not erase
 * two days of a developer's time.
 */
exports.cancel = async (req, res) => {
    const client = await db.pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT * FROM support_tickets WHERE ticket_key = $1 AND deleted_at IS NULL',
            [req.params.ticket_key]
        );
        const ticket = rows[0];
        if (!ticket) { return res.status(404).json({ error: 'Ticket not found' }); }

        if (TERMINAL.includes(ticket.status)) {
            return res.status(409).json({ error: `Ticket is already ${ticket.status}` });
        }

        const reason = req.body?.reason || 'Cancelled by customer';
        await client.query('BEGIN');

        const direct = CANCELLABLE_DIRECTLY.includes(ticket.status);

        if (direct) {
            await client.query(
                `UPDATE support_tickets
                 SET status = 'CANCELLED', closed_at = CURRENT_TIMESTAMP,
                     cancellation_reason = $2, cancellation_requested_at = CURRENT_TIMESTAMP,
                     cancellation_requested_by = 'AI_WORKFLOW', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [ticket.id, reason]
            );
            await client.query(
                `INSERT INTO support_ticket_transitions (support_ticket_id, from_status, to_status, performed_by_user_id, reason)
                 VALUES ($1, $2, 'CANCELLED', NULL, $3)`,
                [ticket.id, ticket.status, reason]
            );
        } else {
            await client.query(
                `UPDATE support_tickets
                 SET cancellation_requested_at = CURRENT_TIMESTAMP, cancellation_reason = $2,
                     cancellation_requested_by = 'AI_WORKFLOW', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [ticket.id, reason]
            );
        }

        // Confirms back to the workflow what actually happened — it asked to
        // cancel, and needs to know whether that took effect or is pending a
        // human, so it can tell the customer the truth.
        await Webhook.enqueue({
            event: direct ? Webhook.EVENTS.CANCELLED : Webhook.EVENTS.CANCELLATION_REQUESTED,
            ticket: { ...ticket, status: direct ? 'CANCELLED' : ticket.status },
            extra: { reason, cancelled: direct },
        }, client);

        await client.query('COMMIT');

        await AuditService.record(req, {
            action: direct ? AUDIT_ACTION.STATUS_CHANGE : AUDIT_ACTION.UPDATE,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: ticket.id,
            before_data: { status: ticket.status },
            after_data: direct ? { status: 'CANCELLED' } : { cancellation_requested: true },
            reason,
        });

        const fresh = await SupportTicket.getById(ticket.id);
        res.json({
            ...present(fresh),
            cancelled: direct,
            message: direct
                ? 'Ticket cancelled.'
                : 'Work is already underway — cancellation requested and flagged for a human to confirm.',
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('[integration] cancel failed:', err);
        res.status(500).json({ error: 'Failed to cancel ticket' });
    } finally {
        client.release();
    }
};

/** GET /api/integration/v1/tickets/:ticket_key */
exports.get = async (req, res) => {
    try {
        const { rows } = await db.query(
            'SELECT id FROM support_tickets WHERE ticket_key = $1 AND deleted_at IS NULL',
            [req.params.ticket_key]
        );
        if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
        res.json(present(await SupportTicket.getById(rows[0].id)));
    } catch (err) {
        console.error('[integration] get failed:', err);
        res.status(500).json({ error: 'Failed to read ticket' });
    }
};

/** Results are always bounded — an unbounded scan is a denial of service. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/integration/v1/tickets
 *
 * Three jobs, one endpoint:
 *   ?since=<iso>          reconciliation — what changed while we were down
 *   ?search=&company_code= dedup — has this been reported already?
 *   ?status=&external_ref= plain lookup
 *
 * The `since` poll is the safety net behind the status webhook. Webhook
 * delivery is best-effort even with retries; this is how the workflow catches
 * up after an outage without anyone noticing a customer was never told.
 */
exports.list = async (req, res) => {
    try {
        const { since, search, company_code, status, external_ref } = req.query;

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1),
            MAX_LIMIT
        );

        const where = ['st.deleted_at IS NULL'];
        const values = [];
        let i = 1;

        if (since) {
            const d = new Date(since);
            if (Number.isNaN(d.getTime())) {
                return res.status(400).json({ error: 'since must be an ISO 8601 timestamp' });
            }
            // Inclusive: a caller polling from the last timestamp it saw must
            // not miss a row written in the same millisecond. It may see a
            // repeat instead, which is the safe direction — the contract is
            // at-least-once, same as the webhook.
            where.push(`st.updated_at >= $${i++}`);
            values.push(d.toISOString());
        }
        if (status) { where.push(`st.status = $${i++}`); values.push(status); }
        if (external_ref) { where.push(`st.external_ref = $${i++}`); values.push(external_ref); }
        if (company_code) {
            where.push(`co.account_code = $${i++}`);
            values.push(company_code);
        }
        if (search) {
            // Bounded ILIKE over title and description. Fine at this volume;
            // revisit with a tsvector index if support traffic ever grows.
            where.push(`(st.title ILIKE $${i} OR st.description ILIKE $${i})`);
            values.push(`%${String(search).slice(0, 100)}%`);
            i++;
        }

        values.push(limit);

        const { rows } = await db.query(
            `SELECT st.*,
                    COALESCE(p.name, sp.name) AS project_name,
                    COALESCE(stco.name, co.name, p.client_name) AS client_name
             FROM support_tickets st
             LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
             LEFT JOIN projects p ON p.id = COALESCE(st.project_id, sp.project_id)
             LEFT JOIN companies co ON co.id = COALESCE(st.company_id, p.company_id)
             LEFT JOIN companies stco ON stco.id = st.company_id
             WHERE ${where.join(' AND ')}
             ORDER BY st.updated_at ASC, st.id ASC
             LIMIT $${i}`,
            values
        );

        const tickets = rows.map(present);

        // Where to resume from. Ties on updated_at may repeat on the next poll;
        // the caller dedupes by ticket_key.
        const nextSince = rows.length ? rows[rows.length - 1].updated_at : since || null;

        res.json({
            count: tickets.length,
            limit,
            // Tells the caller there is more to fetch before it is caught up.
            has_more: rows.length === limit,
            next_since: nextSince,
            tickets,
        });
    } catch (err) {
        console.error('[integration] list failed:', err);
        res.status(500).json({ error: 'Failed to list tickets' });
    }
};

/**
 * POST /api/integration/v1/tickets/:ticket_key/notes
 * Always internal. Nothing from this API is customer-visible, because
 * CompanySys never talks to customers.
 */
exports.addNote = async (req, res) => {
    try {
        const content = req.body?.content;
        if (!content || !String(content).trim()) {
            return res.status(400).json({ error: 'content is required' });
        }

        const { rows } = await db.query(
            'SELECT id FROM support_tickets WHERE ticket_key = $1 AND deleted_at IS NULL',
            [req.params.ticket_key]
        );
        if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });

        const { rows: [note] } = await db.query(
            `INSERT INTO comments (support_ticket_id, user_id, content, is_internal)
             VALUES ($1, NULL, $2, TRUE) RETURNING id, created_at`,
            [rows[0].id, String(content).trim()]
        );

        res.status(201).json({ id: note.id, created_at: note.created_at, is_internal: true });
    } catch (err) {
        console.error('[integration] addNote failed:', err);
        res.status(500).json({ error: 'Failed to add note' });
    }
};
