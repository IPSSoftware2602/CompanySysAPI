const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding start_date column to tickets table...');
        await client.query(`
            ALTER TABLE tickets 
            ADD COLUMN IF NOT EXISTS start_date TIMESTAMP WITH TIME ZONE;
        `);

        console.log('Renaming due_date to end_date...');
        await client.query(`
            ALTER TABLE tickets 
            RENAME COLUMN due_date TO end_date;
        `);

        console.log('Migrating existing data: end_date values are preserved, start_date remains null');
        // No additional data migration needed - existing due_date is now end_date

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
