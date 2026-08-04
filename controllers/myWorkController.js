const MyWork = require('../models/myWorkModel');
const {
    MANAGER_ROLES,
    TICKET_REVIEW_STATUSES,
    SUPPORT_REVIEW_STATUSES,
} = require('../constants');

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

        const today = startOfDay(new Date());
        const weekAhead = new Date(today);
        weekAhead.setDate(weekAhead.getDate() + 7);

        const buckets = {
            overdue: [],
            due_today: [],
            this_week: [],
            blocked: [],
            awaiting_review: [],
            active: [],
        };

        for (const item of items) {
            const reviewStatuses =
                item.work_type === 'KANBAN' ? TICKET_REVIEW_STATUSES : SUPPORT_REVIEW_STATUSES;

            // An item can appear in multiple buckets (e.g. blocked AND overdue),
            // so these are independent classifications, not a switch.
            if (item.is_blocked) buckets.blocked.push(item);
            if (reviewStatuses.includes(item.status)) buckets.awaiting_review.push(item);

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
