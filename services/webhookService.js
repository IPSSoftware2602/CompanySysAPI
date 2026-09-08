const crypto = require('crypto');
const db = require('../db');
const GroupNotify = require('./groupNotifyService');

/**
 * Outbound webhook delivery to the AI workflow.
 *
 * Two halves, deliberately separated:
 *
 *   enqueue()  runs INSIDE the caller's transaction. The event and the status
 *              change it describes commit together or not at all.
 *   deliver()  runs from a cron job, draining the outbox with retries.
 *
 * Posting inline at the moment of the change would tie a customer being told
 * to the workflow being up at that instant, and the failure would be silent.
 */

/** Retry schedule in minutes. Six attempts spanning ~2 hours. */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

const EVENTS = {
    CREATED: 'ticket.created',
    STATUS_CHANGED: 'ticket.status_changed',
    ASSIGNED: 'ticket.assigned',
    CANCELLED: 'ticket.cancelled',
    CANCELLATION_REQUESTED: 'ticket.cancellation_requested',
};

/**
 * Where a queued row is going.
 *
 *   WEBHOOK   the AI workflow, HMAC-signed. Only for tickets it filed — a
 *             ticket a PM typed in has no customer waiting on WhatsApp.
 *   WHATSAPP  our own internal group, via XTECH. Fires for EVERY ticket: the
 *             group wants to know a ticket exists regardless of who filed it.
 */
const CHANNELS = { WEBHOOK: 'WEBHOOK', WHATSAPP: 'WHATSAPP' };

/**
 * Queues an event. MUST be called with the caller's transaction client — that
 * is the whole point of the outbox.
 *
 * The source gate applies to the WEBHOOK channel only; see CHANNELS.
 */
