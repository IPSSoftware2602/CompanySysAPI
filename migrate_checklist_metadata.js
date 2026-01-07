const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding metadata columns to ticket_checklist_items table...');

        // Add assigned_member_id
        await client.query(`
            ALTER TABLE ticket_checklist_items 
            ADD COLUMN IF NOT EXISTS assigned_member_id UUID REFERENCES users(id);
        `);

        // Add start_time
        await client.query(`
            ALTER TABLE ticket_checklist_items 
            ADD COLUMN IF NOT EXISTS start_time TIMESTAMP WITH TIME ZONE;
        `);

        // Add end_time
        await client.query(`
            ALTER TABLE ticket_checklist_items 
            ADD COLUMN IF NOT EXISTS end_time TIMESTAMP WITH TIME ZONE;
        `);

        console.log('Successfully added assigned_member_id, start_time, and end_time columns');

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
