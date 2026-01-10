const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Ensuring Support Ticket SLA columns exist...');
        await client.query(`
            ALTER TABLE support_tickets 
            ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS reopen_count INTEGER DEFAULT 0;
        `);

        console.log('Creating Credit Enums...');
        await client.query(`
            DO $$ BEGIN
                CREATE TYPE credit_ticket_type AS ENUM ('KANBAN', 'SUPPORT');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;

            DO $$ BEGIN
                CREATE TYPE credit_status AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'ADJUSTED', 'REJECTED');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;

            DO $$ BEGIN
                CREATE TYPE credit_source AS ENUM ('SELF', 'COORDINATOR');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        `);

        console.log('Creating credit_evaluations table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS credit_evaluations (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                
                -- Linking to Tickets
                ticket_id UUID REFERENCES tickets(id),
                support_ticket_id UUID REFERENCES support_tickets(id),
                ticket_type credit_ticket_type NOT NULL,
                
                -- People
                assignee_user_id UUID REFERENCES users(id) NOT NULL,
                evaluator_user_id UUID REFERENCES users(id) NOT NULL,
                
                -- Period
                period_month DATE NOT NULL,
                
                -- Scores
                complexity_score DECIMAL(5,2) DEFAULT 0,
                effectiveness_score DECIMAL(5,2) DEFAULT 0,
                completeness_score DECIMAL(5,2) DEFAULT 0,
                
                -- SLA specific
                sla_response_score DECIMAL(5,2),
                sla_resolve_score DECIMAL(5,2),
                sla_score DECIMAL(5,2),
                
                error_level VARCHAR(50),
                
                final_score DECIMAL(5,2) NOT NULL DEFAULT 0,
                final_credit DECIMAL(10,2) DEFAULT 0,
                
                notes TEXT,
                status credit_status DEFAULT 'DRAFT',
                source credit_source NOT NULL,
                
                -- Immutable logic
                version INTEGER DEFAULT 1,
                original_evaluation_id UUID REFERENCES credit_evaluations(id),
                
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

                CONSTRAINT check_ticket_link CHECK (
                    (ticket_id IS NOT NULL AND support_ticket_id IS NULL) OR 
                    (ticket_id IS NULL AND support_ticket_id IS NOT NULL)
                )
            );
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
