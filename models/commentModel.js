const db = require('../db');

class Comment {
    /**
     * @param {object} data
     * @param {boolean} [data.is_internal=true] - internal notes are the default.
     *   Making a comment customer-visible must be a deliberate act: it is what
     *   stamps first_response_at and what a customer would eventually read.
     * @param {object} [client=db] - pass a pg client to run inside a transaction
     */
    static async create({ ticket_id, support_ticket_id, user_id, content, is_internal = true }, client = db) {
        const result = await client.query(
            `INSERT INTO comments (ticket_id, support_ticket_id, user_id, content, is_internal)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [ticket_id || null, support_ticket_id || null, user_id, content, is_internal !== false]
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
