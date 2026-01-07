const db = require('../db');

class Checklist {
    static async create({ ticket_id, name, position, start_time, end_time }) {
        const result = await db.query(
            'INSERT INTO ticket_checklists (ticket_id, name, position, start_time, end_time) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [ticket_id, name, position, start_time || null, end_time || null]
        );
        return result.rows[0];
    }

    static async getByTicket(ticketId) {
        const checklistsRes = await db.query(
            `SELECT tc.* 
             FROM ticket_checklists tc
             WHERE tc.ticket_id = $1 
             ORDER BY tc.position ASC`,
            [ticketId]
        );
        const checklists = checklistsRes.rows;

        for (const list of checklists) {
            // Fetch items
            const itemsRes = await db.query(
                'SELECT * FROM ticket_checklist_items WHERE checklist_id = $1 ORDER BY position ASC',
                [list.id]
            );
            list.items = itemsRes.rows;

            // Fetch assigned members
            const membersRes = await db.query(
                `SELECT u.id, u.full_name, u.email
                 FROM ticket_checklist_assignments tca
                 JOIN users u ON tca.user_id = u.id
                 WHERE tca.checklist_id = $1`,
                [list.id]
            );
            list.assigned_members = membersRes.rows;
        }

        return checklists;
    }

    static async delete(id) {
        await db.query('DELETE FROM ticket_checklists WHERE id = $1', [id]);
    }

    static async update(id, { name, assigned_member_ids, start_time, end_time }) {
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            const fields = [];
            const values = [];
            let idx = 1;

            if (name !== undefined) {
                fields.push(`name = $${idx++}`);
                values.push(name);
            }
            if (start_time !== undefined) {
                fields.push(`start_time = $${idx++}`);
                values.push(start_time);
            }
            if (end_time !== undefined) {
                fields.push(`end_time = $${idx++}`);
                values.push(end_time);
            }

            if (fields.length > 0) {
                values.push(id);
                await client.query(
                    `UPDATE ticket_checklists SET ${fields.join(', ')} WHERE id = $${idx}`,
                    values
                );
            }

            // Update assignments if provided
            if (assigned_member_ids !== undefined) {
                // Remove existing assignments
                await client.query('DELETE FROM ticket_checklist_assignments WHERE checklist_id = $1', [id]);

                // Add new assignments
                if (Array.isArray(assigned_member_ids) && assigned_member_ids.length > 0) {
                    for (const userId of assigned_member_ids) {
                        await client.query(
                            'INSERT INTO ticket_checklist_assignments (checklist_id, user_id) VALUES ($1, $2)',
                            [id, userId]
                        );
                    }
                }
            }

            await client.query('COMMIT');

            // Return updated checklist
            const result = await client.query('SELECT * FROM ticket_checklists WHERE id = $1', [id]);
            return result.rows[0];
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    static async addItem({ checklist_id, content, position }) {
        const result = await db.query(
            'INSERT INTO ticket_checklist_items (checklist_id, content, position) VALUES ($1, $2, $3) RETURNING *',
            [checklist_id, content, position]
        );
        return result.rows[0];
    }

    static async updateItem(id, { is_completed, content }) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (is_completed !== undefined) {
            fields.push(`is_completed = $${idx++}`);
            values.push(is_completed);
        }
        if (content !== undefined) {
            fields.push(`content = $${idx++}`);
            values.push(content);
        }

        values.push(id);
        const result = await db.query(
            `UPDATE ticket_checklist_items SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        return result.rows[0];
    }

    static async completeChecklist(checklistId) {
        // First, get the checklist items to check their end_time
        const itemsRes = await db.query(
            'SELECT end_time FROM ticket_checklist_items WHERE checklist_id = $1',
            [checklistId]
        );

        const now = new Date();
        let completionStatus = 'on_time';

        // Check if any item has an end_time that's passed
        for (const item of itemsRes.rows) {
            if (item.end_time && new Date(item.end_time) < now) {
                completionStatus = 'delayed';
                break;
            }
        }

        // Mark checklist as completed
        const result = await db.query(
            `UPDATE ticket_checklists 
             SET completed_at = NOW(), completion_status = $1 
             WHERE id = $2 
             RETURNING *`,
            [completionStatus, checklistId]
        );
        return result.rows[0];
    }

    static async deleteItem(id) {
        await db.query('DELETE FROM ticket_checklist_items WHERE id = $1', [id]);
    }
}

module.exports = Checklist;
