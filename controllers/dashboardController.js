const db = require('../db');
const SlaService = require('../services/slaService');
const TimeLogService = require('../services/timeLogService');
const {
    MANAGER_ROLES,
    TICKET_DONE_STATUSES,
    SUPPORT_DONE_STATUSES,
    TICKET_REVIEW_STATUSES,
} = require('../constants');

/**
 * GET /api/dashboard
 *
 * One page answering the three questions that actually matter day to day:
 *   1. Is delivery on track?      -> overdue, blocked, review queue, unowned
 *   2. Is a customer suffering?   -> SLA risk and breaches, reopened tickets
 *   3. Where did the time go?     -> hours this period by client
 *
 * Deliberately ONE endpoint rather than the five dashboards in the enhancement
 * plan: the "executive", "project manager" and "support manager" here are the
 * same one or two people. Managers only.
 *
 * Every section degrades independently — a section whose migration has not run
 * returns null with a reason rather than failing the whole page.
 */

const isManager = (user) => MANAGER_ROLES.includes(user.role);

/** Runs a section, returning null + reason instead of throwing. */
async function section(name, fn) {
    try {
        return await fn();
    } catch (err) {
        console.warn(`[dashboard] section "${name}" unavailable:`, err.message);
        return null;
    }
}

async function deliveryHealth() {
    const doneList = TICKET_DONE_STATUSES.map((s) => `'${s}'`).join(',');
    const reviewList = TICKET_REVIEW_STATUSES.map((s) => `'${s}'`).join(',');

    const { rows: [k] } = await db.query(`
        SELECT
            count(*) FILTER (WHERE status NOT IN (${doneList}))                          AS active,
            count(*) FILTER (WHERE status NOT IN (${doneList}) AND is_blocked)            AS blocked,
            count(*) FILTER (WHERE status NOT IN (${doneList})
                             AND end_date IS NOT NULL AND end_date < now())               AS overdue,
            count(*) FILTER (WHERE status IN (${reviewList}))                             AS awaiting_review,
            count(*) FILTER (WHERE status NOT IN (${doneList}) AND owner_user_id IS NULL)  AS unowned
        FROM tickets WHERE deleted_at IS NULL
    `);

    // Blockers that have been sitting more than one business day are the single
    // most actionable number a PM has.
    const { rows: staleBlockers } = await db.query(`
        SELECT t.id, t.title, t.blocked_reason, t.blocked_at,
               p.name AS project_name, u.full_name AS owner_name
        FROM tickets t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN users u ON t.owner_user_id = u.id
        WHERE t.deleted_at IS NULL AND t.is_blocked
          AND t.blocked_at < now() - interval '1 day'
        ORDER BY t.blocked_at
    `);

    return {
        active: Number(k.active),
        blocked: Number(k.blocked),
        overdue: Number(k.overdue),
        awaiting_review: Number(k.awaiting_review),
        unowned: Number(k.unowned),
        stale_blockers: staleBlockers,
    };
}

async function customerHealth() {
    const doneList = SUPPORT_DONE_STATUSES.map((s) => `'${s}'`).join(',');

    const { rows: open } = await db.query(`
        SELECT st.*, sp.name AS project_name, p.client_name,
               dev.full_name AS assigned_dev_name, pm.full_name AS assigned_pm_name,
               pause.paused_at AS open_paused_at
        FROM support_tickets st
        LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
        LEFT JOIN projects p ON p.id = sp.project_id
        LEFT JOIN users dev ON st.assigned_dev_id = dev.id
        LEFT JOIN users pm ON st.assigned_pm_id = pm.id
        LEFT JOIN LATERAL (
            SELECT paused_at FROM sla_pauses
            WHERE support_ticket_id = st.id AND resumed_at IS NULL
            ORDER BY paused_at DESC LIMIT 1
        ) pause ON TRUE
        WHERE st.deleted_at IS NULL AND st.status NOT IN (${doneList})
    `);

    const { holidays, targets } = await SlaService.loadCalendar();
    const now = new Date();

    let breached = 0, atRisk = 0, paused = 0;
    const needsAttention = [];

    for (const t of open) {
        const sla = SlaService.slaStatus(t, { holidays, targets, now });
        const hasBreached = SlaService.isBreached(sla);

        if (sla.resolution.isPaused) paused++;
        if (hasBreached) breached++;
        else if (sla.needsAttention) atRisk++;

        if (hasBreached || sla.needsAttention) {
            needsAttention.push({
                id: t.id,
                ticket_key: t.ticket_key,
                title: t.title,
                priority: t.priority,
                status: t.status,
                client_name: t.client_name,
                owner: t.assigned_dev_name || t.assigned_pm_name || null,
                // Unassigned breaches are invisible in everyone's My Work — the
                // dashboard is the only place they surface.
                unassigned: !t.assigned_dev_id && !t.assigned_pm_id,
                first_response_pct: sla.firstResponse.pct,
                resolution_pct: sla.resolution.pct,
                breached: hasBreached,
            });
        }
    }

    needsAttention.sort((a, b) => (b.breached - a.breached) || (b.resolution_pct - a.resolution_pct));

    const { rows: [reopened] } = await db.query(`
        SELECT count(*) AS n FROM support_tickets
        WHERE deleted_at IS NULL AND reopen_count > 0
    `);

    return {
        open: open.length,
        breached,
        at_risk: atRisk,
        paused_waiting_customer: paused,
        reopened_ever: Number(reopened.n),
        unassigned_open: open.filter((t) => !t.assigned_dev_id && !t.assigned_pm_id).length,
        needs_attention: needsAttention,
    };
}

