const Project = require('../models/projectModel');
const List = require('../models/listModel');

exports.createProject = async (req, res) => {
    try {
        const project = await Project.create(req.body);
        // Create default lists
        const defaultLists = [
            { name: 'Backlog', status: 'BACKLOG' },
            { name: 'Tech Design', status: 'TECH_DESIGN' },
            { name: 'Ready for Dev', status: 'READY_FOR_DEV' },
            { name: 'In Progress', status: 'IN_PROGRESS' },
            { name: 'Code Review', status: 'CODE_REVIEW' },
            { name: 'QA Testing', status: 'QA' },
            { name: 'Ready to Deploy', status: 'READY_TO_DEPLOY' },
            { name: 'Done', status: 'DONE' }
        ];

        for (let i = 0; i < defaultLists.length; i++) {
            await List.create({
                project_id: project.id,
                name: defaultLists[i].name,
                position: i,
                mapped_status: defaultLists[i].status
            });
        }

        res.status(201).json(project);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create project' });
    }
};

exports.getAllProjects = async (req, res) => {
    try {
        const projects = await Project.getWithStats();
        res.json(projects);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
};

exports.updateProject = async (req, res) => {
    try {
        const project = await Project.update(req.params.id, req.body);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json(project);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update project' });
    }
};

exports.deleteProject = async (req, res) => {
    try {
        await Project.delete(req.params.id);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete project' });
    }
};
