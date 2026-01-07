const Checklist = require('../models/checklistModel');

exports.createChecklist = async (req, res) => {
    try {
        const checklist = await Checklist.create(req.body);
        res.status(201).json(checklist);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create checklist' });
    }
};

exports.getTicketChecklists = async (req, res) => {
    try {
        const checklists = await Checklist.getByTicket(req.params.ticketId);
        res.json(checklists);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch checklists' });
    }
};

exports.deleteChecklist = async (req, res) => {
    try {
        await Checklist.delete(req.params.id);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete checklist' });
    }
};

exports.updateChecklist = async (req, res) => {
    try {
        const checklist = await Checklist.update(req.params.id, req.body);
        res.json(checklist);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update checklist' });
    }
};

exports.addItem = async (req, res) => {
    try {
        const item = await Checklist.addItem(req.body);
        res.status(201).json(item);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add item' });
    }
};

exports.updateItem = async (req, res) => {
    try {
        const item = await Checklist.updateItem(req.params.id, req.body);
        res.json(item);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update item' });
    }
};

exports.deleteItem = async (req, res) => {
    try {
        await Checklist.deleteItem(req.params.id);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete item' });
    }
};

exports.completeChecklist = async (req, res) => {
    try {
        const checklist = await Checklist.completeChecklist(req.params.id);
        res.json(checklist);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to complete checklist' });
    }
};

exports.createFromTemplate = async (req, res) => {
    const { ticketId, templateId } = req.body;
    try {
        const ChecklistTemplate = require('../models/checklistTemplateModel');
        const ChecklistSubmission = require('../models/checklistSubmissionModel');
        const Checklist = require('../models/checklistModel');

        // 1. Fetch template
        const result = await require('../db').query('SELECT * FROM checklist_templates WHERE id = $1', [templateId]);
        const template = result.rows[0];

        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }

        // 2. Create checklist from template
        const checklist = await Checklist.create({
            ticket_id: ticketId,
            name: template.name,
            position: 0,
            items: template.items
        });

        if (!checklist) {
            throw new Error('Checklist creation returned null');
        }

        // 2.1 Add items to the checklist
        const addedItems = [];
        if (template.items && Array.isArray(template.items)) {
            let position = 0;
            for (const item of template.items) {
                const newItem = await Checklist.addItem({
                    checklist_id: checklist.id,
                    content: item.text,
                    position: position++
                });
                addedItems.push(newItem);
            }
        }

        checklist.items = addedItems;

        // 3. Create submission record
        await ChecklistSubmission.create({
            ticket_id: ticketId,
            template_id: templateId,
            submitted_by_user_id: req.user.id,
            completed_items: []
        });

        res.status(201).json(checklist);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create checklist from template', details: err.message });
    }
};
