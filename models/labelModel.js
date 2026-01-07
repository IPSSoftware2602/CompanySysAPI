const db = require('../db');

class Label {
    static async create({ name, color, project_id }) {
        const result = await db.query(
            `INSERT INTO labels (name, color, project_id) 
       VALUES ($1, $2, $3) RETURNING *`,
            [name, color, project_id]
        );
        return result.rows[0];
    }

    static async getByProject(projectId) {
        const result = await db.query(
            'SELECT * FROM labels WHERE project_id = $1 ORDER BY name',
            [projectId]
        );
        return result.rows;
    }

    static async addToTicket(ticketId, labelId) {
        const result = await db.query(
            'INSERT INTO ticket_labels (ticket_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *',
            [ticketId, labelId]
        );
        return result.rows[0];
    }

    static async removeFromTicket(ticketId, labelId) {
        const result = await db.query(
            'DELETE FROM ticket_labels WHERE ticket_id = $1 AND label_id = $2 RETURNING *',
            [ticketId, labelId]
        );
        return result.rows[0];
    }

    static async getByTicket(ticketId) {
        const result = await db.query(
            `SELECT l.* FROM labels l
       JOIN ticket_labels tl ON l.id = tl.label_id
       WHERE tl.ticket_id = $1`,
            [ticketId]
        );
        return result.rows;
    }

    static async delete(id) {
        const result = await db.query('DELETE FROM labels WHERE id = $1 RETURNING *', [id]);
        return result.rows[0];
    }
}

module.exports = Label;
