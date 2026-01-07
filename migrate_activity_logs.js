const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Creating ticket_activity_logs table...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS ticket_activity_logs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id),
                action VARCHAR(50) NOT NULL,
                field_changed VARCHAR(100),
                old_value TEXT,
                new_value TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_ticket_activity_logs_ticket 
            ON ticket_activity_logs(ticket_id);
        `);

        console.log('Successfully created ticket_activity_logs table and index');

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
