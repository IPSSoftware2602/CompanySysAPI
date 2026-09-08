const { execSync } = require('child_process');
const path = require('path');

const migrations = [
    // --- Base kanban schema (schema.sql via init_db.js must have run first) ---
    'migrate_kanban.js',
    'migrate_gatekeeping.js',

    // --- Support tickets ---
    'migrate_support_schema.js',
    'migrate_supporting_projects.js',
    'migrate_support_dates.js',

    // --- Kanban ticket fields ---
    'migrate_ticket_dates.js',
    'migrate_ticket_position.js',
    'migrate_trello_features.js',

    // --- Checklists ---
    'migrate_checklist_multimember.js',
    'migrate_checklist_metadata.js',
    'migrate_checklist_metadata_refactor.js',
    'migrate_checklist_completion.js',

    // --- Users, projects, activity ---
    'migrate_activity_logs.js',
    'migrate_admin_role.js',
    'migrate_user_soft_delete.js',
    'migrate_project_status.js',

    // --- Credits, then the columns and audit trail that build on them ---
    'idempotent_migrate_credits.js',
    'migration_add_missing_columns.js',
    'migrate_tier1.js',            // creates audit_logs; alters credit_evaluations
    'migrate_tier1_ownership.js',

    // --- Integration. Order matters: api_keys before idempotency_keys, which
    //     references it; audit_logs (tier1) before api_keys, which alters it. ---
    'migrate_api_keys.js',
    'migrate_companies.js',
    'migrate_integration.js',

    // --- SLA, time logging, ticket numbering ---
    'migrate_sla_v2.js',
    'migrate_time_logs.js',
    'migrate_ticket_sequences.js',

    // --- Outbox. Must precede group notifications, which alters it. ---
    'migrate_webhooks.js',

    // --- Recent work ---
    'migrate_support_enhancements.js',
    'migrate_group_notifications.js',
    'migrate_app_settings.js',
    'migrate_xtech_rename.js',
    'migrate_iris_integration.js'
];

console.log('🚀 Starting full database migration...');

for (const migration of migrations) {
    try {
        console.log(`\n📦 Running ${migration}...`);
        execSync(`node ${migration}`, {
            cwd: __dirname,
            stdio: 'inherit'
        });
        console.log(`✅ ${migration} completed`);
    } catch (error) {
        console.error(`❌ Error running ${migration}:`, error.message);
        process.exit(1);
    }
}

console.log('\n✨ All migrations completed successfully!');
