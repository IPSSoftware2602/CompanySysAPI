require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const pool = require('./db');

async function seedLabels() {
    try {
        console.log('Seeding demo labels...');

        // Get all projects
        const projectsResult = await pool.query('SELECT id FROM projects');
        const projects = projectsResult.rows;

        // Default Trello-like label colors and names
        const labelTemplates = [
            { name: 'Bug', color: '#eb5a46' },          // Red
            { name: 'Feature', color: '#61bd4f' },      // Green
            { name: 'Enhancement', color: '#f2d600' },  // Yellow
            { name: 'Documentation', color: '#0079bf' },// Blue
            { name: 'Priority', color: '#ff9f1a' },     // Orange
            { name: 'Review', color: '#c377e0' },       // Purple
            { name: 'Testing', color: '#00c2e0' },      // Cyan
            { name: 'Design', color: '#ff78cb' },       // Pink
        ];

        // Create labels for each project
        for (const project of projects) {
            for (const template of labelTemplates) {
                await pool.query(
                    'INSERT INTO labels (name, color, project_id) VALUES ($1, $2, $3)',
                    [template.name, template.color, project.id]
                );
            }
            console.log(`Created labels for project: ${project.id}`);
        }

        console.log('✅ Demo labels seeded successfully!');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding labels:', error);
        process.exit(1);
    }
}

seedLabels();
