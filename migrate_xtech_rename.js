const db = require('./db');

/**
 * Renames the wato_* settings keys to xtech_*.
 *
 * Values are carried across, so a system already configured keeps sending
 * without anyone retyping a token. The old rows are removed once copied.
 *
 * Idempotent: safe to re-run, and a no-op once applied.
 */
const RENAMES = [
    ['wato_api_url', 'xtech_api_url'],
    ['wato_api_token', 'xtech_api_token'],
    ['wato_group_id', 'xtech_group_id'],
    ['wato_message_template', 'xtech_message_template'],
];

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        for (const [from, to] of RENAMES) {
            // ON CONFLICT DO NOTHING: if the new key already holds a value,
            // that value is the current one and must not be clobbered by a
            // stale row left from a half-finished run.
            const { rowCount } = await client.query(
                `INSERT INTO app_settings (key, value, is_secret, updated_by, updated_at)
                 SELECT $2, value, is_secret, updated_by, updated_at
                 FROM app_settings WHERE key = $1
                 ON CONFLICT (key) DO NOTHING`,
                [from, to]
            );
            const { rowCount: removed } = await client.query(
                'DELETE FROM app_settings WHERE key = $1', [from]
            );
            if (rowCount || removed) console.log(`   ${from} -> ${to}`);
        }

        await client.query('COMMIT');
        console.log('\n✨ XTECH rename migration completed.');
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
