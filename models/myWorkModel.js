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
                    p.client_name,
                    t.updated_at
             FROM tickets t
             LEFT JOIN ticket_assignments ta ON ta.ticket_id = t.id
             LEFT JOIN projects p ON t.project_id = p.id
             WHERE t.deleted_at IS NULL
               AND t.status <> 'DONE'
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
                    st.is_blocked,
                    st.blocked_reason,
                    st.supporting_project_id AS project_id,
                    COALESCE(p.name, sp.name) AS project_name,
                    p.client_name,
                    st.updated_at,
                    st.ticket_key,
                    st.linked_ticket_id
             FROM support_tickets st
             LEFT JOIN projects p ON st.project_id = p.id
             LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
             WHERE st.deleted_at IS NULL
               AND st.status NOT IN ('COMPLETED', 'CLOSED')
               AND (st.assigned_dev_id = $1 OR st.assigned_pm_id = $1)`,
            [userId]
        );

        return [...kanbanRes.rows, ...supportRes.rows];
    }
}

module.exports = MyWork;
