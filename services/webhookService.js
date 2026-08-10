const crypto = require('crypto');
const db = require('../db');

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
    STATUS_CHANGED: 'ticket.status_changed',
    ASSIGNED: 'ticket.assigned',
    CANCELLED: 'ticket.cancelled',
    CANCELLATION_REQUESTED: 'ticket.cancellation_requested',
};

/**
 * Queues an event. MUST be called with the caller's transaction client — that
 * is the whole point of the outbox.
 *
 * Only tickets the workflow filed generate events. A ticket a PM typed in has
 * no customer waiting on WhatsApp, so notifying about it would be noise.
 */
async function enqueue({ event, ticket, extra = {} }, client) {
    if (!client) throw new Error('enqueue requires the caller transaction client');
    if (ticket.source !== 'AI_WORKFLOW') return null;

    const payload = {
        event,
        ticket_key: ticket.ticket_key,
        external_ref: ticket.external_ref || null,
        status: ticket.status,
        priority: ticket.priority,
        occurred_at: new Date().toISOString(),
        ...extra,
    };

    const { rows } = await client.query(
        `INSERT INTO webhook_deliveries (event, ticket_id, payload)
         VALUES ($1, $2, $3) RETURNING id`,
        [event, ticket.id, JSON.stringify(payload)]
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
    if (!url) return { skipped: true, reason: 'WEBHOOK_URL not set' };

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

    for (const row of due) {
        results.attempted++;
        const rawBody = JSON.stringify(row.payload);
        const headers = {
            'Content-Type': 'application/json',
            'X-CompanySys-Event': row.event,
            'X-CompanySys-Delivery': row.id,
        };
        if (secret) headers['X-CompanySys-Signature'] = `sha256=${sign(rawBody, secret)}`;

        try {
            const res = await fetchImpl(url, { method: 'POST', headers, body: rawBody });
            if (res.ok) {
                await markSent(row.id, res.status);
                results.sent++;
                results.details.push({ id: row.id, event: row.event, ticket: row.payload.ticket_key, status: 'SENT' });
            } else {
                const outcome = await markFailed(row.id, row.attempts, `HTTP ${res.status}`, res.status);
                results[outcome === 'DEAD' ? 'dead' : 'failed']++;
                results.details.push({ id: row.id, event: row.event, ticket: row.payload.ticket_key, status: outcome, error: `HTTP ${res.status}` });
            }
        } catch (err) {
            const outcome = await markFailed(row.id, row.attempts, err.message, null);
            results[outcome === 'DEAD' ? 'dead' : 'failed']++;
            results.details.push({ id: row.id, event: row.event, ticket: row.payload.ticket_key, status: outcome, error: err.message });
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

module.exports = { enqueue, sign, deliverDue, revive, EVENTS, MAX_ATTEMPTS, BACKOFF_MINUTES };
