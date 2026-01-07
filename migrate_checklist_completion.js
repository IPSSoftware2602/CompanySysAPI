const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding completion tracking columns to ticket_checklists table...');

        // Add completed_at timestamp
        await client.query(`
            ALTER TABLE ticket_checklists 
            ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
        `);

        // Add completion_status (on_time, delayed, or NULL if not completed)
        await client.query(`
            ALTER TABLE ticket_checklists 
            ADD COLUMN IF NOT EXISTS completion_status VARCHAR(20);
        `);

        console.log('Successfully added completed_at and completion_status columns');

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
