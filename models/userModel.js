const db = require('../db');

class User {
    static async findByEmail(email) {
        const result = await db.query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
        return result.rows[0];
    }

    static async create({ email, password_hash, role, full_name }) {
        const result = await db.query(
            'INSERT INTO users (email, password_hash, role, full_name) VALUES ($1, $2, $3, $4) RETURNING *',
            [email, password_hash, role, full_name]
        );
        return result.rows[0];
    }

    static async getAll() {
        const result = await db.query('SELECT id, email, role, full_name FROM users WHERE deleted_at IS NULL ORDER BY full_name ASC');
        return result.rows;
    }

    static async update(id, { email, role, full_name, password_hash }) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (email) { fields.push(`email = $${idx++}`); values.push(email); }
        if (role) { fields.push(`role = $${idx++}`); values.push(role); }
        if (full_name) { fields.push(`full_name = $${idx++}`); values.push(full_name); }
        if (password_hash) { fields.push(`password_hash = $${idx++}`); values.push(password_hash); }

        if (fields.length === 0) return null;

        values.push(id);
        const result = await db.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, email, role, full_name`,
            values
        );
        return result.rows[0];
    }

    static async delete(id) {
        await db.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [id]);
    }
}

module.exports = User;
