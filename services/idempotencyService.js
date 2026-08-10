const db = require('../db');

/**
 * Idempotency for the integration API.
 *
 * The AI workflow will time out and retry. Without this, one customer complaint
 * becomes three tickets — and nobody notices until a developer is assigned the
 * same bug twice.
 *
 * The flow is claim-then-complete rather than check-then-act:
 *
 *   claim()      INSERT ... ON CONFLICT DO NOTHING
 *                won  -> this request is the original, do the work
 *                lost -> someone else has this key
 *                          completed -> replay their stored response
 *                          in flight -> 409, do NOT run the work again
 *
 * Checking for the key first and inserting after would leave a window where two
 * concurrent retries both see "not found" and both create a ticket, which is
 * the exact failure this exists to prevent.
 */

/** Anything past this is a new request, not a retry. */
const RETENTION_HOURS = 24;

/**
 * @returns {Promise<{outcome: 'CLAIMED'|'REPLAY'|'IN_FLIGHT', stored?: object}>}
 */
async function claim({ key, endpoint, apiKeyId }, client = db) {
    const insert = await client.query(
        `INSERT INTO idempotency_keys (key, endpoint, api_key_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, endpoint, apiKeyId || null]
    );

    if (insert.rows.length) return { outcome: 'CLAIMED' };

    const { rows } = await client.query(
        `SELECT endpoint, response_body, status_code, ticket_id, completed_at
         FROM idempotency_keys WHERE key = $1`,
        [key]
    );
    const existing = rows[0];

    // Same key against a different endpoint is a client bug, not a retry.
    // Treating it as a replay would return an unrelated response.
    if (existing && existing.endpoint !== endpoint) {
        return { outcome: 'CONFLICT_ENDPOINT', stored: existing };
    }

    if (existing && existing.completed_at) {
        return { outcome: 'REPLAY', stored: existing };
    }

    return { outcome: 'IN_FLIGHT' };
}

/** Records the response so a later retry replays it verbatim. */
async function complete({ key, statusCode, body, ticketId }, client = db) {
    await client.query(
        `UPDATE idempotency_keys
         SET response_body = $2, status_code = $3, ticket_id = $4,
             completed_at = CURRENT_TIMESTAMP
         WHERE key = $1`,
        [key, JSON.stringify(body), statusCode, ticketId || null]
    );
}

/**
 * Releases a claim whose work failed, so the client can genuinely retry.
 *
 * Without this a transient database error would poison the key: every retry
 * would see an in-flight claim that never completes, and the ticket could never
 * be filed under that key.
 */
async function release(key, client = db) {
    await client.query('DELETE FROM idempotency_keys WHERE key = $1 AND completed_at IS NULL', [key]);
}

/** Housekeeping for the breach-check cron to call. */
async function purgeExpired(client = db) {
    const { rowCount } = await client.query(
        `DELETE FROM idempotency_keys
         WHERE created_at < now() - ($1 || ' hours')::interval`,
        [RETENTION_HOURS]
    );
    return rowCount;
}

module.exports = { claim, complete, release, purgeExpired, RETENTION_HOURS };
