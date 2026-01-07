const db = require('../db');

exports.getAllTemplates = async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM checklist_templates');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch checklist templates' });
    }
};
