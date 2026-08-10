const db = require('../db');

/**
 * Reaching a client differs by work type:
 *   kanban  ticket -> projects            -> client_name
 *   support ticket -> supporting_projects -> projects -> client_name
 * Both legs are LEFT JOINed so an unlinked supporting_project yields a row with
 * a null client rather than vanishing from the report — silently dropping
 * billable time is far worse than showing it as unattributed.
 */
const WORK_CONTEXT_SQL = `
    LEFT JOIN tickets t              ON wtl.ticket_id = t.id
    LEFT JOIN support_tickets st     ON wtl.support_ticket_id = st.id
    LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
    LEFT JOIN projects p             ON p.id = COALESCE(t.project_id, st.project_id, sp.project_id)
    LEFT JOIN companies co           ON co.id = COALESCE(st.company_id, p.company_id)
`;

const SELECT_FIELDS = `
    wtl.*,
    COALESCE(t.title, st.title)        AS work_title,
    CASE WHEN wtl.ticket_id IS NOT NULL THEN 'KANBAN' ELSE 'SUPPORT' END AS work_type,
    st.ticket_key,
    p.id                               AS project_id,
    p.name                             AS project_name,
    COALESCE(co.name, p.client_name)   AS client_name,
    u.full_name                        AS user_name
`;

