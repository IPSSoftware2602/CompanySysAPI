const db = require('../db');
const SlaService = require('../services/slaService');
const { SUPPORT_DONE_STATUSES } = require('../constants');

/**
 * GET /api/reports/support
 *
 * "For each support task: what is delayed, what is incomplete."
 *
 * Two different questions, deliberately kept apart:
 *
 *   delayed    — the resolution took (or is taking) longer than the ticket's
 *                SLA allowed. Includes tickets already finished late, which is
 *                the half a live board can never show you.
 *   incomplete — not finished at all, right now.
 *
 * A ticket can be both, either, or neither.
 *
 * Delay is measured in BUSINESS hours against the priority's resolution target,
 * with time spent WAITING_FOR_CLIENT deducted — the same arithmetic the SLA
 * panel and the breach cron use. Measuring in wall-clock hours instead would
 * report every ticket raised on a Friday afternoon as two days late by Monday.
 *
 * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Tickets are selected and bucketed by when their work started
 * (start_date, falling back to created_at), so a ticket appears in the month it
 * belongs to rather than the month it happened to be closed in.
 */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round1 = (n) => Math.round(n * 10) / 10;

/** Accumulates one bucket of a grouping. */
function blankGroup(key, label) {
    return {
        key, label,
        tickets: 0,
        delayed: 0,
        incomplete: 0,
        completed: 0,
        delay_hours_total: 0,
        worst_delay_hours: 0,
    };
}

function addToGroup(map, key, label, row) {
    if (!map.has(key)) map.set(key, blankGroup(key, label));
    const g = map.get(key);
    g.tickets += 1;
    if (row.delayed) g.delayed += 1;
    if (row.incomplete) g.incomplete += 1; else g.completed += 1;
    g.delay_hours_total += row.delay_hours;
    g.worst_delay_hours = Math.max(g.worst_delay_hours, row.delay_hours);
}

/** Averages and percentages, computed once at the end so rounding happens last. */
function finishGroups(map) {
    return [...map.values()]
        .map((g) => ({
            key: g.key,
            label: g.label,
            tickets: g.tickets,
            delayed: g.delayed,
            incomplete: g.incomplete,
            completed: g.completed,
            delayed_pct: g.tickets ? Math.round((g.delayed / g.tickets) * 100) : 0,
            // Averaged over ALL tickets in the bucket, not just the late ones:
            // averaging over late tickets alone makes a team that is late once
            // look worse than one that is late every time.
            avg_delay_hours: g.tickets ? round1(g.delay_hours_total / g.tickets) : 0,
            worst_delay_hours: round1(g.worst_delay_hours),
        }))
        .sort((a, b) => b.delayed - a.delayed || b.tickets - a.tickets);
}

