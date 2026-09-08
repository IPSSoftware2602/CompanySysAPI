/**
 * IRIS integration — the WhatsApp group a project's customers talk in.
 *
 * IRIS files a ticket from a group conversation and tells us only the group's
 * JID. One group per client company, so the JID is the mapping key back to a
 * project — without it a ticket lands unattributed and the time logged against
 * it reaches no invoice.
 *
 * Idempotent, like every migration here.
 */
require('dotenv').config();
const db = require('./db');

async function migrate() {
    await db.query(`
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS whatsapp_group_jid VARCHAR(64)
    `);

    // A group belongs to exactly one project: two projects claiming the same
    // group would make "which project is this ticket for" unanswerable, and the
    // resolver would silently pick whichever row sorted first. Partial, so the
    // many projects with no group set do not collide on NULL.
    await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS projects_whatsapp_group_jid_key
            ON projects (whatsapp_group_jid)
            WHERE whatsapp_group_jid IS NOT NULL
    `);

    console.log('IRIS integration migration complete');
}

if (require.main === module) {
    migrate()
        .then(() => process.exit(0))
        .catch((err) => { console.error('Migration failed:', err); process.exit(1); });
}

module.exports = migrate;
