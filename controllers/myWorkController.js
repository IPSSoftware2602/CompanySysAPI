const MyWork = require('../models/myWorkModel');
const SlaService = require('../services/slaService');
const {
    MANAGER_ROLES,
    TICKET_REVIEW_STATUSES,
    SUPPORT_REVIEW_STATUSES,
} = require('../constants');

/**
 * Sets `is_owner` on kanban items: true when the user is accountable, false
 * when they are collaborating. Fail-soft — before migrate_tier1_ownership runs
 * there is no owner column, and every item simply reports is_owner: false.
 */
async function markOwnership(items, userId) {
    const kanban = items.filter((i) => i.work_type === 'KANBAN');
    if (!kanban.length) return;

    let owned = new Set();
    try {
        owned = await MyWork.getOwnedTicketIds(kanban.map((i) => i.id), userId);
    } catch (err) {
        console.warn('[my-work] ownership unavailable:', err.message);
    }
    for (const item of kanban) item.is_owner = owned.has(item.id);
}

/**
 * Attaches an `sla` block to each SUPPORT item and returns the ids that need
 * attention (>= the warning threshold on a running clock).
 *
 * Fail-soft on purpose: if the SLA migration has not run, or the calendar is
 * unavailable, My Work still returns every bucket — it just loses the SLA
 * signal. A missing warning is bad; a 500 on the screen everyone opens first
 * is worse.
 */
async function enrichWithSla(items) {
    const supportItems = items.filter((i) => i.work_type === 'SUPPORT');
    if (!supportItems.length) return new Set();

    try {
        const [context, { holidays, targets }] = await Promise.all([
            MyWork.getSlaContext(supportItems.map((i) => i.id)),
            SlaService.loadCalendar(),
        ]);

        const atRisk = new Set();
        for (const item of supportItems) {
            const row = context.get(item.id);
            if (!row) continue;

            const status = SlaService.slaStatus(row, {
                holidays,
                targets,
                openPause: row.open_paused_at ? { paused_at: row.open_paused_at } : null,
            });

            item.sla = {
                first_response_pct: status.firstResponse.pct,
                first_response_due_at: status.firstResponse.dueAt,
                first_response_met: status.firstResponse.met,
                resolution_pct: status.resolution.pct,
                resolution_due_at: status.resolution.dueAt,
                breached: status.firstResponse.breached || status.resolution.breached,
                is_paused: status.resolution.isPaused,
            };

            if (status.needsAttention) atRisk.add(item.id);
        }
        return atRisk;
    } catch (err) {
        // Most likely cause: migrate_sla_v2 has not been run yet.
        console.warn('[my-work] SLA enrichment unavailable:', err.message);
        return new Set();
    }
}

// Start-of-day for a given date, in server local time.
function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

/**
 * GET /api/my-work
 * Returns the caller's active work grouped into buckets. Managers may pass
 * ?userId=<uuid> to view another user's work.
 */
exports.getMyWork = async (req, res) => {
    try {
        const requestedUserId = req.query.userId;
        let targetUserId = req.user.id;

        if (requestedUserId && requestedUserId !== req.user.id) {
            if (!MANAGER_ROLES.includes(req.user.role)) {
                return res.status(403).json({ error: "You are not allowed to view another user's work" });
            }
            targetUserId = requestedUserId;
        }

        const items = await MyWork.getForUser(targetUserId);
        await markOwnership(items, targetUserId);
        const slaAtRisk = await enrichWithSla(items);

        const today = startOfDay(new Date());
        const weekAhead = new Date(today);
        weekAhead.setDate(weekAhead.getDate() + 7);

        const buckets = {
            overdue: [],
            due_today: [],
            this_week: [],
            blocked: [],
            awaiting_review: [],
            // Support work burning through its SLA but not yet past the deadline.
            // Bucketing on due_date alone makes a ticket at 85% look calm right
            // up until it is already late — this is the bucket you can still act on.
            sla_risk: [],
            active: [],
        };

        for (const item of items) {
            const reviewStatuses =
                item.work_type === 'KANBAN' ? TICKET_REVIEW_STATUSES : SUPPORT_REVIEW_STATUSES;

            // An item can appear in multiple buckets (e.g. blocked AND overdue),
            // so these are independent classifications, not a switch.
            if (item.is_blocked) buckets.blocked.push(item);
            if (reviewStatuses.includes(item.status)) buckets.awaiting_review.push(item);
            if (slaAtRisk.has(item.id)) buckets.sla_risk.push(item);

            if (item.due_date) {
                const due = startOfDay(item.due_date);
                if (due < today) buckets.overdue.push(item);
                else if (due.getTime() === today.getTime()) buckets.due_today.push(item);
                else if (due < weekAhead) buckets.this_week.push(item);
            }

            // "active" = everything currently on the person's plate.
            buckets.active.push(item);
        }

        res.json({
            user_id: targetUserId,
            counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
            buckets,
        });
    } catch (err) {
        console.error('My Work error:', err);
        res.status(500).json({ error: 'Failed to load work', details: err.message });
    }
};
