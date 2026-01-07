const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Creating ticket_checklist_assignments table...');

        // Create new junction table
        await client.query(`
            CREATE TABLE IF NOT EXISTS ticket_checklist_assignments (
                checklist_id UUID REFERENCES ticket_checklists(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (checklist_id, user_id)
            );
        `);

        // Migrate existing data
        console.log('Migrating existing assignments...');
        await client.query(`
            INSERT INTO ticket_checklist_assignments (checklist_id, user_id)
            SELECT id, assigned_member_id 
            FROM ticket_checklists 
            WHERE assigned_member_id IS NOT NULL;
        `);

        // Remove old column
        console.log('Removing old assigned_member_id column...');
        await client.query(`
            ALTER TABLE ticket_checklists 
            DROP COLUMN IF EXISTS assigned_member_id;
        `);

        console.log('Successfully implemented multiple member assignments');

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
