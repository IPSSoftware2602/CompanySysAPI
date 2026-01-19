const db = require('./db');

/**
 * Migration script to add all missing columns to the production database.
 * This script is idempotent and safe to run multiple times.
 * 
 * Run with: node migration_add_missing_columns.js
 */
async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('===== Starting Database Migration =====\n');

        // 1. Ensure uuid-ossp extension exists
        console.log('1. Ensuring uuid extension...');
        await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

        // 2. Add ticket_mark column to credit_evaluations
        console.log('2. Adding ticket_mark to credit_evaluations...');
        await client.query(`
            ALTER TABLE credit_evaluations 
            ADD COLUMN IF NOT EXISTS ticket_mark DECIMAL(5,2);
        `);

        // 3. Add start_date and end_date to tickets if missing
        console.log('3. Adding start_date and end_date to tickets...');
        await client.query(`
            ALTER TABLE tickets 
            ADD COLUMN IF NOT EXISTS start_date TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS end_date TIMESTAMP WITH TIME ZONE;
        `);

        // 4. Add start_date and actual_end_date to support_tickets if missing
        console.log('4. Adding start_date and actual_end_date to support_tickets...');
        await client.query(`
            ALTER TABLE support_tickets 
            ADD COLUMN IF NOT EXISTS start_date TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS actual_end_date TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP WITH TIME ZONE,
            ADD COLUMN IF NOT EXISTS reopen_count INTEGER DEFAULT 0;
        `);

        // 5. Create ticket_transitions table if not exists
        console.log('5. Creating ticket_transitions table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS ticket_transitions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
                from_status VARCHAR(50),
                to_status VARCHAR(50),
                performed_by_user_id UUID REFERENCES users(id),
                reason TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 6. Create support_ticket_transitions table if not exists
        console.log('6. Creating support_ticket_transitions table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS support_ticket_transitions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                support_ticket_id UUID REFERENCES support_tickets(id) ON DELETE CASCADE,
                from_status VARCHAR(50),
                to_status VARCHAR(50),
                performed_by_user_id UUID REFERENCES users(id),
                reason TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 7. Create credit enums if not exist
        console.log('7. Creating credit enums...');
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

        // 8. Create credit_evaluations table if not exists
        console.log('8. Creating credit_evaluations table (if not exists)...');
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
                ticket_mark DECIMAL(5,2),
                
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

        // 9. Create supporting_projects table if not exists
        console.log('9. Creating supporting_projects table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS supporting_projects (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                description TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 10. Add supporting_project_id to support_tickets if not exists
        console.log('10. Adding supporting_project_id to support_tickets...');
        await client.query(`
            ALTER TABLE support_tickets 
            ADD COLUMN IF NOT EXISTS supporting_project_id UUID REFERENCES supporting_projects(id);
        `);

        // 11. Create checklist tables if not exist
        console.log('11. Creating checklist tables...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS checklist_templates (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name VARCHAR(255) NOT NULL,
                project_id UUID REFERENCES projects(id),
                required_for_status VARCHAR(50),
                items JSONB DEFAULT '[]',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS checklist_submissions (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE,
                template_id UUID REFERENCES checklist_templates(id),
                submitted_by_user_id UUID REFERENCES users(id),
                items JSONB NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 12. Add indexes for performance
        console.log('12. Adding indexes...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_credit_evaluations_assignee ON credit_evaluations(assignee_user_id);
            CREATE INDEX IF NOT EXISTS idx_credit_evaluations_ticket ON credit_evaluations(ticket_id);
            CREATE INDEX IF NOT EXISTS idx_credit_evaluations_support_ticket ON credit_evaluations(support_ticket_id);
            CREATE INDEX IF NOT EXISTS idx_credit_evaluations_status ON credit_evaluations(status);
            CREATE INDEX IF NOT EXISTS idx_ticket_transitions_ticket ON ticket_transitions(ticket_id);
            CREATE INDEX IF NOT EXISTS idx_support_ticket_transitions_ticket ON support_ticket_transitions(support_ticket_id);
        `);

        await client.query('COMMIT');
        console.log('\n===== Migration completed successfully! =====');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('\n===== Migration failed =====');
        console.error('Error:', e.message);
        console.error('Details:', e);
        process.exit(1);
    } finally {
        client.release();
        process.exit(0);
    }
}

migrate();
