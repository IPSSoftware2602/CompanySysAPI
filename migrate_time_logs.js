/**
 * Time logging — billing-grade.
 *
 * 1. supporting_projects.project_id
 *    Support tickets reach a client through supporting_projects, which had no
 *    client and no link to projects — so support work, the work most likely to
 *    sit on a retainer, could not be attributed to anyone. This closes that gap
 *    without merging the two tables.
 *
 * 2. work_time_logs
 *    Polymorphic over kanban and support work the same way credit_evaluations
 *    already is, so the shape is familiar. Three deliberate choices:
 *
 *    - minutes are stored EXACTLY. Rounding is applied when a report or invoice
 *      is generated, never on write. Rounding on write destroys the source
 *      number, and you can never re-derive it under a different agreement.
 *
 *    - logged_for_date is separate from created_at. People log Friday's work on
 *      Monday; without this every retrospective entry lands in the wrong
 *      billing period.
 *
 *    - APPROVED and LOCKED entries are immutable (enforced in timeLogService).
 *      A correction creates a new entry rather than mutating history, so an
 *      invoice already sent still matches the data behind it.
 *
 * Additive and idempotent. Safe to re-run.
 *
 *   node migrate_time_logs.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1. Linking supporting_projects to projects...');
        await client.query(`
            ALTER TABLE supporting_projects
            ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
        `);

        console.log('2. Creating time_log_status enum...');
        await client.query(`
            DO $$ BEGIN
                CREATE TYPE time_log_status AS ENUM ('DRAFT','SUBMITTED','APPROVED','LOCKED');
            EXCEPTION WHEN duplicate_object THEN null; END $$;
        `);

        console.log('3. Creating work_time_logs...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS work_time_logs (
                id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

                ticket_id         UUID REFERENCES tickets(id),
                support_ticket_id UUID REFERENCES support_tickets(id),

                user_id           UUID NOT NULL REFERENCES users(id),

                -- Exact minutes as worked. Never pre-rounded.
                minutes           INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
                -- The day the work happened, NOT the day it was typed in.
                logged_for_date   DATE NOT NULL,

                is_billable       BOOLEAN NOT NULL DEFAULT TRUE,
                note              TEXT,

                status            time_log_status NOT NULL DEFAULT 'DRAFT',
                approved_by       UUID REFERENCES users(id),
                approved_at       TIMESTAMP WITH TIME ZONE,
                locked_at         TIMESTAMP WITH TIME ZONE,

                -- Set when this entry corrects an approved one, so a correction
                -- is traceable back to what it adjusts.
                corrects_entry_id UUID REFERENCES work_time_logs(id),

                created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                deleted_at        TIMESTAMP WITH TIME ZONE,

                CONSTRAINT one_work_item CHECK (
                    (ticket_id IS NOT NULL AND support_ticket_id IS NULL) OR
                    (ticket_id IS NULL AND support_ticket_id IS NOT NULL)
                )
            );
        `);

        console.log('4. Creating indexes...');
        // Timesheet views and period reports both filter person + date range.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_time_logs_user_date
                ON work_time_logs (user_id, logged_for_date)
                WHERE deleted_at IS NULL;
        `);
        // "How many hours on this ticket" — the ticket detail panel.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_time_logs_ticket
                ON work_time_logs (ticket_id) WHERE deleted_at IS NULL;
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_time_logs_support_ticket
                ON work_time_logs (support_ticket_id) WHERE deleted_at IS NULL;
        `);
        // Period locking and approval queues scan by status + date.
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_time_logs_status_date
                ON work_time_logs (status, logged_for_date)
                WHERE deleted_at IS NULL;
        `);

        await client.query('COMMIT');

        // --- report on what still needs a human ---
        const { rows: [sp] } = await db.query(
            'SELECT count(*) FILTER (WHERE project_id IS NULL) AS unlinked, count(*) AS total FROM supporting_projects'
        );
        const { rows: dupes } = await db.query(`
            SELECT name, client_name, count(*) AS n
            FROM projects
            GROUP BY name, client_name
            HAVING count(*) > 1
            ORDER BY count(*) DESC, name
        `);

        console.log('\n✅ Time logging migration complete.');

        if (Number(sp.unlinked) > 0) {
            console.log(`\n⚠️  ${sp.unlinked} of ${sp.total} supporting_project(s) have no project_id.`);
            console.log('   Support time logged against them cannot be attributed to a client');
            console.log('   and will be excluded from per-client billing reports.');
        }

        if (dupes.length) {
            const extra = dupes.reduce((sum, d) => sum + (Number(d.n) - 1), 0);
            console.log(`\n⚠️  ${dupes.length} duplicated project name/client pair(s), ${extra} redundant row(s):`);
            for (const d of dupes) {
                console.log(`     - "${d.name}" / ${d.client_name || '(no client)'} × ${d.n}`);
            }
            console.log('   Hours will split across duplicates and UNDER-BILL the client.');
            console.log('   Merge these before invoicing from this data.');
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed, rolled back:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

migrate()
    .then(() => db.pool.end())
    .catch(async () => { try { await db.pool.end(); } catch { /* closing */ } process.exit(1); });
