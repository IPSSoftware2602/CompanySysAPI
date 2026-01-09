const { execSync } = require('child_process');
const path = require('path');

const migrations = [
    'migrate_kanban.js',
    'migrate_gatekeeping.js',
    'migrate_supporting_projects.js',
    'migrate_support_schema.js',
    'migrate_support_dates.js',
    'migrate_ticket_dates.js',
    'migrate_ticket_position.js',
    'migrate_checklist_multimember.js',
    'migrate_checklist_metadata.js',
    'migrate_checklist_metadata_refactor.js',
    'migrate_checklist_completion.js',
    'migrate_trello_features.js',
    'migrate_activity_logs.js'
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
