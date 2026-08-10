const db = require('../db');

/**
 * Fetches a user's active work from both the kanban (tickets) and support
 * (support_tickets) tables and returns it as one normalized list. Terminal
 * items (DONE / COMPLETED / CLOSED) and soft-deleted rows are excluded.
 */
class MyWork {
    static async getForUser(userId) {
        // Kanban tickets: assigned via the members junction OR the legacy
        // assigned_to_user_id column. DISTINCT because a user could be both.
        const kanbanRes = await db.query(
            `SELECT DISTINCT
                    t.id,
                    'KANBAN'::text        AS work_type,
                    t.title,
                    t.status::text        AS status,
                    NULL::text            AS priority,
                    t.end_date            AS due_date,
                    t.is_blocked,
                    t.blocked_reason,
                    t.project_id,
                    p.name                AS project_name,
                    -- companies is authoritative; projects.client_name is the
                    -- legacy free-text column, kept as fallback until it is
                    -- dropped. Field name unchanged so callers need no edit.
                    COALESCE(co.name, p.client_name) AS client_name,
                    t.updated_at
             FROM tickets t
             LEFT JOIN ticket_assignments ta ON ta.ticket_id = t.id
             LEFT JOIN projects p ON t.project_id = p.id
             LEFT JOIN companies co ON p.company_id = co.id
             WHERE t.deleted_at IS NULL
               AND t.status <> 'DONE'
               -- owner_user_id is intentionally NOT referenced here. Every owner
               -- is also a row in ticket_assignments (guaranteed by the migration
               -- and maintained by Ticket.create/update), so this filter already
               -- covers them — and keeping post-migration columns out of the main
               -- query means My Work still works on an un-migrated database.
               AND (ta.user_id = $1 OR t.assigned_to_user_id = $1)`,
            [userId]
        );

        // Support tickets: assigned as dev or PM.
        const supportRes = await db.query(
            `SELECT
                    st.id,
                    'SUPPORT'::text       AS work_type,
                    st.title,
                    st.status::text       AS status,
                    st.priority::text     AS priority,
                    st.sla_due_at         AS due_date,
                    -- On support work the assigned dev is the accountable owner;
                    -- the PM appears as a collaborator.
                    (st.assigned_dev_id = $1) AS is_owner,
                    st.is_blocked,
                    st.blocked_reason,
                    st.supporting_project_id AS project_id,
                    COALESCE(p.name, sp.name) AS project_name,
                    -- Support tickets carry their own company_id (set at
                    -- creation), so prefer it over the project's.
                    COALESCE(stco.name, co.name, p.client_name) AS client_name,
                    st.updated_at,
                    st.ticket_key,
                    st.linked_ticket_id
             FROM support_tickets st
             LEFT JOIN projects p ON st.project_id = p.id
             LEFT JOIN companies co ON p.company_id = co.id
             LEFT JOIN companies stco ON st.company_id = stco.id
             LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
             WHERE st.deleted_at IS NULL
               AND st.status NOT IN ('COMPLETED', 'CLOSED')
               AND (st.assigned_dev_id = $1 OR st.assigned_pm_id = $1)`,
            [userId]
        );

        return [...kanbanRes.rows, ...supportRes.rows];
    }

    /**
     * Which of these kanban tickets the user owns, as opposed to collaborates on.
     *
     * Separate + fail-soft for the same reason as getSlaContext: owner_user_id
     * only exists after migrate_tier1_ownership, and My Work must not depend on
     * migration order to return a result.
     *
     * @param {string[]} ticketIds
     * @param {string} userId
     * @returns {Promise<Set<string>>} ids the user owns
     */
    static async getOwnedTicketIds(ticketIds, userId) {
        if (!ticketIds.length) return new Set();
        const { rows } = await db.query(
            'SELECT id FROM tickets WHERE id = ANY($1::uuid[]) AND owner_user_id = $2',
            [ticketIds, userId]
        );
        return new Set(rows.map((r) => r.id));
    }

    /**
     * SLA-bearing columns for a set of support tickets, plus any open pause.
     *
     * Deliberately a SEPARATE query rather than extra columns on the support
     * SELECT above: these columns only exist after migrate_sla_v2, so keeping
     * them out of the main query means an un-migrated database still gets a
     * working My Work, just without the SLA signal. The caller treats a throw
     * here as "no SLA data available".
     *
     * @param {string[]} supportTicketIds
     * @returns {Promise<Map<string, object>>} ticket id -> row
     */
    static async getSlaContext(supportTicketIds) {
        if (!supportTicketIds.length) return new Map();

        const { rows } = await db.query(
            `SELECT st.id,
                    st.priority,
                    st.status,
                    st.start_date,
                    st.created_at,
                    st.actual_end_date,
                    st.closed_at,
                    st.first_response_at,
                    st.first_response_due_at,
                    st.resolution_due_at,
                    st.sla_paused_total_minutes,
                    p.paused_at AS open_paused_at
             FROM support_tickets st
             LEFT JOIN LATERAL (
                 SELECT paused_at FROM sla_pauses
                 WHERE support_ticket_id = st.id AND resumed_at IS NULL
                 ORDER BY paused_at DESC LIMIT 1
             ) p ON TRUE
             WHERE st.id = ANY($1::uuid[])`,
            [supportTicketIds]
        );
        return new Map(rows.map((r) => [r.id, r]));
    }
}

module.exports = MyWork;
