const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Creating lists table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS lists (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                mapped_status ticket_status, -- Optional: to map to existing statuses
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Adding list_id to tickets table...');
        await client.query(`
            ALTER TABLE tickets 
            ADD COLUMN IF NOT EXISTS list_id UUID REFERENCES lists(id) ON DELETE SET NULL;
        `);

        console.log('Migrating existing projects...');
        const projectsRes = await client.query('SELECT id FROM projects');
        const projects = projectsRes.rows;

        const STATUSES = [
            'BACKLOG',
            'TECH_DESIGN',
            'READY_FOR_DEV',
            'IN_PROGRESS',
            'CODE_REVIEW',
            'QA',
            'READY_TO_DEPLOY',
            'DONE'
        ];

        const STATUS_TITLES = {
            'BACKLOG': 'Backlog',
            'TECH_DESIGN': 'Tech Design',
            'READY_FOR_DEV': 'Ready for Dev',
            'IN_PROGRESS': 'In Progress',
            'CODE_REVIEW': 'Code Review',
            'QA': 'QA Testing',
            'READY_TO_DEPLOY': 'Ready to Deploy',
            'DONE': 'Done'
        };

        for (const project of projects) {
            console.log(`Processing project ${project.id}...`);
            
            for (let i = 0; i < STATUSES.length; i++) {
                const status = STATUSES[i];
                const title = STATUS_TITLES[status];

                // Check if list already exists (idempotency)
                const existingListRes = await client.query(
                    'SELECT id FROM lists WHERE project_id = $1 AND mapped_status = $2',
                    [project.id, status]
                );

                let listId;
                if (existingListRes.rows.length > 0) {
                    listId = existingListRes.rows[0].id;
                } else {
                    const insertRes = await client.query(
                        'INSERT INTO lists (project_id, name, position, mapped_status) VALUES ($1, $2, $3, $4) RETURNING id',
                        [project.id, title, i, status]
                    );
                    listId = insertRes.rows[0].id;
                }

                // Update tickets
                await client.query(
                    'UPDATE tickets SET list_id = $1 WHERE project_id = $2 AND status = $3 AND list_id IS NULL',
                    [listId, project.id, status]
                );
            }
        }

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
