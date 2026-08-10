const WorkTimeLog = require('../models/workTimeLogModel');
const TimeLogService = require('../services/timeLogService');
const db = require('../db');
const { MANAGER_ROLES, TIME_ROUNDING_MODES } = require('../constants');

const isManager = (user) => MANAGER_ROLES.includes(user.role);

/**
 * Groups entries by a key function and applies the rounding mode to each group.
 *
 * Rounding is applied PER GROUP, not to a pre-summed total — under
 * UP_PER_DAY_15 the grouping is what the rounding operates on, so summing first
 * would give a different (and wrong) number.
 */
function summarise(entries, keyFn, labelFn, mode) {
    const groups = new Map();
    for (const e of entries) {
        const key = keyFn(e);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }

    const out = [];
    for (const [key, group] of groups) {
        const exact = group.reduce((s, e) => s + e.minutes, 0);
        const billed = TimeLogService.roundMinutes(group, mode);
        out.push({
            key,
            ...labelFn(group[0]),
            entries: group.length,
            exact_minutes: exact,
            exact_hours: TimeLogService.toHours(exact),
            billable_minutes: billed,
            billable_hours: TimeLogService.toHours(billed),
            rounding_uplift_minutes: billed - exact,
        });
    }
    return out.sort((a, b) => b.billable_minutes - a.billable_minutes);
}

/**
 * GET /api/reports/time
 *   ?from=&to=&rounding=EXACT|NEAREST_15|UP_15|UP_PER_DAY_15
 *   &status=APPROVED|LOCKED   (default: APPROVED and LOCKED only)
 *   &groupBy=client|project|user|work_type
 *
 * Managers only — this is company-wide billing data.
 */
exports.getTimeReport = async (req, res) => {
    try {
        if (!isManager(req.user)) {
            return res.status(403).json({ error: 'Only managers can view billing reports' });
        }

        const { from, to, groupBy = 'client' } = req.query;
        const mode = req.query.rounding || 'UP_15';

        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
        if (!TIME_ROUNDING_MODES.includes(mode)) {
            return res.status(400).json({ error: `rounding must be one of: ${TIME_ROUNDING_MODES.join(', ')}` });
        }

        // Default to billable, invoice-ready time. Draft and submitted entries
        // are excluded: reporting on unapproved hours produces a number that
        // changes after you have quoted it.
        const status = req.query.status || null;
        const all = await WorkTimeLog.forReport({ from, to, status, billableOnly: false });
        const invoiceable = all.filter(
            (e) => e.is_billable && (status ? e.status === status : ['APPROVED', 'LOCKED'].includes(e.status))
        );

        const groupers = {
            client: [(e) => e.client_name || '__UNATTRIBUTED__', (e) => ({ client_name: e.client_name || null })],
            project: [(e) => e.project_id || '__UNATTRIBUTED__', (e) => ({ project_id: e.project_id, project_name: e.project_name, client_name: e.client_name })],
            user: [(e) => e.user_id, (e) => ({ user_id: e.user_id, user_name: e.user_name })],
            work_type: [(e) => e.work_type, (e) => ({ work_type: e.work_type })],
        };
        if (!groupers[groupBy]) {
            return res.status(400).json({ error: `groupBy must be one of: ${Object.keys(groupers).join(', ')}` });
        }

        const [keyFn, labelFn] = groupers[groupBy];
        const groups = summarise(invoiceable, keyFn, labelFn, mode);

        const exactTotal = invoiceable.reduce((s, e) => s + e.minutes, 0);
        const billedTotal = groups.reduce((s, g) => s + g.billable_minutes, 0);

        // Time that cannot reach a client — almost always a supporting_project
        // with no project_id. Surfaced rather than dropped: unattributed
        // billable time is revenue you are not invoicing.
        const unattributed = invoiceable.filter((e) => !e.client_name);
        const nonBillable = all.filter((e) => !e.is_billable && ['APPROVED', 'LOCKED'].includes(e.status));
        const nonBillableMinutes = nonBillable.reduce((s, e) => s + e.minutes, 0);
        const pending = all.filter((e) => ['DRAFT', 'SUBMITTED'].includes(e.status));
        const pendingMinutes = pending.reduce((s, e) => s + e.minutes, 0);

        res.json({
            period: { from, to },
            rounding: mode,
            group_by: groupBy,
            totals: {
                exact_minutes: exactTotal,
                exact_hours: TimeLogService.toHours(exactTotal),
                billable_minutes: billedTotal,
                billable_hours: TimeLogService.toHours(billedTotal),
                rounding_uplift_hours: TimeLogService.toHours(billedTotal - exactTotal),
                non_billable_hours: TimeLogService.toHours(nonBillableMinutes),
            },
            groups,
            warnings: {
                unattributed_entries: unattributed.length,
                unattributed_hours: TimeLogService.toHours(unattributed.reduce((s, e) => s + e.minutes, 0)),
                pending_approval_entries: pending.length,
                pending_approval_hours: TimeLogService.toHours(pendingMinutes),
            },
        });
    } catch (err) {
        console.error('Time report error:', err);
        res.status(500).json({ error: 'Failed to build time report', details: err.message });
    }
};

/**
 * GET /api/reports/time/estimate-vs-actual?from=&to=
 * Kanban only — support tickets carry no estimate.
 */
exports.getEstimateVsActual = async (req, res) => {
    try {
        if (!isManager(req.user)) {
            return res.status(403).json({ error: 'Only managers can view this report' });
        }
        const { from, to } = req.query;

        const params = [];
        let dateFilter = '';
        if (from && to) {
            params.push(from, to);
            dateFilter = 'AND wtl.logged_for_date BETWEEN $1 AND $2';
        }

        const { rows } = await db.query(
            `SELECT t.id, t.title, t.status,
                    p.name AS project_name,
                    COALESCE(co.name, p.client_name) AS client_name,
                    COALESCE(SUM(wtl.minutes), 0)::int AS actual_minutes,
                    count(wtl.id)::int AS entries
             FROM tickets t
             LEFT JOIN projects p ON t.project_id = p.id
             LEFT JOIN companies co ON co.id = p.company_id
             LEFT JOIN work_time_logs wtl
                    ON wtl.ticket_id = t.id AND wtl.deleted_at IS NULL ${dateFilter}
             WHERE t.deleted_at IS NULL
             GROUP BY t.id, t.title, t.status, p.name, co.name, p.client_name
             HAVING count(wtl.id) > 0
             ORDER BY SUM(wtl.minutes) DESC`,
            params
        );

        res.json({
            period: from && to ? { from, to } : null,
            note: 'tickets has no estimate column yet — actuals only. Add estimated_minutes to compare.',
            tickets: rows.map((r) => ({ ...r, actual_hours: TimeLogService.toHours(r.actual_minutes) })),
        });
    } catch (err) {
        console.error('Estimate vs actual error:', err);
        res.status(500).json({ error: 'Failed to build report', details: err.message });
    }
};
