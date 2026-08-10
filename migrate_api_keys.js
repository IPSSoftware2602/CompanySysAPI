/**
 * API keys for machine clients, and service-actor attribution in the audit log.
 *
 * The AI workflow is not a user: it has no password, no session, and must be
 * revocable independently of any person. Human auth stays on JWT; this is a
 * separate credential type with its own middleware.
 *
 * Keys are stored as a bcrypt hash. The plaintext is shown exactly once, at
 * creation, and is not recoverable — the same rule as a user password, for the
 * same reason. `key_prefix` is stored in clear so a key can be identified in
 * logs and revoked without anyone holding the secret.
 *
 * Additive and idempotent.
 *
 *   node migrate_api_keys.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1. Creating api_keys...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name         VARCHAR(100) NOT NULL,
                -- Identifies the key without revealing it. Indexed, because
                -- every authenticated request looks a key up by this.
                key_prefix   VARCHAR(24) NOT NULL UNIQUE,
                key_hash     VARCHAR(255) NOT NULL,
                scopes       TEXT[] NOT NULL DEFAULT '{}',
                last_used_at TIMESTAMP WITH TIME ZONE,
                revoked_at   TIMESTAMP WITH TIME ZONE,
                created_by   UUID REFERENCES users(id),
                created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_api_keys_prefix_active
                ON api_keys (key_prefix) WHERE revoked_at IS NULL;
        `);

        console.log('2. Adding service-actor columns to audit_logs...');
        // audit_logs.user_id is already nullable (the SLA cron writes NULL).
        // actor_type makes "no user" explicit rather than ambiguous: a NULL
        // user_id previously could mean either a system job or a bug.
        await client.query(`
            ALTER TABLE audit_logs
            ADD COLUMN IF NOT EXISTS actor_type VARCHAR(20) NOT NULL DEFAULT 'USER',
            ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id);
        `);

        console.log('3. Labelling existing system-written audit rows...');
        // Rows the SLA cron wrote have no user. Retro-label them SYSTEM so the
        // new column is honest about history rather than claiming they were
        // user actions.
        const relabelled = await client.query(`
            UPDATE audit_logs SET actor_type = 'SYSTEM'
            WHERE user_id IS NULL AND actor_type = 'USER'
        `);
        console.log(`   ${relabelled.rowCount} row(s) relabelled SYSTEM`);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed, rolled back:', err.message);
        throw err;
    } finally {
        client.release();
    }

    try {
        const { rows: [k] } = await db.query('SELECT count(*)::int n FROM api_keys WHERE revoked_at IS NULL');
        console.log('\n✅ API key migration complete.');
        console.log(`   ${k.n} active key(s).`);
        if (k.n === 0) {
            console.log('\n   Mint one with:  npm run apikey:create -- "AI Workflow"');
            console.log('   The plaintext is shown once and cannot be recovered.');
        }
    } catch (err) {
        console.warn('\n⚠️  Migration succeeded, but the summary failed:', err.message);
    }
}

migrate()
    .then(() => db.pool.end())
    .catch(async () => { try { await db.pool.end(); } catch { /* closing */ } process.exit(1); });
