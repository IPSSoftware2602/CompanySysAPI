const db = require('../db');

class SupportTicket {
    static async create({
        // Legacy. New callers pass project_id; this stays accepted so existing
        // rows and any un-migrated caller keep working until it is dropped.
        supporting_project_id,
        project_id,
        company_id,
        ticket_key,
        request_type,
        priority,
        risk_level,
        status,
        title,
        description,
        steps_to_reproduce,
        attachments,
        start_date,
        sla_due_at,
        first_response_due_at,
        resolution_due_at,
        created_by_user_id,
        assigned_dev_id,
        // NULL means "follow the project's current tech lead" — see getById.
        tech_lead_id,
        reviewer_user_id
    }, client = db) {
        const result = await client.query(
            `INSERT INTO support_tickets (
                supporting_project_id, project_id, company_id,
                ticket_key, request_type, priority, risk_level, status,
                title, description, steps_to_reproduce, attachments, start_date, sla_due_at,
                first_response_due_at, resolution_due_at,
                created_by_user_id, assigned_dev_id,
                tech_lead_id, reviewer_user_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING *`,
            [
                supporting_project_id, project_id || null, company_id || null,
                ticket_key, request_type, priority, risk_level, status || 'NEW',
                title, description, steps_to_reproduce, JSON.stringify(attachments || []),
                start_date || new Date(), sla_due_at,
                first_response_due_at, resolution_due_at,
                created_by_user_id, assigned_dev_id,
                tech_lead_id || null, reviewer_user_id || null
            ]
        );
        return result.rows[0];
    }

    /**
     * Allocates the next ticket key for a month prefix, atomically.
     *
     * One statement: concurrent callers serialise on the counter row rather
     * than racing a read-then-write. Replaces getLatestKey() + 1, which two
     * simultaneous creates could both resolve to the same number.
     *
     * Pass the transaction's client so the allocation commits or rolls back
     * with the ticket it belongs to — otherwise a failed insert burns a number.
     *
     * @param {string} prefix e.g. "SC-202608"
     * @param {object} [client=db]
     * @returns {Promise<string>} e.g. "SC-202608-0008"
     */
    static async nextTicketKey(prefix, client = db) {
        const { rows } = await client.query(
            `INSERT INTO ticket_sequences (prefix, last_value)
             VALUES ($1, 1)
             ON CONFLICT (prefix) DO UPDATE
                 SET last_value = ticket_sequences.last_value + 1,
                     updated_at = CURRENT_TIMESTAMP
             RETURNING last_value`,
            [prefix]
        );
        return `${prefix}-${String(rows[0].last_value).padStart(4, '0')}`;
    }

    /** @deprecated Racy. Use nextTicketKey(). Retained for the migration only. */
    static async getLatestKey(prefix) {
        const result = await db.query(
            `SELECT ticket_key FROM support_tickets WHERE ticket_key LIKE $1 ORDER BY ticket_key DESC LIMIT 1`,
            [`${prefix}%`]
        );
        return result.rows.length > 0 ? result.rows[0].ticket_key : null;
    }

