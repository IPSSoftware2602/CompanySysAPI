const db = require('../db');

class Ticket {
    static async create({ project_id, title, description, type, assigned_to_user_id, owner_user_id, list_id, cover_color, cover_image_url, start_date, end_date }) {
        // Accept either name during the transition; owner_user_id wins.
        const owner = owner_user_id !== undefined ? owner_user_id : assigned_to_user_id;
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(
                `INSERT INTO tickets (project_id, title, description, type, assigned_to_user_id, owner_user_id, list_id, cover_color, cover_image_url, start_date, end_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [project_id, title, description, type, owner, owner, list_id, cover_color, cover_image_url, start_date, end_date]
            );
            const ticket = result.rows[0];

            // The owner is always also a collaborator, so ticket_assignments
            // stays the complete answer to "who is on this ticket".
            if (owner) {
                await client.query(
                    'INSERT INTO ticket_assignments (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [ticket.id, owner]
                );
            }
            await client.query('COMMIT');
            return ticket;
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
            throw err;
        } finally {
            client.release();
        }
    }

    static async updateStatus(id, status) {
        const result = await db.query(
            'UPDATE tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [status, id]
        );
        return result.rows[0];
    }

    static async getById(id) {
        const result = await db.query('SELECT * FROM tickets WHERE id = $1 AND deleted_at IS NULL', [id]);
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
        const result = await db.query(`
            SELECT t.*, 
                   COALESCE(
                       (SELECT json_agg(l.*) 
                        FROM ticket_labels tl 
                        JOIN labels l ON tl.label_id = l.id 
                        WHERE tl.ticket_id = t.id), 
                       '[]'::json
                   ) as labels,
                   COALESCE(
                       (SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name))
                        FROM ticket_assignments ta
                        JOIN users u ON ta.user_id = u.id
                        WHERE ta.ticket_id = t.id),
                        '[]'::json
                   ) as members
            FROM tickets t
            WHERE t.project_id = $1 AND t.deleted_at IS NULL
            ORDER BY t.list_id, t.position ASC, t.created_at DESC
        `, [projectId]);
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
        // The single accountable owner. Kept in sync with the legacy
        // assigned_to_user_id column below until that column is retired.
        if (data.owner_user_id !== undefined) {
            fields.push(`owner_user_id = $${index++}`);
            values.push(data.owner_user_id);
            fields.push(`assigned_to_user_id = $${index++}`);
            values.push(data.owner_user_id);
        }
        // Completion evidence. Recorded, never gated — see migrate_tier1_ownership.js.
        if (data.completion_explanation !== undefined) {
            fields.push(`completion_explanation = $${index++}`);
            values.push(data.completion_explanation);
        }
        if (data.pull_request_url !== undefined) {
            fields.push(`pull_request_url = $${index++}`);
            values.push(data.pull_request_url);
        }
        if (data.test_evidence !== undefined) {
            fields.push(`test_evidence = $${index++}`);
            values.push(data.test_evidence);
        }

        fields.push(`updated_at = NOW()`);
        values.push(id);

        const result = await db.query(
            `UPDATE tickets SET ${fields.join(', ')} WHERE id = $${index} RETURNING *`,
            values
        );
        const updated = result.rows[0];

        // Same invariant as create(): a newly-appointed owner joins the
        // collaborator list. The previous owner is left in place — handing over
        // accountability rarely means the old owner stops being involved.
        if (updated && data.owner_user_id) {
            await db.query(
                'INSERT INTO ticket_assignments (ticket_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [updated.id, data.owner_user_id]
            );
        }
        return updated;
    }

    static async setBlocked(id, { reason, userId }) {
        const result = await db.query(
            `UPDATE tickets
             SET is_blocked = TRUE, blocked_reason = $1, blocked_at = NOW(),
                 blocked_by_user_id = $2, updated_at = NOW()
             WHERE id = $3 AND deleted_at IS NULL RETURNING *`,
            [reason, userId, id]
        );
        return result.rows[0];
    }

    static async clearBlocked(id) {
        const result = await db.query(
            `UPDATE tickets
             SET is_blocked = FALSE, blocked_reason = NULL, blocked_at = NULL,
                 blocked_by_user_id = NULL, updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    }

    static async softDelete(id) {
        const result = await db.query(
            `UPDATE tickets SET deleted_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    }

    // Clears deleted_at. Matches only rows that are currently deleted, so
    // restoring a live ticket is a no-op rather than a silent success.
    static async restore(id) {
        const result = await db.query(
            `UPDATE tickets SET deleted_at = NULL, updated_at = NOW()
             WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    }

    // Fetch regardless of soft-delete state — used to distinguish
    // "not found" from "already restored".
    static async getByIdIncludingDeleted(id) {
        const result = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
        return result.rows[0];
    }
}

module.exports = Ticket;
