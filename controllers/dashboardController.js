const db = require('../db');
const SlaService = require('../services/slaService');
const TimeLogService = require('../services/timeLogService');
const {
    MANAGER_ROLES,
    TICKET_DONE_STATUSES,
    SUPPORT_DONE_STATUSES,
    TICKET_REVIEW_STATUSES,
    SUPPORT_URGENT_PRIORITIES,
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
        SELECT st.*, COALESCE(p.name, sp.name) AS project_name,
               COALESCE(stco.name, co.name, p.client_name) AS client_name,
               dev.full_name AS assigned_dev_name,
               pause.paused_at AS open_paused_at
        FROM support_tickets st
        LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
        -- st.project_id is the path new tickets use; sp.project_id is legacy.
        LEFT JOIN projects p ON p.id = COALESCE(st.project_id, sp.project_id)
        LEFT JOIN companies co ON co.id = p.company_id
        LEFT JOIN companies stco ON stco.id = st.company_id
        LEFT JOIN users dev ON st.assigned_dev_id = dev.id
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
                owner: t.assigned_dev_name || null,
                // Unassigned breaches are invisible in everyone's My Work — the
                // dashboard is the only place they surface.
                unassigned: !t.assigned_dev_id,
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
        unassigned_open: open.filter((t) => !t.assigned_dev_id).length,
        needs_attention: needsAttention,
    };
}

/**
 * Everything that needs someone's attention right now, for everybody.
 *
 * The only section a non-manager sees. Deliberately company-wide rather than
 * "yours": a P0 nobody has picked up is exactly the ticket that is in nobody's
 * My Work, and hiding it from the people who could take it is how it sits
 * overnight.
 *
 * Urgent means either of two things, because they catch different failures:
 *   - priority P0/P1        — urgent by its nature, even if freshly raised
 *   - SLA breached or close — urgent because time ran out, whatever the priority
 *
 * Kanban tickets have no priority column, so their urgency can only be
 * behavioural: past their end date, or blocked.
 */
async function urgentWork() {
    const supportDone = SUPPORT_DONE_STATUSES.map((s) => `'${s}'`).join(',');
    const urgentPriorities = SUPPORT_URGENT_PRIORITIES.map((p) => `'${p}'`).join(',');
    const doneList = TICKET_DONE_STATUSES.map((s) => `'${s}'`).join(',');

    const { rows: open } = await db.query(`
        SELECT st.*, COALESCE(p.name, sp.name) AS project_name,
               COALESCE(stco.name, co.name, p.client_name) AS client_name,
               dev.full_name AS assigned_dev_name,
               COALESCE(tlo.full_name, tlp.full_name) AS tech_lead_name,
               pause.paused_at AS open_paused_at
        FROM support_tickets st
        LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
        LEFT JOIN projects p ON p.id = COALESCE(st.project_id, sp.project_id)
        LEFT JOIN companies co ON co.id = p.company_id
        LEFT JOIN companies stco ON stco.id = st.company_id
        LEFT JOIN users dev ON st.assigned_dev_id = dev.id
        LEFT JOIN users tlo ON st.tech_lead_id = tlo.id
        LEFT JOIN users tlp ON p.tech_lead_id = tlp.id
        LEFT JOIN LATERAL (
            SELECT paused_at FROM sla_pauses
            WHERE support_ticket_id = st.id AND resumed_at IS NULL
            ORDER BY paused_at DESC LIMIT 1
        ) pause ON TRUE
        WHERE st.deleted_at IS NULL
          AND st.status NOT IN (${supportDone})
          AND (st.priority IN (${urgentPriorities})
               OR st.resolution_due_at IS NOT NULL
               OR st.sla_due_at IS NOT NULL)
    `);

    const { holidays, targets } = await SlaService.loadCalendar();
    const now = new Date();
    const support = [];

    for (const t of open) {
        // No priority means no SLA target, and slaStatus would throw — one bad
        // row must not blank the section everybody depends on.
        const sla = SlaService.slaStatus(t.priority ? t : { ...t, priority: 'P3' },
            { holidays, targets, now });
        const breached = SlaService.isBreached(sla);
        const highPriority = SUPPORT_URGENT_PRIORITIES.includes(t.priority);

        // A ticket paused waiting on the client is not somebody's fault to fix
        // right now, so it only makes the list on priority.
        if (!highPriority && !breached && !sla.needsAttention) continue;

        support.push({
            id: t.id,
            ticket_key: t.ticket_key,
            title: t.title,
            priority: t.priority,
            status: t.status,
            project_name: t.project_name,
            client_name: t.client_name,
            tech_lead_name: t.tech_lead_name || null,
            owner: t.assigned_dev_name || null,
            unassigned: !t.assigned_dev_id,
            breached,
            at_risk: !breached && Boolean(sla.needsAttention),
            paused: Boolean(sla.resolution.isPaused),
            resolution_pct: sla.resolution.pct,
            resolution_due_at: t.resolution_due_at || t.sla_due_at || null,
            reason: breached ? 'SLA breached'
                : sla.needsAttention ? 'SLA at risk'
                    : `Priority ${t.priority}`,

        });
    }

    // Breached first, then closest to breaching, then by priority — the order
    // someone should actually work down the list in.
    support.sort((a, b) =>
        (b.breached - a.breached)
        || (b.resolution_pct - a.resolution_pct)
        || String(a.priority || '').localeCompare(String(b.priority || '')));

    const { rows: kanban } = await db.query(`
        SELECT t.id, t.title, t.status, t.end_date, t.is_blocked, t.blocked_reason,
               t.project_id, p.name AS project_name, u.full_name AS owner_name
        FROM tickets t
        LEFT JOIN projects p ON t.project_id = p.id
        LEFT JOIN users u ON t.owner_user_id = u.id
        WHERE t.deleted_at IS NULL
          AND t.status NOT IN (${doneList})
          AND ((t.end_date IS NOT NULL AND t.end_date < now()) OR t.is_blocked)
        ORDER BY t.is_blocked DESC, t.end_date NULLS LAST
    `);

    return {
        support,
        kanban: kanban.map((k) => ({
            id: k.id,
            title: k.title,
            status: k.status,
            // Carried so the dashboard row can open the board it lives on.
            project_id: k.project_id,
            project_name: k.project_name,
            owner: k.owner_name || null,
            end_date: k.end_date,
            blocked: k.is_blocked,
            reason: k.is_blocked ? (k.blocked_reason || 'Blocked') : 'Past its end date',
        })),
        total: support.length + kanban.length,
        breached: support.filter((t) => t.breached).length,
        unassigned: support.filter((t) => t.unassigned).length,
    };
}

