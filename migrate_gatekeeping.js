const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        console.log('Updating checklist_required_for ENUM...');
        // ALTER TYPE cannot run inside a transaction block
        try {
            await client.query("ALTER TYPE checklist_required_for ADD VALUE 'READY_TO_DEPLOY'");
        } catch (e) {
            console.log('ENUM value READY_TO_DEPLOY might already exist or error:', e.message);
        }

        // Now start transaction for inserts
        await client.query('BEGIN');

        console.log('Inserting Gatekeeping Templates...');

        // Tech Lead Review (Gate for READY_FOR_DEV)
        await client.query(`
            INSERT INTO checklist_templates (name, items, required_for_status) VALUES 
            ('Tech Design Review', '[
                {"id": "architecture_approved", "text": "Architecture Approved"},
                {"id": "db_schema_reviewed", "text": "DB Schema Reviewed"},
                {"id": "security_check", "text": "Security Implications Checked"}
            ]', 'READY_FOR_DEV')
            ON CONFLICT DO NOTHING;
        `);

        // QA Sign-off (Gate for READY_TO_DEPLOY)
        await client.query(`
            INSERT INTO checklist_templates (name, items, required_for_status) VALUES 
            ('QA Sign-off', '[
                {"id": "functional_testing", "text": "Functional Testing Passed"},
                {"id": "regression_testing", "text": "Regression Testing Passed"},
                {"id": "ui_ux_verified", "text": "UI/UX Verified"},
                {"id": "mobile_responsive", "text": "Mobile Responsiveness Verified"}
            ]', 'READY_TO_DEPLOY')
            ON CONFLICT DO NOTHING;
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