class WorkTimeLog {
    static async create(data, client = db) {
        const {
            ticket_id, support_ticket_id, user_id, minutes,
            logged_for_date, is_billable, note, corrects_entry_id,
        } = data;

        const { rows } = await client.query(
            `INSERT INTO work_time_logs
                (ticket_id, support_ticket_id, user_id, minutes,
                 logged_for_date, is_billable, note, corrects_entry_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
                ticket_id || null, support_ticket_id || null, user_id, minutes,
                logged_for_date, is_billable !== false, note || null,
                corrects_entry_id || null,
            ]
        );
        return rows[0];
    }

    static async getById(id, client = db) {
        const { rows } = await client.query(
            `SELECT ${SELECT_FIELDS}
             FROM work_time_logs wtl
             ${WORK_CONTEXT_SQL}
             LEFT JOIN users u ON wtl.user_id = u.id
             WHERE wtl.id = $1 AND wtl.deleted_at IS NULL`,
            [id]
        );
        return rows[0];
    }

    /**
     * Only an entry's own values are updatable, and only while it is editable —
     * status, approval and lock fields move through their own methods so a
     * caller cannot approve their own time by passing status in a PATCH body.
     */
    static async update(id, updates, client = db) {
        const allowed = ['minutes', 'logged_for_date', 'is_billable', 'note'];
        const fields = [];
        const values = [];
        let idx = 1;

        for (const key of Object.keys(updates)) {
            if (allowed.includes(key)) {
                fields.push(`${key} = $${idx++}`);
                values.push(updates[key]);
            }
        }
        if (!fields.length) return this.getById(id, client);

        values.push(id);
        const { rows } = await client.query(
            `UPDATE work_time_logs SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${idx} AND deleted_at IS NULL RETURNING *`,
            values
        );
        return rows[0];
    }

    static async setStatus(id, status, { userId, at = new Date() } = {}, client = db) {
        const extra = [];
        const values = [status];
        let idx = 2;

        if (status === 'APPROVED') {
            extra.push(`approved_by = $${idx++}`, `approved_at = $${idx++}`);
            values.push(userId, at);
        }
        if (status === 'LOCKED') {
            extra.push(`locked_at = $${idx++}`);
            values.push(at);
        }
        if (status === 'DRAFT') {
            // Sending an entry back clears its approval, otherwise a rejected
            // entry keeps a stale approver.
            extra.push('approved_by = NULL', 'approved_at = NULL');
        }

        values.push(id);
        const { rows } = await client.query(
            `UPDATE work_time_logs
             SET status = $1${extra.length ? ', ' + extra.join(', ') : ''},
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $${idx} AND deleted_at IS NULL RETURNING *`,
            values
        );
        return rows[0];
    }

    static async softDelete(id, client = db) {
        const { rows } = await client.query(
            `UPDATE work_time_logs SET deleted_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id]
        );
        return rows[0];
    }

    /**
     * Filtered list. All filters optional and ANDed together.
     * @param {object} f - {userId, projectId, clientName, from, to, status, billableOnly, ticketId, supportTicketId}
     */
    static async list(f = {}, client = db) {
        const where = ['wtl.deleted_at IS NULL'];
        const values = [];
        let idx = 1;

        if (f.userId) { where.push(`wtl.user_id = $${idx++}`); values.push(f.userId); }
        if (f.projectId) { where.push(`p.id = $${idx++}`); values.push(f.projectId); }
        if (f.clientName) { where.push(`COALESCE(co.name, p.client_name) = $${idx++}`); values.push(f.clientName); }
        if (f.from) { where.push(`wtl.logged_for_date >= $${idx++}`); values.push(f.from); }
        if (f.to) { where.push(`wtl.logged_for_date <= $${idx++}`); values.push(f.to); }
        if (f.status) { where.push(`wtl.status = $${idx++}`); values.push(f.status); }
        if (f.ticketId) { where.push(`wtl.ticket_id = $${idx++}`); values.push(f.ticketId); }
        if (f.supportTicketId) { where.push(`wtl.support_ticket_id = $${idx++}`); values.push(f.supportTicketId); }
        if (f.billableOnly) where.push('wtl.is_billable IS TRUE');

        const { rows } = await client.query(
            `SELECT ${SELECT_FIELDS}
             FROM work_time_logs wtl
             ${WORK_CONTEXT_SQL}
             LEFT JOIN users u ON wtl.user_id = u.id
             WHERE ${where.join(' AND ')}
             ORDER BY wtl.logged_for_date DESC, wtl.created_at DESC`,
            values
        );
        return rows;
    }

    /**
     * Raw entries for a reporting period, carrying only what rounding needs
     * plus the grouping keys. Rounding is applied in the service, not in SQL —
     * UP_PER_DAY_15 cannot be expressed as a per-row SUM.
     */
    static async forReport({ from, to, status, billableOnly = true }, client = db) {
        const where = ['wtl.deleted_at IS NULL'];
        const values = [];
        let idx = 1;

        if (from) { where.push(`wtl.logged_for_date >= $${idx++}`); values.push(from); }
        if (to) { where.push(`wtl.logged_for_date <= $${idx++}`); values.push(to); }
        if (status) { where.push(`wtl.status = $${idx++}`); values.push(status); }
        if (billableOnly) where.push('wtl.is_billable IS TRUE');

        const { rows } = await client.query(
            `SELECT wtl.id, wtl.minutes, wtl.user_id, wtl.logged_for_date,
                    wtl.is_billable, wtl.status,
                    u.full_name AS user_name,
                    p.id AS project_id, p.name AS project_name,
                    COALESCE(co.name, p.client_name) AS client_name,
                    CASE WHEN wtl.ticket_id IS NOT NULL THEN 'KANBAN' ELSE 'SUPPORT' END AS work_type
             FROM work_time_logs wtl
             ${WORK_CONTEXT_SQL}
             LEFT JOIN users u ON wtl.user_id = u.id
             WHERE ${where.join(' AND ')}
             ORDER BY wtl.logged_for_date`,
            values
        );
        return rows;
    }

    /** Total exact minutes on one work item — for the ticket detail panel. */
    static async totalForWorkItem({ ticketId, supportTicketId }, client = db) {
        const col = ticketId ? 'ticket_id' : 'support_ticket_id';
        const { rows } = await client.query(
            `SELECT COALESCE(SUM(minutes),0)::int AS minutes, count(*)::int AS entries
             FROM work_time_logs WHERE ${col} = $1 AND deleted_at IS NULL`,
            [ticketId || supportTicketId]
        );
        return rows[0];
    }

    /** Bulk lock a period. Only APPROVED entries lock; drafts are left alone. */
    static async lockPeriod({ from, to }, client = db) {
        const { rows } = await client.query(
            `UPDATE work_time_logs
             SET status = 'LOCKED', locked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE deleted_at IS NULL AND status = 'APPROVED'
               AND logged_for_date >= $1 AND logged_for_date <= $2
             RETURNING id`,
            [from, to]
        );
        return rows.length;
    }

    /** Entries that would block a period lock — still draft or awaiting approval. */
    static async unapprovedInPeriod({ from, to }, client = db) {
        const { rows } = await client.query(
            `SELECT wtl.id, wtl.status, wtl.logged_for_date, wtl.minutes, u.full_name AS user_name
             FROM work_time_logs wtl
             LEFT JOIN users u ON wtl.user_id = u.id
             WHERE wtl.deleted_at IS NULL AND wtl.status IN ('DRAFT','SUBMITTED')
               AND wtl.logged_for_date >= $1 AND wtl.logged_for_date <= $2
             ORDER BY u.full_name, wtl.logged_for_date`,
            [from, to]
        );
        return rows;
    }
}

module.exports = WorkTimeLog;
