const db = require('../db');

class Comment {
    static async create({ ticket_id, support_ticket_id, user_id, content }) {
        const result = await db.query(
            `INSERT INTO comments (ticket_id, support_ticket_id, user_id, content) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
            [ticket_id || null, support_ticket_id || null, user_id, content]
        );
        return result.rows[0];
    }

    static async getByTicket(ticketId) {
        const result = await db.query(
            `SELECT c.*, u.full_name, u.email 
       FROM comments c 
       JOIN users u ON c.user_id = u.id 
       WHERE c.ticket_id = $1 
       ORDER BY c.created_at ASC`,
            [ticketId]
        );
        return result.rows;
    }

    static async getBySupportTicket(supportTicketId) {
        const result = await db.query(
            `SELECT c.*, u.full_name, u.email 
       FROM comments c 
       JOIN users u ON c.user_id = u.id 
       WHERE c.support_ticket_id = $1 
       ORDER BY c.created_at ASC`,
            [supportTicketId]
        );
        return result.rows;
    }

    static async getById(id) {
        const result = await db.query('SELECT * FROM comments WHERE id = $1', [id]);
        return result.rows[0];
    }

    static async update(id, content) {
        const result = await db.query(
            'UPDATE comments SET content = $1 WHERE id = $2 RETURNING *',
            [content, id]
        );
        return result.rows[0];
    }

    static async delete(id) {
        const result = await db.query('DELETE FROM comments WHERE id = $1 RETURNING *', [id]);
        return result.rows[0];
    }
}

module.exports = Comment;
