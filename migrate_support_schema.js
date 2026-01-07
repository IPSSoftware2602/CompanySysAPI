const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Creating Support Enums...');
        // Create ENUMs if they don't exist logic is tricky in pure SQL without blocks, 
        // usually 'CREATE TYPE ...' fails if exists. 
        // We will wrap in DO blocks or just catch errors if we were lazy, but DO block is better.

        await client.query(`
            DO $$ BEGIN
                CREATE TYPE support_request_type AS ENUM ('BUG', 'AMENDMENT', 'CHANGE_REQUEST', 'FEATURE', 'QUESTION', 'DATA_ISSUE');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        await client.query(`
            DO $$ BEGIN
                CREATE TYPE support_priority AS ENUM ('P0', 'P1', 'P2', 'P3');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        await client.query(`
            DO $$ BEGIN
                CREATE TYPE support_ticket_status AS ENUM ('NEW', 'TRIAGING', 'DOING', 'WAITING_FOR_CLIENT', 'TESTING', 'PENDING_DEPLOYMENT', 'COMPLETED', 'CLOSED');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        console.log('Creating support_tickets table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                ticket_key VARCHAR(50) UNIQUE NOT NULL, -- SC-YYYYMM-XXXX
                project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
                request_type support_request_type NOT NULL,
                priority support_priority NOT NULL,
                risk_level VARCHAR(50), -- Low, Medium, High, Critical (or just free text)
                status support_ticket_status DEFAULT 'NEW',
                
                title VARCHAR(255) NOT NULL,
                description TEXT,
                steps_to_reproduce TEXT,
                attachments JSONB DEFAULT '[]',
                
                sla_due_at TIMESTAMP WITH TIME ZONE,
                
                created_by_user_id UUID REFERENCES users(id),
                assigned_pm_id UUID REFERENCES users(id),
                assigned_dev_id UUID REFERENCES users(id),
                
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMP WITH TIME ZONE
            );
        `);

        console.log('Creating support_ticket_transitions table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS support_ticket_transitions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                support_ticket_id UUID REFERENCES support_tickets(id) ON DELETE CASCADE,
                from_status support_ticket_status,
                to_status support_ticket_status NOT NULL,
                performed_by_user_id UUID REFERENCES users(id),
                reason TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Updating comments table...');
        await client.query(`
            ALTER TABLE comments 
            ADD COLUMN IF NOT EXISTS support_ticket_id UUID REFERENCES support_tickets(id) ON DELETE CASCADE;
        `);

        // Remove NOT NULL constraint from ticket_id if it exists, to allow comments on EITHER ticket
        // Assuming current schema has ticket_id NOT NULL.
        // Let's check schema first? Or just try to drop not null.
        await client.query(`
            ALTER TABLE comments 
            ALTER COLUMN ticket_id DROP NOT NULL;
        `);

        // Add CHECK constraint to ensure comment belongs to one or the other
        /* 
           Note: Adding a constraint now might fail if there are existing rows where both are null (unlikely) 
           or both are set (impossible since we just added one). 
           But let's add it for data integrity.
        */
        await client.query(`
            DO $$ BEGIN
                ALTER TABLE comments 
                ADD CONSTRAINT comments_target_check 
                CHECK (
                    (ticket_id IS NOT NULL AND support_ticket_id IS NULL) OR 
                    (ticket_id IS NULL AND support_ticket_id IS NOT NULL)
                );
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
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