    static async getById(id) {
        const result = await db.query(
            `SELECT st.*,
                    COALESCE(p.name, sp.name) as project_name,
                    COALESCE(stco.name, co.name, p.client_name) as client_name,
                    c.full_name as created_by_name,
                    dev.full_name as assigned_dev_name,
                    -- Same person, second name: the board query calls this
                    -- assigned_to_name and the card reads that. Without the
                    -- alias, replacing a board row with a getById result drops
                    -- the assignee off the card after every save.
                    dev.full_name as assigned_to_name,
                    -- The tech lead is DISPLAY only: who owns the project, not
                    -- who is doing the work. A NULL override deliberately falls
                    -- through to the project so re-assigning a project's lead
                    -- updates every ticket that never overrode it.
                    COALESCE(st.tech_lead_id, p.tech_lead_id) as effective_tech_lead_id,
                    COALESCE(tlo.full_name, tlp.full_name) as tech_lead_name,
                    rev.full_name as reviewer_name,
                    revby.full_name as reviewed_by_name
             FROM support_tickets st
             LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
             LEFT JOIN projects p ON p.id = COALESCE(st.project_id, sp.project_id)
             LEFT JOIN companies co ON co.id = p.company_id
             LEFT JOIN companies stco ON stco.id = st.company_id
             LEFT JOIN users c ON st.created_by_user_id = c.id
             LEFT JOIN users dev ON st.assigned_dev_id = dev.id
             LEFT JOIN users tlo ON st.tech_lead_id = tlo.id
             LEFT JOIN users tlp ON p.tech_lead_id = tlp.id
             LEFT JOIN users rev ON st.reviewer_user_id = rev.id
             LEFT JOIN users revby ON st.reviewed_by_user_id = revby.id
             WHERE st.id = $1 AND st.deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    }

    /**
     * @param {string} id
     * @param {object} updates - only `allowed` keys are applied
     * @param {object} [client=db] - pass a pg client to run inside a transaction
     *
     * NOTE: first_response_due_at / resolution_due_at / first_response_at /
     * sla_paused_total_minutes are deliberately NOT in `allowed`. They are
     * server-computed and written only by slaService, so a client cannot PATCH
     * itself a more generous deadline.
     */
    static async update(id, updates, client = db) {
        const allowed = [
            'supporting_project_id', 'project_id', 'company_id',
            'request_type', 'priority', 'risk_level', 'status',
            'title', 'description', 'steps_to_reproduce', 'attachments',
            'assigned_dev_id', 'start_date', 'actual_end_date', 'sla_due_at', 'closed_at',
            'linked_ticket_id', 'tech_lead_id', 'reviewer_user_id',
            'reviewed_by_user_id', 'reviewed_at'
        ];

        const fields = [];
        const values = [];
        let idx = 1;

        for (const key of Object.keys(updates)) {
            if (allowed.includes(key)) {
                fields.push(`${key} = $${idx++}`);
                values.push(updates[key]);
            }
        }

        if (fields.length === 0) return null; // No updates

        values.push(id);
        const queryText = `UPDATE support_tickets SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx} RETURNING *`;

        const result = await client.query(queryText, values);
        return result.rows[0];
    }

    static async setBlocked(id, { reason, userId }) {
        const result = await db.query(
            `UPDATE support_tickets
             SET is_blocked = TRUE, blocked_reason = $1, blocked_at = NOW(),
                 blocked_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND deleted_at IS NULL RETURNING *`,
            [reason, userId, id]
        );
        return result.rows[0];
    }

    static async clearBlocked(id) {
        const result = await db.query(
            `UPDATE support_tickets
             SET is_blocked = FALSE, blocked_reason = NULL, blocked_at = NULL,
                 blocked_by_user_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    }

    static async softDelete(id) {
        const result = await db.query(
            `UPDATE support_tickets SET deleted_at = NOW(), updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    }

    static async restore(id) {
        const result = await db.query(
            `UPDATE support_tickets SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    }

    // Fetch regardless of soft-delete state, and report whether the linked dev
    // ticket (if any) still exists — a restored support ticket can point at a
    // ticket that was deleted in the meantime.
    static async getByIdIncludingDeleted(id) {
        const result = await db.query(
            `SELECT st.*,
                    CASE
                        WHEN st.linked_ticket_id IS NULL THEN NULL
                        ELSE (t.id IS NOT NULL AND t.deleted_at IS NULL)
                    END AS linked_ticket_active
             FROM support_tickets st
             LEFT JOIN tickets t ON st.linked_ticket_id = t.id
             WHERE st.id = $1`,
            [id]
        );
        return result.rows[0];
    }

    static async setLinkedTicket(id, ticketId, client = db) {
        const result = await client.query(
            `UPDATE support_tickets SET linked_ticket_id = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
            [ticketId, id]
        );
        return result.rows[0];
    }
}

module.exports = SupportTicket;
