const db = require('./db');

/**
 * Ticket-created group notification, and the removal of the unused WhatsApp
 * tables. See CR_SUPPORT_ENHANCEMENTS.md batch 2.
 *
 *   1. Drops whatsapp_conversation_states / whatsapp_project_mappings /
 *      whatsapp_internal_contacts. Confirmed unused: no code in this repo
 *      references them, nothing outside them holds a foreign key to them, and
 *      Marcus confirmed on 2026-08-27 that the approach they belonged to has
 *      been replaced by WATO.
 *
 *      Their contents (one row each) are preserved in
 *      data/whatsapp_tables_backup_2026-08-27.json.
 *
 *      ⚠️  This is the one irreversible step in the CR. If any system OUTSIDE
 *      this repo reads these tables directly, it will break. Say so before
 *      running this on live.
 *
 *   2. Adds webhook_deliveries.channel, so the same outbox can carry a WhatsApp
 *      group message as well as a webhook to the AI workflow. Reusing the
 *      outbox rather than posting inline means a WATO outage delays the group
 *      message instead of failing the ticket that triggered it.
 *
 * Idempotent: safe to re-run.
 */
async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // --- 1. Drop the unused WhatsApp tables ---------------------------
        // Dependency order: conversation_states -> project_mappings.
        for (const table of [
            'whatsapp_conversation_states',
            'whatsapp_project_mappings',
            'whatsapp_internal_contacts',
        ]) {
            const { rows: [{ exists }] } = await client.query(
                `SELECT to_regclass($1) IS NOT NULL AS exists`, [table]
            );
            if (exists) {
                await client.query(`DROP TABLE ${table}`);
                console.log(`   dropped ${table}`);
            } else {
                console.log(`   ${table} already gone — skipping`);
            }
        }

        // --- 2. Outbox channel -------------------------------------------
        await client.query(`
            ALTER TABLE webhook_deliveries
            ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'WEBHOOK'
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_channel_due
            ON webhook_deliveries (channel, status, next_attempt_at)
        `);
        console.log('   ✅ webhook_deliveries.channel present');

        await client.query('COMMIT');
        console.log('\n✨ Group notification migration completed.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await db.pool.end();
    }
}

migrate();
