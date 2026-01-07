const Label = require('../models/labelModel');

exports.createLabel = async (req, res) => {
    try {
        const label = await Label.create(req.body);
        res.status(201).json(label);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create label' });
    }
};

exports.getProjectLabels = async (req, res) => {
    try {
        const labels = await Label.getByProject(req.params.projectId);
        res.json(labels);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch labels' });
    }
};

exports.addLabelToTicket = async (req, res) => {
    try {
        const result = await Label.addToTicket(req.params.ticketId, req.body.label_id);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add label to ticket' });
    }
};

exports.removeLabelFromTicket = async (req, res) => {
    try {
        const result = await Label.removeFromTicket(req.params.ticketId, req.params.labelId);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to remove label from ticket' });
    }
};

exports.getTicketLabels = async (req, res) => {
    try {
        const labels = await Label.getByTicket(req.params.ticketId);
        res.json(labels);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch ticket labels' });
    }
};

exports.deleteLabel = async (req, res) => {
    try {
        const label = await Label.delete(req.params.id);
        res.json(label);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete label' });
    }
};
