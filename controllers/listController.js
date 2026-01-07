const List = require('../models/listModel');

exports.createList = async (req, res) => {
    try {
        const list = await List.create(req.body);
        res.status(201).json(list);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create list' });
    }
};

exports.getProjectLists = async (req, res) => {
    try {
        const lists = await List.getByProject(req.params.projectId);
        res.json(lists);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch lists' });
    }
};

exports.updateList = async (req, res) => {
    try {
        const list = await List.update(req.params.id, req.body);
        res.json(list);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update list' });
    }
};

exports.deleteList = async (req, res) => {
    try {
        await List.delete(req.params.id);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete list' });
    }
};

exports.reorderLists = async (req, res) => {
    try {
        await List.reorder(req.params.projectId, req.body.listIds);
        res.status(200).json({ message: 'Lists reordered' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reorder lists' });
    }
};
