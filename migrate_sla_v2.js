/**
 * SLA v2 migration — business-hours deadlines, holidays, and pause tracking.
 *
 * Additive and idempotent: creates tables, adds nullable columns, seeds
 * reference data. Nothing is dropped and no column type changes, so this is
 * safe to re-run and safe to roll back by ignoring the new columns.
 *
 * Backfill policy (confirmed with the team): OPEN tickets only. Closed history
 * keeps its original wall-clock sla_due_at so past reports stay reproducible.
 *
 *   node migrate_sla_v2.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const db = require('./db');
const holidayData = require('./data/holidays');
const { computeDeadlines } = require('./services/slaService');
const { SUPPORT_DONE_STATUSES } = require('./constants');

const SEED_TARGETS = [
    // priority, first response (business hours), resolution (business hours)
    ['P0', 1, 8],
    ['P1', 4, 24],
    ['P2', 8, 40],
    ['P3', 16, 80],
];

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1. Creating public_holidays...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS public_holidays (
                holiday_date DATE PRIMARY KEY,
                name         VARCHAR(255) NOT NULL,
                is_company   BOOLEAN NOT NULL DEFAULT FALSE,
                created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('2. Creating sla_targets...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS sla_targets (
                priority             support_priority PRIMARY KEY,
                first_response_hours NUMERIC(6,2) NOT NULL CHECK (first_response_hours > 0),
                resolution_hours     NUMERIC(6,2) NOT NULL CHECK (resolution_hours > 0),
                updated_at           TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('3. Creating sla_pauses...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS sla_pauses (
                id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                support_ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
                paused_at         TIMESTAMP WITH TIME ZONE NOT NULL,
                resumed_at        TIMESTAMP WITH TIME ZONE,
                reason            TEXT,
                paused_by_user_id UUID REFERENCES users(id),
                created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // At most one open pause per ticket — enforced, not just assumed by the service.
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS sla_pauses_one_open_per_ticket
            ON sla_pauses (support_ticket_id) WHERE resumed_at IS NULL;
        `);

        console.log('4. Adding SLA columns to support_tickets...');
        await client.query(`
            ALTER TABLE support_tickets
            ADD COLUMN IF NOT EXISTS first_response_due_at    TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS resolution_due_at        TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS sla_paused_total_minutes INTEGER NOT NULL DEFAULT 0;
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS support_tickets_resolution_due_idx
            ON support_tickets (resolution_due_at) WHERE deleted_at IS NULL;
        `);

        console.log('5. Adding is_internal to comments...');
        // Existing comments are internal notes by default: treating historical
        // rows as customer-visible would back-date first_response_at onto
        // tickets that never actually got a reply.
        await client.query(`
            ALTER TABLE comments
            ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT TRUE;
        `);
        // New comments should default to internal too — making a note public
        // must be a deliberate act, never an accident.

        console.log('6. Seeding sla_targets...');
        for (const [priority, fr, res] of SEED_TARGETS) {
            await client.query(
                `INSERT INTO sla_targets (priority, first_response_hours, resolution_hours)
                 VALUES ($1, $2, $3) ON CONFLICT (priority) DO NOTHING`,
                [priority, fr, res]
            );
        }

        console.log('7. Seeding public_holidays...');
        const seedable = holidayData.seedable();
        for (const h of seedable) {
            await client.query(
                `INSERT INTO public_holidays (holiday_date, name, is_company)
                 VALUES ($1, $2, $3) ON CONFLICT (holiday_date) DO NOTHING`,
                [h.holiday_date, h.name, Boolean(h.is_company)]
            );
        }
        console.log(`   seeded ${seedable.length} fixed-date holidays`);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        throw err;
    }

    // --- Backfill runs after the schema commit, in its own transaction ---
    try {
        await client.query('BEGIN');
        console.log('8. Backfilling deadlines for OPEN tickets...');

        const { rows: holidayRows } = await client.query('SELECT holiday_date FROM public_holidays');
        const holidays = holidayRows.map((r) => {
            const d = r.holiday_date;
            if (typeof d === 'string') return d.slice(0, 10);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        });

        const { rows: targetRows } = await client.query('SELECT * FROM sla_targets');
        const targets = Object.fromEntries(targetRows.map((r) => [r.priority, {
            first_response_hours: Number(r.first_response_hours),
            resolution_hours: Number(r.resolution_hours),
        }]));

        const { rows: open } = await client.query(
            `SELECT id, ticket_key, priority, start_date, created_at
             FROM support_tickets
             WHERE deleted_at IS NULL
               AND status <> ALL($1::support_ticket_status[])
               AND resolution_due_at IS NULL`,
            [SUPPORT_DONE_STATUSES]
        );

        let updated = 0;
        for (const t of open) {
            const startAt = t.start_date || t.created_at;
            if (!startAt) {
                console.warn(`   skip ${t.ticket_key}: no start_date or created_at`);
                continue;
            }
            const { first_response_due_at, resolution_due_at } =
                computeDeadlines({ priority: t.priority, startAt, targets, holidays });

            await client.query(
                `UPDATE support_tickets
                 SET first_response_due_at = $1, resolution_due_at = $2
                 WHERE id = $3`,
                [first_response_due_at, resolution_due_at, t.id]
            );
            updated++;
        }

        await client.query('COMMIT');
        console.log(`   backfilled ${updated} open ticket(s); closed history left untouched`);
    } catch (err) {
        await client.query('ROLLBACK');
        client.release();
        throw err;
    }

    client.release();

    const missing = holidayData.missing();
    console.log('\n✅ SLA v2 migration complete.');
    if (missing.length) {
        console.log(
            `\n⚠️  ${missing.length} variable-date holidays still have NO date and are being\n` +
            '   treated as normal working days. SLA deadlines spanning them will be wrong.\n' +
            '   Fill these in at backend/data/holidays.js and re-run this migration:\n'
        );
        for (const h of missing) console.log(`     - ${h.name}`);
        console.log('\n   Source: https://www.malaysia.gov.my/portal/content/30736\n');
    }

    const substitutes = holidayData.unconfirmedSubstitutes();
    if (substitutes.length) {
        console.log(
            `\nℹ️  ${substitutes.length} rest-day substitute(s) NOT seeded — company policy, not gazetted.\n` +
            '   Under the Employment Act 1955 a holiday falling on a rest day is\n' +
            '   substituted by the next working day. These are the 2026 cases:\n'
        );
        for (const h of substitutes) console.log(`     - ${h.holiday_date}  ${h.name}`);
        console.log(
            '\n   If IPS observes these, move them into VARIABLE_2026 in\n' +
            '   backend/data/holidays.js and re-run. Until then they count as\n' +
            '   ordinary working days.\n'
        );
    }
}

migrate()
    .then(() => db.pool.end())
    .catch(async (err) => {
        console.error('❌ Migration failed:', err.message);
        console.error(err.stack);
        try { await db.pool.end(); } catch { /* pool may already be closing */ }
        process.exit(1);
    });
