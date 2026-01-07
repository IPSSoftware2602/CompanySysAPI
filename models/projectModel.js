const db = require('../db');

class Project {
    static async create({ name, client_name, tech_lead_id, pm_id, status }) {
        const result = await db.query(
            `INSERT INTO projects (name, client_name, tech_lead_id, pm_id, status) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, client_name, tech_lead_id, pm_id, status || 'PENDING']
        );
        return result.rows[0];
    }

    static async getAll() {
        const result = await db.query('SELECT * FROM projects ORDER BY created_at DESC');
        return result.rows;
    }

    static async getWithStats() {
        const result = await db.query(`
            SELECT p.*, 
                   (SELECT json_object_agg(status, count) 
                    FROM (SELECT status, COUNT(*) as count 
                          FROM tickets 
                          WHERE project_id = p.id 
                          GROUP BY status) t
                   ) as ticket_counts
            FROM projects p
            ORDER BY p.created_at DESC
        `);
        return result.rows;
    }

    static async update(id, { name, client_name, tech_lead_id, pm_id, status }) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (name) { fields.push(`name = $${idx++}`); values.push(name); }
        if (client_name) { fields.push(`client_name = $${idx++}`); values.push(client_name); }
        if (tech_lead_id) { fields.push(`tech_lead_id = $${idx++}`); values.push(tech_lead_id); }
        if (pm_id) { fields.push(`pm_id = $${idx++}`); values.push(pm_id); }
        if (status) { fields.push(`status = $${idx++}`); values.push(status); }

        if (fields.length === 0) return null;

        values.push(id);
        const result = await db.query(
            `UPDATE projects SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        return result.rows[0];
    }

    static async delete(id) {
        await db.query('DELETE FROM projects WHERE id = $1', [id]);
    }
}

module.exports = Project;
