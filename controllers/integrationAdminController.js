const db = require('../db');
const Webhook = require('../services/webhookService');
const AuditService = require('../services/auditService');
const { MANAGER_ROLES, AUDIT_ACTION, AUDIT_ENTITY } = require('../constants');

/**
 * Human-facing views onto the integration.
 *
 * These exist because two of its failure modes are silent by nature:
 *
 *   - a dead webhook letter means a customer is waiting on news that will never
 *     arrive unless somebody intervenes
 *   - a cancellation request on work already underway sits there until a human
 *     decides
 *
 * The backend records both faithfully. Without a screen, nobody finds out.
 */

const isManager = (user) => MANAGER_ROLES.includes(user?.role);

/** GET /api/integration-admin/dead-letters */
exports.deadLetters = async (req, res) => {
    try {
        if (!isManager(req.user)) return res.status(403).json({ error: 'Managers only' });

        const { rows } = await db.query(
            `SELECT wd.id, wd.event, wd.attempts, wd.last_error, wd.last_status_code,
                    wd.created_at, wd.payload->>'ticket_key' AS ticket_key,
                    st.title, st.status AS ticket_status
             FROM webhook_deliveries wd
             LEFT JOIN support_tickets st ON st.id = wd.ticket_id
             WHERE wd.status = 'DEAD'
             ORDER BY wd.created_at DESC
             LIMIT 100`
        );

        // Waiting = queued but not yet delivered. Healthy in small numbers;
        // a growing figure means the receiver is down.
        const { rows: [counts] } = await db.query(
            `SELECT count(*) FILTER (WHERE status IN ('PENDING','FAILED'))::int waiting,
                    count(*) FILTER (WHERE status = 'DEAD')::int dead,
                    count(*) FILTER (WHERE status = 'SENT')::int sent
             FROM webhook_deliveries`
        );

        res.json({ ...counts, dead_letters: rows });
    } catch (err) {
        console.error('[integration-admin] dead letters failed:', err);
        res.status(500).json({ error: 'Failed to load dead letters' });
    }
};

/** POST /api/integration-admin/dead-letters/:id/retry */
exports.retryDeadLetter = async (req, res) => {
    try {
        if (!isManager(req.user)) return res.status(403).json({ error: 'Managers only' });

        const revived = await Webhook.revive(req.params.id);
        if (!revived) return res.status(404).json({ error: 'No dead delivery with that id' });

        await AuditService.record(req, {
            action: AUDIT_ACTION.UPDATE,
            entity_type: 'WEBHOOK_DELIVERY',
            entity_id: revived.id,
            after_data: { status: 'PENDING' },
            reason: 'Dead letter requeued from the dashboard',
        });

        res.json({ id: revived.id, status: 'PENDING', message: 'Requeued — the sender will retry on its next run.' });
    } catch (err) {
        console.error('[integration-admin] retry failed:', err);
        res.status(500).json({ error: 'Failed to requeue delivery' });
    }
};

/**
 * GET /api/integration-admin/cancellation-requests
 *
 * Tickets the workflow asked to cancel after work had already started. These
 * are decisions waiting on a human, not notifications.
 */
exports.cancellationRequests = async (req, res) => {
    try {
        if (!isManager(req.user)) return res.status(403).json({ error: 'Managers only' });

        const { rows } = await db.query(
            `SELECT st.id, st.ticket_key, st.title, st.status, st.priority,
                    st.cancellation_requested_at, st.cancellation_reason,
                    st.cancellation_requested_by,
                    COALESCE(co.name, p.client_name) AS client_name,
                    dev.full_name AS assigned_dev_name
             FROM support_tickets st
             LEFT JOIN projects p ON p.id = st.project_id
             LEFT JOIN companies co ON co.id = COALESCE(st.company_id, p.company_id)
             LEFT JOIN users dev ON dev.id = st.assigned_dev_id
             WHERE st.deleted_at IS NULL
               AND st.cancellation_requested_at IS NOT NULL
               AND st.status NOT IN ('CANCELLED', 'CLOSED', 'COMPLETED')
             ORDER BY st.cancellation_requested_at`
        );

        res.json({ count: rows.length, requests: rows });
    } catch (err) {
        console.error('[integration-admin] cancellation requests failed:', err);
        res.status(500).json({ error: 'Failed to load cancellation requests' });
    }
};

/**
 * POST /api/integration-admin/cancellation-requests/:id/resolve  { approve }
 *
 * approve=true  -> the ticket is cancelled
 * approve=false -> the request is dismissed and work continues
 */
exports.resolveCancellation = async (req, res) => {
    const client = await db.pool.connect();
    try {
        if (!isManager(req.user)) return res.status(403).json({ error: 'Managers only' });

        const { rows } = await client.query(
            'SELECT * FROM support_tickets WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
        );
        const ticket = rows[0];
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        if (!ticket.cancellation_requested_at) {
            return res.status(409).json({ error: 'No cancellation was requested for this ticket' });
        }

        const approve = req.body?.approve === true;
        await client.query('BEGIN');

        if (approve) {
            await client.query(
                `UPDATE support_tickets
                 SET status='CANCELLED', closed_at=now(), updated_at=now() WHERE id=$1`,
                [ticket.id]
            );
            await client.query(
                `INSERT INTO support_ticket_transitions (support_ticket_id, from_status, to_status, performed_by_user_id, reason)
                 VALUES ($1,$2,'CANCELLED',$3,$4)`,
                [ticket.id, ticket.status, req.user.id, ticket.cancellation_reason || 'Cancellation approved']
            );
            await Webhook.enqueue({
                event: Webhook.EVENTS.CANCELLED,
                ticket: { ...ticket, status: 'CANCELLED' },
                extra: { cancelled: true, approved_by: req.user.full_name || req.user.id },
            }, client);
        } else {
            // Clear the flag so it leaves the queue; work carries on.
            await client.query(
                `UPDATE support_tickets
                 SET cancellation_requested_at=NULL, cancellation_requested_by=NULL,
                     cancellation_reason=NULL, updated_at=now()
                 WHERE id=$1`,
                [ticket.id]
            );
            await Webhook.enqueue({
                event: Webhook.EVENTS.STATUS_CHANGED,
                ticket,
                extra: { cancellation_declined: true, from: ticket.status, to: ticket.status },
            }, client);
        }

        await client.query('COMMIT');

        await AuditService.record(req, {
            action: AUDIT_ACTION.STATUS_CHANGE,
            entity_type: AUDIT_ENTITY.SUPPORT_TICKET,
            entity_id: ticket.id,
            before_data: { status: ticket.status, cancellation_requested: true },
            after_data: { status: approve ? 'CANCELLED' : ticket.status, cancellation_approved: approve },
            reason: req.body?.reason || null,
        });

        res.json({
            ticket_key: ticket.ticket_key,
            approved: approve,
            status: approve ? 'CANCELLED' : ticket.status,
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('[integration-admin] resolve cancellation failed:', err);
        res.status(500).json({ error: 'Failed to resolve cancellation request' });
    } finally {
        client.release();
    }
};
