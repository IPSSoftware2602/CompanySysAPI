const db = require('../db');

/**
 * A flat, free-form checklist on a support ticket.
 *
 * Deliberately NOT the kanban `ticket_checklists` structure: that one has named
 * groups, assigned members, start/end times and a completion gate, which is
 * more machinery than "list what needs doing on this ticket and tick it off".
 * Sharing it would have meant carrying all of that into a place nobody asked
 * for it.
 *
 * Nothing here gates a status change — an unticked item costs nothing but
 * visibility, which is the whole point.
 */
class SupportChecklist {
    static async listByTicket(supportTicketId) {
        const { rows } = await db.query(
            `SELECT i.*, done.full_name AS done_by_name, creator.full_name AS created_by_name
             FROM support_ticket_checklist_items i
             LEFT JOIN users done ON i.done_by_user_id = done.id
             LEFT JOIN users creator ON i.created_by_user_id = creator.id
             WHERE i.support_ticket_id = $1
             ORDER BY i.position ASC, i.created_at ASC`,
            [supportTicketId]
        );
        return rows;
    }

    /** One item, scoped by ticket — the "before" half of a change log entry. */
    static async getItem(id, supportTicketId) {
        const { rows } = await db.query(
            `SELECT * FROM support_ticket_checklist_items WHERE id = $1 AND support_ticket_id = $2`,
            [id, supportTicketId]
        );
        return rows[0] || null;
    }

    /** Appends to the end of the list; position is never supplied by the client. */
    static async addItem(supportTicketId, { content, created_by_user_id }) {
        const { rows } = await db.query(
            `INSERT INTO support_ticket_checklist_items
                 (support_ticket_id, content, position, created_by_user_id)
             VALUES (
                 $1, $2,
                 COALESCE((SELECT max(position) + 1 FROM support_ticket_checklist_items
                            WHERE support_ticket_id = $1), 0),
                 $3
             )
             RETURNING *`,
            [supportTicketId, content, created_by_user_id || null]
        );
        return rows[0];
    }

    /**
     * Ticking an item stamps who did it and when; unticking clears both, so a
     * stale name never sits next to an unchecked box.
     */
    static async updateItem(id, supportTicketId, { content, is_done, position }, userId) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (content !== undefined) { fields.push(`content = $${idx++}`); values.push(content); }
        if (position !== undefined) { fields.push(`position = $${idx++}`); values.push(position); }
        if (is_done !== undefined) {
            fields.push(`is_done = $${idx++}`); values.push(Boolean(is_done));
            if (is_done) {
                fields.push(`done_at = CURRENT_TIMESTAMP`);
                fields.push(`done_by_user_id = $${idx++}`); values.push(userId || null);
            } else {
                fields.push(`done_at = NULL`);
                fields.push(`done_by_user_id = NULL`);
            }
        }
        if (!fields.length) return null;

        values.push(id, supportTicketId);
        const { rows } = await db.query(
            `UPDATE support_ticket_checklist_items
             SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${idx++} AND support_ticket_id = $${idx}
             RETURNING *`,
            values
        );
        return rows[0] || null;
    }

    /** Scoped by ticket as well as id, so a wrong ticket id cannot delete another's item. */
    static async deleteItem(id, supportTicketId) {
        const { rows } = await db.query(
            `DELETE FROM support_ticket_checklist_items
             WHERE id = $1 AND support_ticket_id = $2 RETURNING *`,
            [id, supportTicketId]
        );
        return rows[0] || null;
    }

    /** Progress counts for a set of tickets, for the board cards. */
    static async progressFor(ticketIds) {
        if (!ticketIds.length) return new Map();
        const { rows } = await db.query(
            `SELECT support_ticket_id,
                    count(*)::int AS total,
                    count(*) FILTER (WHERE is_done)::int AS done
             FROM support_ticket_checklist_items
             WHERE support_ticket_id = ANY($1::uuid[])
             GROUP BY support_ticket_id`,
            [ticketIds]
        );
        return new Map(rows.map((r) => [r.support_ticket_id, { total: r.total, done: r.done }]));
    }
}

module.exports = SupportChecklist;
