require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const pool = require('./db');

async function seedData() {
    try {
        console.log('Seeding demo data...');

        // Create sample projects
        const projects = [
            { name: 'IOS System', client_name: 'Internal' },
            { name: 'Client Portal', client_name: 'ABC Corporation' },
            { name: 'Mobile App', client_name: 'XYZ Ltd' },
            { name: 'E-commerce Platform', client_name: 'RetailCo' },
        ];

        const projectIds = [];
        for (const project of projects) {
            const result = await pool.query(
                'INSERT INTO projects (name, client_name) VALUES ($1, $2) RETURNING id',
                [project.name, project.client_name]
            );
            projectIds.push(result.rows[0].id);
            console.log(`Created project: ${project.name}`);
        }

        // Get user IDs
        const usersResult = await pool.query('SELECT id, role FROM users');
        const users = usersResult.rows;
        const dev = users.find(u => u.role === 'DEV');
        const techLead = users.find(u => u.role === 'TECH_LEAD');

        // Create sample tickets for each project
        const ticketTypes = ['FEATURE', 'BUG', 'CHANGE_REQUEST'];
        const ticketStatuses = ['BACKLOG', 'TECH_DESIGN', 'READY_FOR_DEV', 'IN_PROGRESS', 'CODE_REVIEW', 'QA', 'DONE'];

        const ticketTemplates = [
            { title: 'User Authentication', description: 'Implement OAuth 2.0 login', type: 'FEATURE' },
            { title: 'Dashboard Analytics', description: 'Add charts and metrics', type: 'FEATURE' },
            { title: 'Fix Login Bug', description: 'Login fails on mobile', type: 'BUG' },
            { title: 'Update UI Theme', description: 'Refresh color palette', type: 'CHANGE_REQUEST' },
            { title: 'API Integration', description: 'Connect to third-party API', type: 'FEATURE' },
            { title: 'Performance Optimization', description: 'Reduce page load time', type: 'CHANGE_REQUEST' },
        ];

        for (const projectId of projectIds) {
            // Create 3-4 tickets per project
            const numTickets = Math.floor(Math.random() * 2) + 3;
            for (let i = 0; i < numTickets; i++) {
                const template = ticketTemplates[Math.floor(Math.random() * ticketTemplates.length)];
                const status = ticketStatuses[Math.floor(Math.random() * ticketStatuses.length)];
                const assignedTo = Math.random() > 0.3 ? (Math.random() > 0.5 ? dev.id : techLead.id) : null;

                await pool.query(
                    `INSERT INTO tickets (title, description, type, status, project_id, assigned_to_user_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
                    [template.title, template.description, template.type, status, projectId, assignedTo]
                );
            }
        }

        console.log('✅ Demo data seeded successfully!');
        console.log(`Created ${projectIds.length} projects`);
        console.log(`Created multiple tickets across all projects`);

        process.exit(0);
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
}

seedData();
