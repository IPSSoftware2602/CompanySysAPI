const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Moving metadata from checklist items to checklist level...');

        // Remove columns from ticket_checklist_items
        await client.query(`
            ALTER TABLE ticket_checklist_items 
            DROP COLUMN IF EXISTS assigned_member_id,
            DROP COLUMN IF EXISTS start_time,
            DROP COLUMN IF EXISTS end_time;
        `);

        // Add columns to ticket_checklists
        await client.query(`
            ALTER TABLE ticket_checklists 
            ADD COLUMN IF NOT EXISTS assigned_member_id UUID REFERENCES users(id),
            ADD COLUMN IF NOT EXISTS start_time TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS end_time TIMESTAMP WITH TIME ZONE;
        `);

        console.log('Successfully moved metadata to checklist level');

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