exports.getSupportReport = async (req, res) => {
    try {
        const now = new Date();
        const from = req.query.from || ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        const to = req.query.to || ymd(now);

        const { rows } = await db.query(`
            SELECT st.*,
                   COALESCE(p.name, sp.name)                   AS project_name,
                   COALESCE(stco.name, co.name, p.client_name) AS client_name,
                   dev.full_name                               AS assigned_dev_name,
                   COALESCE(tlo.full_name, tlp.full_name)      AS tech_lead_name,
                   pause.paused_at                             AS open_paused_at,
                   COALESCE(cl.total, 0)                       AS checklist_total,
                   COALESCE(cl.done, 0)                        AS checklist_done
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
            LEFT JOIN LATERAL (
                SELECT count(*)::int AS total, count(*) FILTER (WHERE is_done)::int AS done
                FROM support_ticket_checklist_items
                WHERE support_ticket_id = st.id
            ) cl ON TRUE
            WHERE st.deleted_at IS NULL
              AND COALESCE(st.start_date, st.created_at) >= $1::date
              AND COALESCE(st.start_date, st.created_at) < ($2::date + INTERVAL '1 day')
            ORDER BY COALESCE(st.start_date, st.created_at) DESC
        `, [from, to]);

        const { holidays, targets } = await SlaService.loadCalendar();

        const byPerson = new Map();
        const byProject = new Map();
        const byMonth = new Map();
        const tickets = [];

        for (const t of rows) {
            // A ticket with no priority has no SLA target, and slaStatus would
            // throw on it — taking the whole report down over one bad row.
            // Treated as the gentlest priority rather than dropped, so it still
            // shows up in the counts.
            const priced = t.priority ? t : { ...t, priority: 'P3' };
            const sla = SlaService.slaStatus(priced, {
                holidays,
                targets,
                now,
                openPause: t.open_paused_at ? { paused_at: t.open_paused_at } : null,
            });

            const over = sla.resolution.consumedHours - sla.resolution.targetHours;
            const delayHours = over > 0 ? round1(over) : 0;
            const incomplete = !SUPPORT_DONE_STATUSES.includes(t.status);
            // CANCELLED work was never owed, so it cannot be late.
            const delayed = t.status !== 'CANCELLED' && delayHours > 0;

            const startedAt = t.start_date || t.created_at;
            const started = new Date(startedAt);

            const row = {
                id: t.id,
                ticket_key: t.ticket_key,
                title: t.title,
                status: t.status,
                priority: t.priority || 'P3',
                request_type: t.request_type,
                project_name: t.project_name || null,
                client_name: t.client_name || null,
                assignee: t.assigned_dev_name || null,
                tech_lead_name: t.tech_lead_name || null,
                started_at: startedAt,
                resolution_due_at: t.resolution_due_at || t.sla_due_at || null,
                resolved_at: sla.resolution.resolvedAt,
                target_hours: round1(sla.resolution.targetHours),
                consumed_hours: round1(sla.resolution.consumedHours),
                paused_hours: sla.resolution.pausedHours,
                delay_hours: delayHours,
                delayed,
                incomplete,
                paused: sla.resolution.isPaused,
                checklist: { total: t.checklist_total, done: t.checklist_done },
                checklist_outstanding: t.checklist_total - t.checklist_done,
            };
            tickets.push(row);

            // Unassigned tickets are their own bucket rather than being dropped:
            // they are usually the worst-delayed ones and belong in the total.
            addToGroup(byPerson, t.assigned_dev_id || 'unassigned',
                t.assigned_dev_name || 'Unassigned', row);
            addToGroup(byProject, t.project_id || t.supporting_project_id || 'none',
                t.project_name || 'No project', row);
            const monthKey = `${started.getFullYear()}-${pad(started.getMonth() + 1)}`;
            addToGroup(byMonth, monthKey, monthKey, row);
        }

        const delayed = tickets.filter((t) => t.delayed);
        const months = finishGroups(byMonth).sort((a, b) => b.key.localeCompare(a.key));

        res.json({
            period: { from, to },
            totals: {
                tickets: tickets.length,
                delayed: delayed.length,
                incomplete: tickets.filter((t) => t.incomplete).length,
                completed: tickets.filter((t) => !t.incomplete).length,
                delayed_pct: tickets.length
                    ? Math.round((delayed.length / tickets.length) * 100) : 0,
                avg_delay_hours: tickets.length
                    ? round1(tickets.reduce((s, t) => s + t.delay_hours, 0) / tickets.length) : 0,
                worst_delay_hours: tickets.length
                    ? round1(Math.max(...tickets.map((t) => t.delay_hours))) : 0,
            },
            groups: {
                person: finishGroups(byPerson),
                project: finishGroups(byProject),
                month: months,
            },
            tickets,
        });
    } catch (err) {
        // The SLA columns only exist after migrate_sla_v2. Say so plainly
        // rather than reporting a server fault.
        if (err.code === '42P01' || err.code === '42703') {
            return res.status(501).json({ error: 'SLA tracking is not enabled on this database' });
        }
        console.error('Support report error:', err);
        res.status(500).json({ error: 'Failed to build support report', details: err.message });
    }
};