async function timeThisPeriod(from, to) {
    const { rows } = await db.query(`
        SELECT wtl.minutes, wtl.user_id, wtl.logged_for_date, wtl.status, wtl.is_billable,
               COALESCE(co.name, p.client_name) AS client_name
        FROM work_time_logs wtl
        LEFT JOIN tickets t ON wtl.ticket_id = t.id
        LEFT JOIN support_tickets st ON wtl.support_ticket_id = st.id
        LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
        LEFT JOIN projects p ON p.id = COALESCE(t.project_id, st.project_id, sp.project_id)
        LEFT JOIN companies co ON co.id = COALESCE(st.company_id, p.company_id)
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
        // The urgent section is for everybody — a developer who cannot see the
        // breaching P0 cannot pick it up. The company-wide delivery, time and
        // team numbers stay with managers, and a non-manager simply gets those
        // keys as null rather than a 403 for the whole page.
        const manager = isManager(req.user);

        // Defaults to the current calendar month, in LOCAL time.
        // toISOString() would convert to UTC first, so midnight on the 1st in
        // MYT (UTC+8) formats as the last day of the previous month — the
        // period silently started a day early.
        const pad = (n) => String(n).padStart(2, '0');
        const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

        const now = new Date();
        const from = req.query.from || ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        const to = req.query.to || ymd(now);

        const [urgent, delivery, customers, time, team] = await Promise.all([
            section('urgent', urgentWork),
            manager ? section('delivery', deliveryHealth) : null,
            manager ? section('customers', customerHealth) : null,
            manager ? section('time', () => timeThisPeriod(from, to)) : null,
            manager ? section('team', teamLoad) : null,
        ]);

        res.json({
            generated_at: new Date().toISOString(),
            is_manager: manager,
            urgent,
            delivery,
            customers,
            time,
            team,
            // Only report a section as unavailable if it was actually asked
            // for — otherwise every developer's page would claim four broken
            // migrations.
            unavailable: Object.entries(
                manager ? { urgent, delivery, customers, time, team } : { urgent }
            )
                .filter(([, v]) => v === null)
                .map(([k]) => k),
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ error: 'Failed to build dashboard', details: err.message });
    }
};
