const db = require('../db');

class List {
    static async create({ project_id, name, position, mapped_status }) {
        const result = await db.query(
            'INSERT INTO lists (project_id, name, position, mapped_status) VALUES ($1, $2, $3, $4) RETURNING *',
            [project_id, name, position, mapped_status]
        );
        return result.rows[0];
    }

    static async getByProject(projectId) {
        const result = await db.query(
            'SELECT * FROM lists WHERE project_id = $1 ORDER BY position ASC',
            [projectId]
        );
        return result.rows;
    }

    static async update(id, { name, position, mapped_status }) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (name !== undefined) {
            fields.push(`name = $${idx++}`);
            values.push(name);
        }
        if (position !== undefined) {
            fields.push(`position = $${idx++}`);
            values.push(position);
        }
        if (mapped_status !== undefined) {
            fields.push(`mapped_status = $${idx++}`);
            values.push(mapped_status);
        }

        if (fields.length === 0) return null;

        values.push(id);
        const result = await db.query(
            `UPDATE lists SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        return result.rows[0];
    }

    static async delete(id) {
        await db.query('DELETE FROM lists WHERE id = $1', [id]);
    }

    static async reorder(projectId, listIds) {
        // listIds is an array of IDs in the desired order
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            for (let i = 0; i < listIds.length; i++) {
                await client.query(
                    'UPDATE lists SET position = $1 WHERE id = $2 AND project_id = $3',
                    [i, listIds[i], projectId]
                );
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }
}

module.exports = List;
