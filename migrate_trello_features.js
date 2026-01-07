const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding cover columns to tickets...');
        await client.query(`
            ALTER TABLE tickets 
            ADD COLUMN IF NOT EXISTS cover_color VARCHAR(50),
            ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
        `);

        console.log('Creating generic checklists tables...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS ticket_checklists (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                position INTEGER DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS ticket_checklist_items (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                checklist_id UUID REFERENCES ticket_checklists(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                is_completed BOOLEAN DEFAULT FALSE,
                position INTEGER DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Creating ticket assignments table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS ticket_assignments (
                ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (ticket_id, user_id)
            );
        `);

        console.log('Migrating existing assignments...');
        // Migrate existing assigned_to_user_id to ticket_assignments
        await client.query(`
            INSERT INTO ticket_assignments (ticket_id, user_id)
            SELECT id, assigned_to_user_id
            FROM tickets
            WHERE assigned_to_user_id IS NOT NULL
            ON CONFLICT DO NOTHING;
        `);

        // We keep assigned_to_user_id for now as a "primary assignee" or just legacy, 
        // but the UI will switch to using the join table.

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