async function timeThisPeriod(from, to) {
    const { rows } = await db.query(`
        SELECT wtl.minutes, wtl.user_id, wtl.logged_for_date, wtl.status, wtl.is_billable,
               p.client_name
        FROM work_time_logs wtl
        LEFT JOIN tickets t ON wtl.ticket_id = t.id
        LEFT JOIN support_tickets st ON wtl.support_ticket_id = st.id
        LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
        LEFT JOIN projects p ON p.id = COALESCE(t.project_id, sp.project_id)
        WHERE wtl.deleted_at IS NULL
          AND wtl.logged_for_date >= $1 AND wtl.logged_for_date <= $2
    `, [from, to]);

    const billable = rows.filter((r) => r.is_billable);
    const byClient = new Map();
    for (const r of billable) {
        const key = r.client_name || '(unattributed)';
        byClient.set(key, (byClient.get(key) || 0) + r.minutes);
    }

    const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
    const billableMinutes = billable.reduce((s, r) => s + r.minutes, 0);
    const pending = rows.filter((r) => ['DRAFT', 'SUBMITTED'].includes(r.status));

    return {
        period: { from, to },
        entries: rows.length,
        total_hours: TimeLogService.toHours(totalMinutes),
        billable_hours: TimeLogService.toHours(billableMinutes),
        pending_approval_entries: pending.length,
        pending_approval_hours: TimeLogService.toHours(pending.reduce((s, r) => s + r.minutes, 0)),
        by_client: [...byClient.entries()]
            .map(([client_name, minutes]) => ({ client_name, hours: TimeLogService.toHours(minutes) }))
            .sort((a, b) => b.hours - a.hours),
    };
}

async function teamLoad() {
    const doneList = TICKET_DONE_STATUSES.map((s) => `'${s}'`).join(',');
    const supportDone = SUPPORT_DONE_STATUSES.map((s) => `'${s}'`).join(',');

    const { rows } = await db.query(`
        SELECT u.id, u.full_name, u.role,
               (SELECT count(*) FROM tickets t
                 WHERE t.deleted_at IS NULL AND t.owner_user_id = u.id
                   AND t.status NOT IN (${doneList}))                    AS owned_active,
               (SELECT count(*) FROM support_tickets st
                 WHERE st.deleted_at IS NULL AND st.assigned_dev_id = u.id
                   AND st.status NOT IN (${supportDone}))                AS support_active
        FROM users u
        WHERE u.deleted_at IS NULL AND u.role IN ('DEV','TECH_LEAD','QA')
        ORDER BY u.full_name
    `);

    return rows.map((r) => ({
        user_id: r.id,
        full_name: r.full_name,
        role: r.role,
        owned_active: Number(r.owned_active),
        support_active: Number(r.support_active),
        total_active: Number(r.owned_active) + Number(r.support_active),
    }));
}

exports.getDashboard = async (req, res) => {
    try {
        if (!isManager(req.user)) {
            return res.status(403).json({ error: 'Only managers can view the dashboard' });
        }

        // Defaults to the current calendar month, in LOCAL time.
        // toISOString() would convert to UTC first, so midnight on the 1st in
        // MYT (UTC+8) formats as the last day of the previous month — the
        // period silently started a day early.
        const pad = (n) => String(n).padStart(2, '0');
        const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

        const now = new Date();
        const from = req.query.from || ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        const to = req.query.to || ymd(now);

        const [delivery, customers, time, team] = await Promise.all([
            section('delivery', deliveryHealth),
            section('customers', customerHealth),
            section('time', () => timeThisPeriod(from, to)),
            section('team', teamLoad),
        ]);

        res.json({
            generated_at: new Date().toISOString(),
            delivery,
            customers,
            time,
            team,
            unavailable: Object.entries({ delivery, customers, time, team })
                .filter(([, v]) => v === null)
                .map(([k]) => k),
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ error: 'Failed to build dashboard', details: err.message });
    }
};
