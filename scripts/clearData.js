/**
 * Wipes operational data, keeping the accounts people log in with.
 *
 *   node scripts/clearData.js --confirm
 *
 * KEPT: users, and the reference tables the system reads rather than the ones
 * people fill in — sla_targets and public_holidays (deleting them silently
 * changes every SLA and delay figure), labels and checklist_templates.
 *
 * DELETED: everything else, including projects, companies, every ticket, API
 * keys and app settings.
 *
 * Refuses to run without --confirm, because the only thing standing between a
 * typo and someone's data is this check.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db');

const KEEP = new Set([
    'users',
    'sla_targets',
    'public_holidays',
    'labels',
    'checklist_templates',
]);

async function main() {
    if (!process.argv.includes('--confirm')) {
        console.log('Refusing to run without --confirm.');
        console.log('This deletes all projects, companies, tickets, API keys and settings.');
        process.exitCode = 1;
        return;
    }

    const { rows } = await db.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);

    const targets = rows.map((r) => r.table_name).filter((t) => !KEEP.has(t));

    console.log('Keeping :', [...KEEP].join(', '));
    console.log('Clearing:', targets.join(', '));

    // One statement so foreign keys never have to be ordered by hand, and
    // RESTART IDENTITY puts ticket numbering back to 0001.
    await db.query(`TRUNCATE ${targets.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

    const { rows: [u] } = await db.query('SELECT count(*) c FROM users WHERE deleted_at IS NULL');
    console.log(`\n✅ Cleared. ${u.c} user account(s) still present.`);
    console.log('   Next: log in, create a project, set its tech lead, then file a ticket.');

    await db.pool.end();
}

main().catch(async (e) => {
    console.error('❌ Failed:', e.message);
    process.exitCode = 1;
    await db.pool.end();
});
