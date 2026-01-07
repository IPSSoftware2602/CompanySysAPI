const SupportingProject = require('../models/supportingProjectModel');

exports.createProject = async (req, res) => {
    try {
        const project = await SupportingProject.create(req.body);
        res.status(201).json(project);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create supporting project' });
    }
};

exports.getAllProjects = async (req, res) => {
    try {
        const projects = await SupportingProject.getAll();
        res.json(projects);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch supporting projects' });
    }
};

exports.getProjectById = async (req, res) => {
    try {
        const project = await SupportingProject.getById(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json(project);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch project' });
    }
};

exports.updateProject = async (req, res) => {
    try {
        const project = await SupportingProject.update(req.params.id, req.body);
        res.json(project);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update project' });
    }
};

exports.deleteProject = async (req, res) => {
    try {
        await SupportingProject.delete(req.params.id);
        res.json({ message: 'Project deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete project' });
    }
};
