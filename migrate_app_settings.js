const db = require('./db');

/**
 * Settings a person edits in the app, rather than an operator edits in .env.
 *
 * WATO's URL, token and group id started life as environment variables. They
 * moved here because changing who gets notified should not require a shell on
 * the production box and a restart.
 *
 * Secrets live in the same table but are flagged, so the read API can mask them
 * on the way out. They are stored in clear: unlike a password we verify, these
 * have to be replayable to be usable. That makes this table as sensitive as
 * .env was — reads are gated to managers.
 *
 * Idempotent: safe to re-run.
 */
async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key             VARCHAR(80) PRIMARY KEY,
                value           TEXT,
                is_secret       BOOLEAN NOT NULL DEFAULT FALSE,
                updated_by      UUID REFERENCES users(id),
                updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('   ✅ app_settings present');

        // Carry over anything already configured through .env, so a system set
        // up the old way keeps working without anyone retyping a token.
        const carryOver = [
            ['wato_api_url', process.env.WATO_API_URL, false],
            ['wato_api_token', process.env.WATO_API_TOKEN, true],
            ['wato_group_id', process.env.WATO_GROUP_ID, false],
        ];
        for (const [key, value, secret] of carryOver) {
            if (!value) continue;
            const { rowCount } = await client.query(
                `INSERT INTO app_settings (key, value, is_secret)
                 VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
                [key, value, secret]
            );
            if (rowCount) console.log(`   imported ${key} from .env`);
        }

        await client.query('COMMIT');
        console.log('\n✨ App settings migration completed.');
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
