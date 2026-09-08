const db = require('./db');

/**
 * Support Centre enhancements — batch 1. See CR_SUPPORT_ENHANCEMENTS.md.
 *
 *   1. TRIAGING removed from support_ticket_status (rows moved to NEW first).
 *   2. tech_lead_id override + reviewer/review-stamp columns on support_tickets.
 *   3. support_ticket_checklist_items — a flat, free-form list per ticket,
 *      deliberately separate from the kanban ticket_checklists tables.
 *
 * Idempotent: safe to re-run, and a no-op once applied.
 *
 * Step 1 is the only destructive step. Postgres cannot drop an enum value, so
 * the type is rebuilt and both columns using it are re-typed. All of it runs in
 * one transaction — a failure leaves the old type in place, not a half-migrated
 * one.
 */
async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // --- 1. Drop TRIAGING ---------------------------------------------
        const { rows: [{ exists: hasTriaging }] } = await client.query(`
            SELECT EXISTS (
                SELECT 1 FROM pg_enum e
                JOIN pg_type t ON t.oid = e.enumtypid
                WHERE t.typname = 'support_ticket_status' AND e.enumlabel = 'TRIAGING'
            ) AS exists
        `);

        if (hasTriaging) {
            const { rowCount: moved } = await client.query(
                `UPDATE support_tickets SET status = 'NEW', updated_at = CURRENT_TIMESTAMP
                 WHERE status = 'TRIAGING'`
            );
            console.log(`   moved ${moved} ticket(s) from TRIAGING to NEW`);

            // History rows carry the same enum, so they have to be rewritten
            // before the value can disappear. The transition log keeps its
            // shape — "went to NEW" is a lie about the past, but a dropped
            // enum value leaves no honest alternative and nothing reads
            // from_status/to_status for anything but display.
            const { rowCount: from } = await client.query(
                `UPDATE support_ticket_transitions SET from_status = 'NEW' WHERE from_status = 'TRIAGING'`
            );
            const { rowCount: to } = await client.query(
                `UPDATE support_ticket_transitions SET to_status = 'NEW' WHERE to_status = 'TRIAGING'`
            );
            console.log(`   rewrote ${from + to} transition row(s)`);

            console.log('   rebuilding support_ticket_status without TRIAGING...');
            await client.query(`
                CREATE TYPE support_ticket_status_new AS ENUM (
                    'NEW', 'DOING', 'WAITING_FOR_CLIENT', 'TESTING',
                    'PENDING_DEPLOYMENT', 'COMPLETED', 'CLOSED', 'CANCELLED'
                )
            `);
            // The column default references the old type and would block the
            // cast, so it is dropped and restored around it.
            await client.query(`ALTER TABLE support_tickets ALTER COLUMN status DROP DEFAULT`);
            await client.query(`
                ALTER TABLE support_tickets
                ALTER COLUMN status TYPE support_ticket_status_new
                USING status::text::support_ticket_status_new
            `);
            await client.query(`
                ALTER TABLE support_ticket_transitions
                ALTER COLUMN from_status TYPE support_ticket_status_new
                USING from_status::text::support_ticket_status_new
            `);
            await client.query(`
                ALTER TABLE support_ticket_transitions
                ALTER COLUMN to_status TYPE support_ticket_status_new
                USING to_status::text::support_ticket_status_new
            `);
            await client.query(`DROP TYPE support_ticket_status`);
            await client.query(`ALTER TYPE support_ticket_status_new RENAME TO support_ticket_status`);
            await client.query(`ALTER TABLE support_tickets ALTER COLUMN status SET DEFAULT 'NEW'`);
            console.log('   ✅ TRIAGING removed');
        } else {
            console.log('   TRIAGING already gone — skipping');
        }

        // --- 2. Tech lead + review columns --------------------------------
        // tech_lead_id is an OVERRIDE, not a copy: NULL means "follow whatever
        // the project's tech lead is right now", which is why it is not
        // backfilled from projects here.
        await client.query(`
            ALTER TABLE support_tickets
            ADD COLUMN IF NOT EXISTS tech_lead_id        UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS reviewer_user_id    UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS reviewed_by_user_id UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS reviewed_at         TIMESTAMP WITH TIME ZONE
        `);
        console.log('   ✅ tech_lead_id / reviewer columns present');

        // --- 3. Support checklist -----------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS support_ticket_checklist_items (
                id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                support_ticket_id  UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
                content            TEXT NOT NULL,
                is_done            BOOLEAN NOT NULL DEFAULT FALSE,
                position           INTEGER NOT NULL DEFAULT 0,
                created_by_user_id UUID REFERENCES users(id),
                done_by_user_id    UUID REFERENCES users(id),
                done_at            TIMESTAMP WITH TIME ZONE,
                created_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_support_checklist_ticket
            ON support_ticket_checklist_items (support_ticket_id, position)
        `);
        console.log('   ✅ support_ticket_checklist_items present');

        await client.query('COMMIT');
        console.log('\n✨ Support enhancements migration completed.');
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
