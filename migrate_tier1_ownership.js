/**
 * Tier 1: ticket ownership and completion evidence.
 *
 * 1. owner_user_id — the ONE accountable owner.
 *    Today assignment is expressed two ways: tickets.assigned_to_user_id (which
 *    myWorkModel already calls "legacy") and the ticket_assignments junction.
 *    Neither says who is accountable. This adds that, keeping
 *    ticket_assignments for collaborators, per the enhancement plan's 18.6.
 *
 *    assigned_to_user_id is deliberately NOT dropped here. Reads move to
 *    owner_user_id and writes keep both in sync for one release; the column
 *    comes out once nothing references it. Dropping it in the same migration
 *    that introduces its replacement is how you take an outage.
 *
 * 2. completion_explanation / pull_request_url / test_evidence.
 *    Captured at the DONE transition and deliberately NOT enforced as a gate —
 *    hard gates on a five-person team teach people to game the status field.
 *    Their absence instead costs credit via the v2 evidence penalty.
 *
 * Additive and idempotent. Safe to re-run.
 *
 *   node migrate_tier1_ownership.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1. Adding tickets.owner_user_id...');
        await client.query(`
            ALTER TABLE tickets
            ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS tickets_owner_idx
            ON tickets (owner_user_id) WHERE deleted_at IS NULL;
        `);

        console.log('2. Adding completion evidence columns...');
        await client.query(`
            ALTER TABLE tickets
            ADD COLUMN IF NOT EXISTS completion_explanation TEXT,
            ADD COLUMN IF NOT EXISTS pull_request_url       TEXT,
            ADD COLUMN IF NOT EXISTS test_evidence          TEXT;
        `);

        console.log('3. Backfilling owner_user_id...');
        // Prefer the legacy single-assignee column; fall back to the earliest
        // collaborator, which is the closest thing to "who picked this up first".
        const { rowCount: fromLegacy } = await client.query(`
            UPDATE tickets
            SET owner_user_id = assigned_to_user_id
            WHERE owner_user_id IS NULL AND assigned_to_user_id IS NOT NULL;
        `);
        const { rowCount: fromAssignments } = await client.query(`
            UPDATE tickets t
            SET owner_user_id = first_assignment.user_id
            FROM (
                SELECT DISTINCT ON (ticket_id) ticket_id, user_id
                FROM ticket_assignments
                ORDER BY ticket_id, assigned_at ASC
            ) AS first_assignment
            WHERE t.id = first_assignment.ticket_id
              AND t.owner_user_id IS NULL;
        `);
        console.log(`   ${fromLegacy} from assigned_to_user_id, ${fromAssignments} from earliest assignment`);

        // Every owner must also appear as a collaborator, so the junction stays
        // the complete picture of "who is on this ticket".
        console.log('4. Ensuring owners are present in ticket_assignments...');
        const { rowCount: linked } = await client.query(`
            INSERT INTO ticket_assignments (ticket_id, user_id)
            SELECT id, owner_user_id FROM tickets
            WHERE owner_user_id IS NOT NULL
            ON CONFLICT DO NOTHING;
        `);
        console.log(`   ${linked} owner assignment(s) added`);

        const { rows: [stats] } = await client.query(`
            SELECT count(*) AS total,
                   count(owner_user_id) AS with_owner
            FROM tickets WHERE deleted_at IS NULL;
        `);

        await client.query('COMMIT');

        console.log('\n✅ Tier 1 ownership migration complete.');
        console.log(`   ${stats.with_owner}/${stats.total} live tickets have an owner.`);
        if (Number(stats.total) > Number(stats.with_owner)) {
            console.log(`   ⚠️  ${stats.total - stats.with_owner} ticket(s) have no owner and no assignment —`);
            console.log('      they will show under nobody\'s My Work until someone is assigned.');
        }
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

migrate()
    .then(() => db.pool.end())
    .catch(async (err) => {
        console.error('❌ Migration failed:', err.message);
        console.error(err.stack);
        try { await db.pool.end(); } catch { /* already closing */ }
        process.exit(1);
    });
