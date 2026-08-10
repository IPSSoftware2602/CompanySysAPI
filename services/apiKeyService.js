const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

/**
 * API keys for machine clients.
 *
 * Format:  csk_<prefix>_<secret>
 *          csk_a1b2c3d4_9f8e...   (8 hex prefix, 48 hex secret)
 *
 * The prefix is stored in clear and indexed, so a request is one indexed lookup
 * rather than a bcrypt comparison against every key in the table. The secret is
 * bcrypt-hashed and never recoverable — a leaked database does not yield
 * working credentials.
 */

const KEY_PREFIX = 'csk';           // CompanySys Key
const PREFIX_BYTES = 4;             // 8 hex chars
const SECRET_BYTES = 24;            // 48 hex chars
const BCRYPT_ROUNDS = 10;

/** Splits a presented key into its lookup prefix and secret. */
function parseKey(presented) {
    if (typeof presented !== 'string') return null;
    const parts = presented.trim().split('_');
    if (parts.length !== 3) return null;
    const [scheme, prefix, secret] = parts;
    if (scheme !== KEY_PREFIX) return null;
    if (!/^[a-f0-9]{8}$/.test(prefix)) return null;
    if (!/^[a-f0-9]{48}$/.test(secret)) return null;
    return { prefix: `${KEY_PREFIX}_${prefix}`, secret };
}

/**
 * Mints a key. Returns the plaintext ONCE — it is not stored and cannot be
 * recovered afterwards.
 *
 * @returns {Promise<{id, name, key_prefix, plaintext}>}
 */
async function create({ name, scopes = [], createdBy = null }, client = db) {
    if (!name || !String(name).trim()) throw new Error('name is required');

    const prefix = `${KEY_PREFIX}_${crypto.randomBytes(PREFIX_BYTES).toString('hex')}`;
    const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    const plaintext = `${prefix}_${secret}`;
    const hash = await bcrypt.hash(secret, BCRYPT_ROUNDS);

    const { rows } = await client.query(
        `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, key_prefix, scopes, created_at`,
        [String(name).trim(), prefix, hash, scopes, createdBy]
    );

    return { ...rows[0], plaintext };
}

/**
 * Verifies a presented key.
 *
 * Returns null for every failure mode — malformed, unknown, revoked, wrong
 * secret — so a caller cannot distinguish "no such key" from "wrong secret"
 * and use the API as an oracle.
 *
 * @returns {Promise<object|null>} the api_key row, without the hash
 */
async function verify(presented, client = db) {
    const parsed = parseKey(presented);
    if (!parsed) return null;

    const { rows } = await client.query(
        `SELECT id, name, key_prefix, key_hash, scopes, revoked_at
         FROM api_keys WHERE key_prefix = $1`,
        [parsed.prefix]
    );
    if (!rows.length) return null;

    const key = rows[0];
    if (key.revoked_at) return null;

    const ok = await bcrypt.compare(parsed.secret, key.key_hash);
    if (!ok) return null;

    // Fire-and-forget: a failed usage stamp must not fail the request.
    client.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [key.id])
        .catch((err) => console.warn('[apikey] could not stamp last_used_at:', err.message));

    delete key.key_hash;
    return key;
}

async function revoke(id, client = db) {
    const { rows } = await client.query(
        `UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND revoked_at IS NULL RETURNING id, name, key_prefix`,
        [id]
    );
    return rows[0] || null;
}

async function list(client = db) {
    const { rows } = await client.query(
        `SELECT id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
         FROM api_keys ORDER BY created_at DESC`
    );
    return rows;
}

module.exports = { create, verify, revoke, list, parseKey, KEY_PREFIX };
