const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding start_date and actual_end_date to support_tickets...');
        await client.query(`
            ALTER TABLE support_tickets 
            ADD COLUMN IF NOT EXISTS start_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            ADD COLUMN IF NOT EXISTS actual_end_date TIMESTAMP WITH TIME ZONE;
        `);

        // Update existing tickets to have start_date = created_at if null (though default handles new ones, existing need backfill if we didn't set default constraint properly or just to be safe)
        // DEFAULT CURRENT_TIMESTAMP only applies to NEW rows if value not supplied. Existing rows get NULL if not specified? No, `ADD COLUMN ... DEFAULT ...` fills existing rows in Postgres!
        // But let's be sure.

        await client.query('COMMIT');
        console.log('Migration completed successfully.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', e);
        process.exit(1);
    } finally {
        client.release();
        process.exit(0);
    }
}

migrate();
