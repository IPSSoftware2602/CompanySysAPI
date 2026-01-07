const db = require('../db');

class ChecklistTemplate {
    static async getByRequiredStatus(status) {
        const result = await db.query('SELECT * FROM checklist_templates WHERE required_for_status = $1', [status]);
        return result.rows;
    }
}

module.exports = ChecklistTemplate;
