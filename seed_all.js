const { execSync } = require('child_process');
const path = require('path');

const seeders = [
    'seed_users.js',
    'seed_labels.js',
    'seed_demo_data.js'
];

console.log('🌱 Starting database seeding...');
console.log('⚠️  Note: Some seeders might skip if data already exists.');

for (const seeder of seeders) {
    try {
        console.log(`\nRunning ${seeder}...`);
        execSync(`node ${seeder}`, {
            cwd: __dirname,
            stdio: 'inherit'
        });
    } catch (error) {
        console.error(`❌ Error running ${seeder}:`, error.message);
        process.exit(1);
    }
}

console.log('\n✨ Seeding completed successfully!');
