const db = require('./db');

/**
 * Tier 1 migration (additive, idempotent, non-destructive).
 *
 * Adds:
 *  - Soft-delete columns on tickets, support_tickets, credit_evaluations
 *  - Credit lock columns (locked_at, locked_by)
 *  - Blocker tracking columns on tickets and support_tickets
 *  - support_tickets.linked_ticket_id (support -> dev task link)
 *  - audit_logs table (generic critical-action audit trail)
 *
 * Rollback: drop the added columns and the audit_logs table.
 */
async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1/5  Soft-delete columns...');
        await client.query(`ALTER TABLE tickets            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;`);
        await client.query(`ALTER TABLE support_tickets     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;`);
        await client.query(`ALTER TABLE credit_evaluations  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;`);

        console.log('2/5  Credit lock columns...');
        await client.query(`ALTER TABLE credit_evaluations  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;`);
        await client.query(`ALTER TABLE credit_evaluations  ADD COLUMN IF NOT EXISTS locked_by UUID REFERENCES users(id);`);

        console.log('3/5  Blocker columns (tickets + support_tickets)...');
        for (const table of ['tickets', 'support_tickets']) {
            await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;`);
            await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS blocked_reason TEXT;`);
            await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMP WITH TIME ZONE;`);
            await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS blocked_by_user_id UUID REFERENCES users(id);`);
        }

        console.log('4/5  Support -> dev task link...');
        await client.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS linked_ticket_id UUID REFERENCES tickets(id);`);

        console.log('5/5  audit_logs table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                user_id UUID REFERENCES users(id),
                action VARCHAR(50) NOT NULL,          -- CREATE, UPDATE, DELETE, STATUS_CHANGE, BLOCK, ...
                entity_type VARCHAR(50) NOT NULL,     -- TICKET, SUPPORT_TICKET, CREDIT_EVALUATION
                entity_id UUID,
                before_data JSONB,
                after_data JSONB,
                reason TEXT,
                ip_address VARCHAR(64),
                user_agent TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);`);

        await client.query('COMMIT');
        console.log('\nTier 1 migration completed successfully.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Migration failed (rolled back):', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await db.pool.end();
    }
}

migrate();
