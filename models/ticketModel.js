const db = require('../db');

class Ticket {
    static async create({ project_id, title, description, type, assigned_to_user_id, list_id, cover_color, cover_image_url, start_date, end_date }) {
        const result = await db.query(
            `INSERT INTO tickets (project_id, title, description, type, assigned_to_user_id, list_id, cover_color, cover_image_url, start_date, end_date) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [project_id, title, description, type, assigned_to_user_id, list_id, cover_color, cover_image_url, start_date, end_date]
        );
        return result.rows[0];
    }

    static async updateStatus(id, status) {
        const result = await db.query(
            'UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [status, id]
        );
        return result.rows[0];
    }

    static async getById(id) {
        const result = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
        const ticket = result.rows[0];
        if (!ticket) return null;

        // Fetch members
        const membersRes = await db.query(`
            SELECT u.id, u.full_name, u.email 
            FROM users u
            JOIN ticket_assignments ta ON u.id = ta.user_id
            WHERE ta.ticket_id = $1
        `, [id]);
        ticket.members = membersRes.rows;

        return ticket;
    }

    static async getByProject(projectId) {
        const result = await db.query('SELECT * FROM tickets WHERE project_id = $1 ORDER BY list_id, position ASC, created_at DESC', [projectId]);
        return result.rows;
    }

    static async reorder(ticketIds) {
        // ticketIds is an array of IDs in the desired order
        // We assume they are all in the same list or handled by the caller
        // But actually, for safety, we should just update their positions based on the array index.
        // This method assumes the frontend sends the full list of IDs for a column.

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            for (let i = 0; i < ticketIds.length; i++) {
                await client.query('UPDATE tickets SET position = $1 WHERE id = $2', [i, ticketIds[i]]);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    static async addMember(ticketId, userId) {
        await db.query(
            'INSERT INTO ticket_assignments (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [ticketId, userId]
        );
    }

    static async removeMember(ticketId, userId) {
        await db.query(
            'DELETE FROM ticket_assignments WHERE ticket_id = $1 AND user_id = $2',
            [ticketId, userId]
        );
    }

    static async update(id, data) {
        const fields = [];
        const values = [];
        let index = 1;

        if (data.title !== undefined) {
            fields.push(`title = $${index++}`);
            values.push(data.title);
        }
        if (data.description !== undefined) {
            fields.push(`description = $${index++}`);
            values.push(data.description);
        }
        if (data.start_date !== undefined) {
            fields.push(`start_date = $${index++}`);
            values.push(data.start_date);
        }
        if (data.end_date !== undefined) {
            fields.push(`end_date = $${index++}`);
            values.push(data.end_date);
        }
        if (data.attachments !== undefined) {
            fields.push(`attachments = $${index++}`);
            values.push(JSON.stringify(data.attachments));
        }
        if (data.assigned_to_user_id !== undefined) {
            fields.push(`assigned_to_user_id = $${index++}`);
            values.push(data.assigned_to_user_id);
        }
        if (data.list_id !== undefined) {
            fields.push(`list_id = $${index++}`);
            values.push(data.list_id);
        }
        if (data.status !== undefined) {
            fields.push(`status = $${index++}`);
            values.push(data.status);
        }
        if (data.cover_color !== undefined) {
            fields.push(`cover_color = $${index++}`);
            values.push(data.cover_color);
        }
        if (data.cover_image_url !== undefined) {
            fields.push(`cover_image_url = $${index++}`);
            values.push(data.cover_image_url);
        }
        if (data.position !== undefined) {
            fields.push(`position = $${index++}`);
            values.push(data.position);
        }

        fields.push(`updated_at = NOW()`);
        values.push(id);

        const result = await db.query(
            `UPDATE tickets SET ${fields.join(', ')} WHERE id = $${index} RETURNING *`,
            values
        );
        return result.rows[0];
    }
}

module.exports = Ticket;
