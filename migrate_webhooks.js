/**
 * Outbound webhook delivery, as a transactional outbox.
 *
 * When a ticket resolves, the AI workflow has to find out so it can tell the
 * customer. Posting inline at the moment of the status change would mean a
 * customer is never told whenever the workflow happens to be down — a business
 * failure with no error anyone sees.
 *
 * So the event is INSERTed in the same transaction as the status change: if the
 * status commits, the event is queued; if it rolls back, so does the event.
 * There is no window where one exists without the other. A separate sender
 * drains the table with retries, and anything that exhausts them lands in DEAD
 * where a human can see it.
 *
 * Additive and idempotent.
 *
 *   node migrate_webhooks.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1. Creating webhook_deliveries...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS webhook_deliveries (
                id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                event           VARCHAR(50) NOT NULL,
                ticket_id       UUID REFERENCES support_tickets(id) ON DELETE CASCADE,
                payload         JSONB NOT NULL,

                -- PENDING -> SENT | FAILED -> DEAD
                -- FAILED is retryable; DEAD has exhausted its attempts and
                -- needs a human.
                status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                attempts        INTEGER NOT NULL DEFAULT 0,
                last_error      TEXT,
                last_status_code INTEGER,
                next_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

                created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                delivered_at    TIMESTAMP WITH TIME ZONE
            );
        `);

        // The sender's claim query: due, not yet terminal, oldest first.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_webhook_due
                ON webhook_deliveries (next_attempt_at)
                WHERE status IN ('PENDING', 'FAILED');
        `);
        // The dead-letter panel.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_webhook_dead
                ON webhook_deliveries (created_at) WHERE status = 'DEAD';
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
        const { rows: [c] } = await db.query(
            `SELECT count(*) FILTER (WHERE status='PENDING')::int pending,
                    count(*) FILTER (WHERE status='DEAD')::int dead,
                    count(*)::int total
             FROM webhook_deliveries`
        );
        console.log('\n✅ Webhook outbox migration complete.');
        console.log(`   ${c.total} delivery row(s): ${c.pending} pending, ${c.dead} dead.`);
        if (!process.env.WEBHOOK_URL) {
            console.log('\n⚠️  WEBHOOK_URL is not set — events will queue but never send.');
            console.log('   Set WEBHOOK_URL and WEBHOOK_SECRET in .env, then run:');
            console.log('     */2 * * * * cd /path/to/backend && node jobs/webhookSender.js');
        }
    } catch (err) {
        console.warn('\n⚠️  Migration succeeded, but the summary failed:', err.message);
    }
}

migrate()
    .then(() => db.pool.end())
    .catch(async () => { try { await db.pool.end(); } catch { /* closing */ } process.exit(1); });
