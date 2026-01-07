const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Creating supporting_projects table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS supporting_projects (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                description TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Updating support_tickets to reference supporting_projects...');
        // We will Add supporting_project_id
        await client.query(`
            ALTER TABLE support_tickets 
            ADD COLUMN IF NOT EXISTS supporting_project_id UUID REFERENCES supporting_projects(id) ON DELETE CASCADE;
        `);

        // We can keep project_id for legacy or drop it. 
        // User said "Project under support ticket getting data from that", implies replacement.
        // But to avoid data loss if any exists (unlikely as it was just created), we'll make project_id nullable if it was not.
        // In previous migration, project_id was just created, assumed nullable?
        // Let's check schema: "project_id UUID REFERENCES projects(id) ON DELETE CASCADE". It didn't say NOT NULL explicitly in the CREATE statement I wrote?
        // Wait, I didn't verify if I put NOT NULL. 
        // Let's assume it's nullable or make it so.
        await client.query(`
            ALTER TABLE support_tickets 
            ALTER COLUMN project_id DROP NOT NULL;
        `);

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