async function enqueue({ event, ticket, extra = {}, channel = CHANNELS.WEBHOOK }, client) {
    if (!client) throw new Error('enqueue requires the caller transaction client');
    if (channel === CHANNELS.WEBHOOK && ticket.source !== 'AI_WORKFLOW') return null;

    const payload = {
        event,
        ticket_key: ticket.ticket_key,
        external_ref: ticket.external_ref || null,
        status: ticket.status,
        priority: ticket.priority,
        source: ticket.source || 'INTERNAL',
        occurred_at: new Date().toISOString(),
        ...extra,
    };

    // One row PER RECIPIENT on the WhatsApp channel, not one row sent to many.
    // A single row retried after a partial failure would re-deliver to everyone
    // who already got it; separate rows retry only what actually failed.
    if (channel === CHANNELS.WHATSAPP) {
        const cfg = await GroupNotify.config();
        const recipients = GroupNotify.normaliseRecipients(cfg.groupId);

        // Nobody configured yet: queue one unaddressed row, which resolves its
        // recipient at send time. Configure XTECH tomorrow and today's
        // announcements still go out.
        const targets = recipients.length ? recipients : [null];

        const ids = [];
        for (const to of targets) {
            const { rows } = await client.query(
                `INSERT INTO webhook_deliveries (event, ticket_id, payload, channel)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [event, ticket.id, JSON.stringify({ ...payload, to }), channel]
            );
            ids.push(rows[0].id);
        }
        return ids.length === 1 ? ids[0] : ids;
    }

    const { rows } = await client.query(
        `INSERT INTO webhook_deliveries (event, ticket_id, payload, channel)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [event, ticket.id, JSON.stringify(payload), channel]
    );
    return rows[0].id;
}

/**
 * HMAC-SHA256 over the exact bytes sent. The receiver must verify against the
 * raw body, not a re-serialised object — key order would differ and the
 * signature would never match.
 */
function sign(rawBody, secret) {
    return crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Claims due rows, skipping any another sender already holds. */
async function claimDue(limit, client) {
    const { rows } = await client.query(
        `SELECT * FROM webhook_deliveries
         WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit]
    );
    return rows;
}

async function markSent(id, statusCode, client = db) {
    await client.query(
        `UPDATE webhook_deliveries
         SET status='SENT', delivered_at=now(), attempts=attempts+1, last_status_code=$2, last_error=NULL
         WHERE id=$1`,
        [id, statusCode]
    );
}

async function markFailed(id, attempts, error, statusCode, client = db) {
    const nextAttempt = attempts + 1;

    if (nextAttempt >= MAX_ATTEMPTS) {
        // Out of retries. DEAD is a visible state, not a silent drop: something
        // a customer is waiting on has not been delivered and a human has to
        // decide what to do.
        await client.query(
            `UPDATE webhook_deliveries
             SET status='DEAD', attempts=$2, last_error=$3, last_status_code=$4, next_attempt_at=NULL
             WHERE id=$1`,
            [id, nextAttempt, error, statusCode]
        );
        return 'DEAD';
    }

    const delay = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
    await client.query(
        `UPDATE webhook_deliveries
         SET status='FAILED', attempts=$2, last_error=$3, last_status_code=$4,
             next_attempt_at = now() + ($5 || ' minutes')::interval
         WHERE id=$1`,
        [id, nextAttempt, error, statusCode, delay]
    );
    return 'FAILED';
}

/**
 * Drains due deliveries. Returns a summary for the job to log.
 *
 * Each delivery is claimed and updated in its own transaction so one poisoned
 * row cannot block the rest.
 */
async function deliverDue({ url, secret, limit = 25, fetchImpl = fetch } = {}) {
    // No WEBHOOK_URL used to abort the whole drain. It must not any more: the
    // WhatsApp channel is configured separately, and a system that only wants
    // group notifications should still get them.
    const groupCfg = await GroupNotify.config();
    if (!url && !groupCfg.url) {
        return { skipped: true, reason: 'neither WEBHOOK_URL nor XTECH_API_URL is set' };
    }

    const client = await db.pool.connect();
    let due;
    try {
        await client.query('BEGIN');
        due = await claimDue(limit, client);
        await client.query('COMMIT');
    } finally {
        client.release();
    }

    const results = { attempted: 0, sent: 0, failed: 0, dead: 0, details: [] };

    // A developer's database holds the same live XTECH credentials and the same
    // real group id as production, and flushSoon() drains the outbox in-process
    // the moment a ticket is created — so creating a test ticket on a laptop
    // sends a real message to the team's WhatsApp group. It has happened twice.
    // Opt-in rather than opt-out on purpose: defaulting to "block unless
    // NODE_ENV=production" would silently mute production on any box that does
    // not set NODE_ENV. Set WHATSAPP_DRY_RUN=1 in a development .env.
    const dryRun = process.env.WHATSAPP_DRY_RUN === '1';

    for (const row of due) {
        const isGroup = row.channel === CHANNELS.WHATSAPP;

        // Left queued, not failed: the same treatment as an unconfigured
        // channel, so nothing is lost and no retries are burned.
        if (isGroup && dryRun) {
            console.warn(`[webhook] WHATSAPP_DRY_RUN — not sending "${row.payload?.title || row.event}" to ${row.payload?.to}`);
            results.skipped = (results.skipped || 0) + 1;
            continue;
        }

        // A row whose channel has no configuration is left queued rather than
        // burned through its retries: configure XTECH tomorrow and today's
        // announcements still go out.
        if (isGroup ? !groupCfg.url : !url) {
            results.skipped = (results.skipped || 0) + 1;
            continue;
        }

        results.attempted++;

        try {
            let res;
            if (isGroup) {
                const sent = await GroupNotify.send({
                    message: GroupNotify.composeMessage(row.payload, groupCfg.template),
                    // Addressed when it was queued; falls back to the current
                    // setting for rows queued before XTECH was configured.
                    group_id: row.payload.to || GroupNotify.normaliseRecipients(groupCfg.groupId)[0],
                }, { fetchImpl, settings: groupCfg });
                res = { ok: sent.ok, status: sent.status || 0, error: sent.reason || sent.body };
            } else {
                const rawBody = JSON.stringify(row.payload);
                const headers = {
                    'Content-Type': 'application/json',
                    'X-CompanySys-Event': row.event,
                    'X-CompanySys-Delivery': row.id,
                };
                if (secret) headers['X-CompanySys-Signature'] = `sha256=${sign(rawBody, secret)}`;
                const http = await fetchImpl(url, { method: 'POST', headers, body: rawBody });
                res = { ok: http.ok, status: http.status };
            }

            if (res.ok) {
                await markSent(row.id, res.status);
                results.sent++;
                results.details.push({ id: row.id, channel: row.channel, event: row.event, ticket: row.payload.ticket_key, status: 'SENT' });
            } else {
                const error = res.error || `HTTP ${res.status}`;
                const outcome = await markFailed(row.id, row.attempts, error, res.status || null);
                results[outcome === 'DEAD' ? 'dead' : 'failed']++;
                results.details.push({ id: row.id, channel: row.channel, event: row.event, ticket: row.payload.ticket_key, status: outcome, error });
            }
        } catch (err) {
            const outcome = await markFailed(row.id, row.attempts, err.message, null);
            results[outcome === 'DEAD' ? 'dead' : 'failed']++;
            results.details.push({ id: row.id, channel: row.channel, event: row.event, ticket: row.payload.ticket_key, status: outcome, error: err.message });
        }
    }

    return results;
}

/** Puts a dead delivery back in the queue — for the dashboard's retry button. */
async function revive(id, client = db) {
    const { rows } = await client.query(
        `UPDATE webhook_deliveries
         SET status='PENDING', attempts=0, next_attempt_at=now(), last_error=NULL
         WHERE id=$1 AND status='DEAD' RETURNING id`,
        [id]
    );
    return rows[0] || null;
}

/**
 * Nudges the outbox after something is queued.
 *
 * Without this, a ticket's announcement sits PENDING until the cron runs, and
 * on a machine with no cron it never sends at all — which looks exactly like a
 * broken feature. Deliberately NOT awaited by the caller: a slow or dead XTECH
 * must not delay the reply to whoever just filed the ticket.
 *
 * The cron remains the safety net. This only tries once; a failure leaves the
 * row PENDING with its retry schedule intact.
 */
let flushing = false;
function flushSoon() {
    if (flushing) return;           // one drain at a time; a burst of tickets
    flushing = true;                // does not start a burst of drains
    setImmediate(async () => {
        try {
            await deliverDue({
                url: process.env.WEBHOOK_URL || null,
                secret: process.env.WEBHOOK_SECRET || null,
            });
        } catch (err) {
            // The row stays queued and the cron will retry it.
            console.warn('[webhook] immediate flush failed:', err.message);
        } finally {
            flushing = false;
        }
    });
}

module.exports = {
    flushSoon, enqueue, sign, deliverDue, revive, EVENTS, CHANNELS, MAX_ATTEMPTS, BACKOFF_MINUTES };
