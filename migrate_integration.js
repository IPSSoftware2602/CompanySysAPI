/**
 * Integration API: idempotency and the columns an externally-filed ticket needs.
 *
 * CANCELLED is added to support_ticket_status. It is not the same as CLOSED: a
 * cancelled ticket is work that never happened, and counting it as resolved
 * would flatter every delivery metric that reads terminal statuses.
 *
 * Additive and idempotent.
 *
 *   node migrate_integration.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const db = require('./db');

async function migrate() {
    // ALTER TYPE ... ADD VALUE must not share a transaction with statements that
    // use the new value, so the enum change is made first, on its own.
    console.log('1. Adding CANCELLED to support_ticket_status...');
    await db.query(`ALTER TYPE support_ticket_status ADD VALUE IF NOT EXISTS 'CANCELLED';`);

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('2. Adding integration columns to support_tickets...');
        await client.query(`
            ALTER TABLE support_tickets
                -- The workflow's own id, so it can correlate without storing ours.
                ADD COLUMN IF NOT EXISTS external_ref VARCHAR(128),
                -- INTERNAL | AI_WORKFLOW. Lets the UI show provenance and lets
                -- reporting separate human-filed from machine-filed volume.
                ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'INTERNAL',
                ADD COLUMN IF NOT EXISTS reported_by_name VARCHAR(255),
                ADD COLUMN IF NOT EXISTS reported_by_contact VARCHAR(100),
                -- What the AI proposed. priority stays the authoritative value a
                -- PM sets; keeping both is what makes the AI's triage
                -- measurable later.
                ADD COLUMN IF NOT EXISTS suggested_priority support_priority,
                ADD COLUMN IF NOT EXISTS ai_summary TEXT,
                ADD COLUMN IF NOT EXISTS ai_preliminary_diagnosis TEXT,
                ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMP WITH TIME ZONE,
                ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
                ADD COLUMN IF NOT EXISTS cancellation_requested_by VARCHAR(20);
        `);

        // Correlation lookups from the workflow, and the "since" poll.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_support_tickets_external_ref
                ON support_tickets (external_ref) WHERE external_ref IS NOT NULL;
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_support_tickets_updated
                ON support_tickets (updated_at) WHERE deleted_at IS NULL;
        `);

        console.log('3. Creating idempotency_keys...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS idempotency_keys (
                key           VARCHAR(128) PRIMARY KEY,
                api_key_id    UUID REFERENCES api_keys(id),
                endpoint      VARCHAR(100) NOT NULL,
                -- NULL while the original request is still running. A replay
                -- arriving in that window gets 409 rather than a second ticket.
                response_body JSONB,
                status_code   INTEGER,
                ticket_id     UUID REFERENCES support_tickets(id),
                created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                completed_at  TIMESTAMP WITH TIME ZONE
            );
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_idempotency_created
                ON idempotency_keys (created_at);
        `);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed, rolled back:', err.message);
        throw err;
    } finally {
        client.release();
    }

    try {
        const { rows: st } = await db.query(
            `SELECT unnest(enum_range(NULL::support_ticket_status))::text s`
        );
        console.log('\n✅ Integration migration complete.');
        console.log('   support_ticket_status:', st.map((r) => r.s).join(', '));
    } catch (err) {
        console.warn('\n⚠️  Migration succeeded, but the summary failed:', err.message);
    }
}

migrate()
    .then(() => db.pool.end())
    .catch(async () => { try { await db.pool.end(); } catch { /* closing */ } process.exit(1); });
