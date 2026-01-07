const db = require('../db');

class SupportingProject {
    static async create({ name, description }) {
        const result = await db.query(
            'INSERT INTO supporting_projects (name, description) VALUES ($1, $2) RETURNING *',
            [name, description]
        );
        return result.rows[0];
    }

    static async getAll() {
        const result = await db.query('SELECT * FROM supporting_projects ORDER BY created_at DESC');
        return result.rows;
    }

    static async getById(id) {
        const result = await db.query('SELECT * FROM supporting_projects WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async update(id, { name, description }) {
        const result = await db.query(
            'UPDATE supporting_projects SET name = $1, description = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
            [name, description, id]
        );
        return result.rows[0];
    }

    static async delete(id) {
        const result = await db.query('DELETE FROM supporting_projects WHERE id = $1 RETURNING *', [id]);
        return result.rows[0];
    }
}

module.exports = SupportingProject;
