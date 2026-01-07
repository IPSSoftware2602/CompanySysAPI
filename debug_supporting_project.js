const db = require('./db');
const SupportingProject = require('./models/supportingProjectModel');

async function debug() {
    try {
        console.log('Testing SupportingProject.create...');
        const newProject = await SupportingProject.create({
            name: 'Debug Project',
            description: 'Created by debug script'
        });
        console.log('Successfully created:', newProject);

        console.log('Testing SupportingProject.getAll...');
        const all = await SupportingProject.getAll();
        console.log('Found projects:', all.length);

    } catch (err) {
        console.error('Debug failed:', err);
    } finally {
        process.exit();
    }
}

debug();
