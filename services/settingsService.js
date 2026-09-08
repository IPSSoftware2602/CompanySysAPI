const db = require('../db');

/**
 * Settings a person edits in the app.
 *
 * Values are cached for a short window because the outbox drain reads them on
 * every pass, and they change perhaps twice a year. Any write clears the cache,
 * so a change made in the UI takes effect on the next send rather than up to a
 * minute later.
 */

const SECRET_KEYS = new Set(['xtech_api_token', 'iris_webhook_secret']);
const CACHE_TTL_MS = 30 * 1000;

let cache = { at: 0, values: null };

/** Drop the cache. Called after every write. */
function invalidate() {
    cache = { at: 0, values: null };
}

/** Every setting, as a plain object. Values are raw — do not send to a client. */
async function all(client = db) {
    if (cache.values && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;

    const { rows } = await client.query('SELECT key, value FROM app_settings');
    const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cache = { at: Date.now(), values };
    return values;
}

async function get(key, fallback = null) {
    const values = await all();
    return values[key] ?? fallback;
}

/**
 * Writes a batch. A value of null or '' deletes the row, which is how a
 * setting is cleared — an empty string sitting in the table would read as
 * "configured with nothing".
 */
async function setMany(entries, { userId = null } = {}, client = db) {
    for (const [key, raw] of Object.entries(entries)) {
        const value = raw === null || raw === undefined || String(raw).trim() === ''
            ? null
            : String(raw).trim();

        if (value === null) {
            await client.query('DELETE FROM app_settings WHERE key = $1', [key]);
            continue;
        }

        await client.query(
            `INSERT INTO app_settings (key, value, is_secret, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE
                 SET value = EXCLUDED.value,
                     updated_by = EXCLUDED.updated_by,
                     updated_at = CURRENT_TIMESTAMP`,
            [key, value, SECRET_KEYS.has(key), userId]
        );
    }
    invalidate();
}

/**
 * Shows enough of a secret to recognise it, never enough to use it.
 *
 * The alternative — returning the real token so the field can be pre-filled —
 * means every manager loading the settings page pulls a live credential into a
 * browser. Not worth the convenience of an editable text box.
 */
function maskSecret(value) {
    if (!value) return null;
    const tail = value.slice(-4);
    return `${'•'.repeat(Math.min(12, Math.max(4, value.length - 4)))}${tail}`;
}

/** The client-safe view: secrets become a "set / not set" plus a hint. */
async function forClient(client = db) {
    const { rows } = await client.query(
        `SELECT s.key, s.value, s.is_secret, s.updated_at, u.full_name AS updated_by_name
         FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by`
    );

    const out = {};
    for (const r of rows) {
        out[r.key] = {
            configured: Boolean(r.value),
            value: r.is_secret ? null : r.value,
            hint: r.is_secret ? maskSecret(r.value) : null,
            is_secret: r.is_secret,
            updated_at: r.updated_at,
            updated_by_name: r.updated_by_name,
        };
    }
    return out;
}

module.exports = { all, get, setMany, forClient, invalidate, maskSecret, SECRET_KEYS };
