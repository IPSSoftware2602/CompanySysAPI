/**
 * SLA engine for support tickets.
 *
 * Two clocks, and only two:
 *   first response — start -> first customer-visible reply.  NEVER pauses.
 *   resolution     — start -> COMPLETED/CLOSED.              Pauses on WAITING_FOR_CLIENT.
 *
 * The asymmetry is deliberate. If pausing stopped the first-response clock, the
 * fastest way to hit target would be to park a new ticket in WAITING_FOR_CLIENT
 * before anyone had read it.
 *
 * Deadlines are computed once and STORED on the ticket
 * (first_response_due_at / resolution_due_at) rather than recomputed on read:
 *   - breach detection becomes a plain timestamp comparison,
 *   - editing sla_targets next year does not silently rewrite last year's history.
 * On resume, resolution_due_at is pushed forward by the paused business hours,
 * so the stored deadline stays the whole truth.
 *
 * Pure calculation is separated from database access so the arithmetic is
 * unit-testable without a connection. Everything below `--- DB ---` touches pg;
 * everything above it does not.
 */

const db = require('../db');
const {
    calculateWorkingHours,
    addWorkingHours,
} = require('../utils/workingHours');
const { SUPPORT_PRIORITIES, SUPPORT_DONE_STATUSES } = require('../constants');

/**
 * Fallback targets, in BUSINESS hours on the Mon-Fri 9.25h / Sat 4h calendar.
 * Used only if sla_targets is empty. P1's 24h is ~2.5 working days, not one
 * calendar day — the units trip people up, so read them as working hours.
 */
const DEFAULT_TARGETS = {
    P0: { first_response_hours: 1, resolution_hours: 8 },
    P1: { first_response_hours: 4, resolution_hours: 24 },
    P2: { first_response_hours: 8, resolution_hours: 40 },
    P3: { first_response_hours: 16, resolution_hours: 80 },
};

/** Notify at this consumption before anyone has actually breached. */
const WARN_THRESHOLD_PCT = 80;

// ---------------------------------------------------------------- pure ----

/**
 * First-response and resolution deadlines for a ticket.
 *
 * @param {object} args
 * @param {string} args.priority - P0..P3
 * @param {Date|string} args.startAt
 * @param {object} [args.targets] - priority -> { first_response_hours, resolution_hours }
 * @param {Array} [args.holidays]
 * @returns {{ first_response_due_at: Date, resolution_due_at: Date }}
 */
function computeDeadlines({ priority, startAt, targets = DEFAULT_TARGETS, holidays = [] }) {
    const target = targets[priority];
    if (!target) {
        throw new Error(`computeDeadlines: no SLA target configured for priority "${priority}"`);
    }
    return {
        first_response_due_at: addWorkingHours(startAt, Number(target.first_response_hours), holidays),
        resolution_due_at: addWorkingHours(startAt, Number(target.resolution_hours), holidays),
    };
}

/**
 * Business hours inside a pause window. This is what gets credited back to the
 * resolution clock — a pause across a weekend costs the customer nothing,
 * because the team was not working anyway.
 */
function pauseDebitHours(pausedAt, resumedAt, holidays = []) {
    if (!pausedAt || !resumedAt) return 0;
    return calculateWorkingHours(pausedAt, resumedAt, holidays);
}

/**
 * How much of one clock has been consumed.
 *
 * @param {object} args
 * @param {Date|string} args.startAt
 * @param {Date|string} args.stopAt   - completion time, or "now" for a live ticket
 * @param {number} args.targetHours
 * @param {number} [args.pausedHours=0] - excluded from consumption (resolution only)
 * @param {Array} [args.holidays]
 * @returns {{ consumedHours: number, targetHours: number, pct: number, breached: boolean }}
 */
function consumption({ startAt, stopAt, targetHours, pausedHours = 0, holidays = [] }) {
    const gross = calculateWorkingHours(startAt, stopAt, holidays);
    const consumedHours = Math.max(0, Math.round((gross - pausedHours) * 100) / 100);
    const pct = targetHours > 0
        ? Math.round((consumedHours / targetHours) * 1000) / 10
        : 0;
    return {
        consumedHours,
        targetHours,
        pct,
        breached: targetHours > 0 && consumedHours > targetHours,
    };
}

/**
 * Full SLA picture for one ticket row.
 *
 * @param {object} ticket - a support_tickets row
 * @param {object} [opts]
 * @param {object} [opts.targets]
 * @param {Array}  [opts.holidays]
 * @param {Date}   [opts.now]
 * @param {{paused_at: Date}|null} [opts.openPause] - currently-open sla_pauses row, if any
 */
function slaStatus(ticket, { targets = DEFAULT_TARGETS, holidays = [], now = new Date(), openPause = null } = {}) {
    const target = targets[ticket.priority] || DEFAULT_TARGETS[ticket.priority];
    const startAt = ticket.start_date || ticket.created_at;

    // --- first response: never pauses ---
    const frStop = ticket.first_response_at || now;
    const firstResponse = {
        ...consumption({
            startAt,
            stopAt: frStop,
            targetHours: Number(target.first_response_hours),
            holidays,
        }),
        dueAt: ticket.first_response_due_at || null,
        respondedAt: ticket.first_response_at || null,
        met: Boolean(ticket.first_response_at)
            && calculateWorkingHours(startAt, ticket.first_response_at, holidays)
                <= Number(target.first_response_hours),
    };

    // --- resolution: pauses on WAITING_FOR_CLIENT ---
    const isDone = SUPPORT_DONE_STATUSES.includes(ticket.status);
    const resStop = (isDone && (ticket.actual_end_date || ticket.closed_at)) || now;

    // Banked pause time, plus any pause still open right now.
    let pausedHours = Number(ticket.sla_paused_total_minutes || 0) / 60;
    if (openPause && openPause.paused_at) {
        pausedHours += pauseDebitHours(openPause.paused_at, resStop, holidays);
    }

    const resolution = {
        ...consumption({
            startAt,
            stopAt: resStop,
            targetHours: Number(target.resolution_hours),
            pausedHours,
            holidays,
        }),
        dueAt: ticket.resolution_due_at || null,
        resolvedAt: isDone ? (ticket.actual_end_date || ticket.closed_at || null) : null,
        pausedHours: Math.round(pausedHours * 100) / 100,
        isPaused: Boolean(openPause),
    };

    return {
        priority: ticket.priority,
        firstResponse,
        resolution,
        // A ticket "needs attention" when either clock is warm and still running.
        needsAttention:
            (!firstResponse.respondedAt && firstResponse.pct >= WARN_THRESHOLD_PCT) ||
            (!isDone && !resolution.isPaused && resolution.pct >= WARN_THRESHOLD_PCT),
    };
}

/**
 * Has this ticket actually breached, as opposed to merely being warm?
 *
 * A paused resolution clock does not count: the ticket is waiting on the
 * customer, so the time is not ours. First response never pauses, so it always
 * counts.
 *
 * Lives here rather than at each call site because it was duplicated between
 * the breach cron and the dashboard, and the dashboard's copy silently read an
 * undefined field — reporting every breach as "at risk". One definition.
 *
 * @param {ReturnType<typeof slaStatus>} sla
 */
function isBreached(sla) {
    if (!sla) return false;
    return Boolean(
        sla.firstResponse.breached ||
        (!sla.resolution.isPaused && !sla.resolution.resolvedAt && sla.resolution.breached)
    );
}

// ------------------------------------------------------------------ DB ----

let _cache = { holidays: null, targets: null, loadedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Drop the holiday/target cache. Call after editing either table. */
function invalidateCache() {
    _cache = { holidays: null, targets: null, loadedAt: 0 };
}

async function loadCalendar(client = db) {
    const fresh = Date.now() - _cache.loadedAt < CACHE_TTL_MS;
    if (fresh && _cache.holidays && _cache.targets) {
        return { holidays: _cache.holidays, targets: _cache.targets };
    }

    const [holidayRows, targetRows] = await Promise.all([
        client.query('SELECT holiday_date FROM public_holidays'),
        client.query('SELECT priority, first_response_hours, resolution_hours FROM sla_targets'),
    ]);

    // pg returns DATE as a JS Date at local midnight; format it back to a plain
    // calendar key so no timezone shifting can move the holiday a day.
    const holidays = holidayRows.rows.map((r) => {
        const d = r.holiday_date;
        if (typeof d === 'string') return d.slice(0, 10);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });

    const targets = targetRows.rows.length
        ? Object.fromEntries(targetRows.rows.map((r) => [r.priority, {
            first_response_hours: Number(r.first_response_hours),
            resolution_hours: Number(r.resolution_hours),
        }]))
        : { ...DEFAULT_TARGETS };

    // Never let a half-populated table produce an undefined target at runtime.
    for (const p of SUPPORT_PRIORITIES) {
        if (!targets[p]) targets[p] = DEFAULT_TARGETS[p];
    }

    _cache = { holidays, targets, loadedAt: Date.now() };
    return { holidays, targets };
}

/** The currently-open pause for a ticket, or null. */
async function getOpenPause(supportTicketId, client = db) {
    const { rows } = await client.query(
        `SELECT * FROM sla_pauses
         WHERE support_ticket_id = $1 AND resumed_at IS NULL
         ORDER BY paused_at DESC LIMIT 1`,
        [supportTicketId]
    );
    return rows[0] || null;
}

/**
 * Compute and persist both deadlines. Call on create, and on any change to
 * priority or start_date.
 * @returns {{first_response_due_at: Date, resolution_due_at: Date}}
 */
async function applyDeadlines(supportTicketId, { priority, startAt }, client = db) {
    const { holidays, targets } = await loadCalendar(client);
    const deadlines = computeDeadlines({ priority, startAt, targets, holidays });

    await client.query(
        `UPDATE support_tickets
         SET first_response_due_at = $1, resolution_due_at = $2, sla_due_at = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [deadlines.first_response_due_at, deadlines.resolution_due_at, supportTicketId]
    );
    return deadlines;
}

/**
 * Stamp first_response_at, once. Idempotent — a second call is a no-op, so it
 * is safe to invoke from the comment handler on every customer-visible reply.
 * @returns {boolean} true if this call was the one that recorded it
 */
async function recordFirstResponse(supportTicketId, at = new Date(), client = db) {
    const { rowCount } = await client.query(
        `UPDATE support_tickets
         SET first_response_at = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND first_response_at IS NULL`,
        [at, supportTicketId]
    );
    return rowCount > 0;
}

/**
 * Open a pause. Idempotent — if one is already open, returns it untouched.
 */
async function pause(supportTicketId, { at = new Date(), reason = null, userId = null } = {}, client = db) {
    const existing = await getOpenPause(supportTicketId, client);
    if (existing) return existing;

    const { rows } = await client.query(
        `INSERT INTO sla_pauses (support_ticket_id, paused_at, reason, paused_by_user_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [supportTicketId, at, reason, userId]
    );
    return rows[0];
}

/**
 * Close the open pause and credit the paused business hours back: bank them in
 * sla_paused_total_minutes and push resolution_due_at forward by the same
 * amount. first_response_due_at is untouched by design.
 *
 * @returns {{ pausedHours: number, resolution_due_at: Date }|null} null if nothing was paused
 */
async function resume(supportTicketId, { at = new Date() } = {}, client = db) {
    const open = await getOpenPause(supportTicketId, client);
    if (!open) return null;

    const { holidays } = await loadCalendar(client);
    const pausedHours = pauseDebitHours(open.paused_at, at, holidays);

    await client.query(
        'UPDATE sla_pauses SET resumed_at = $1 WHERE id = $2',
        [at, open.id]
    );

    const { rows } = await client.query(
        'SELECT resolution_due_at FROM support_tickets WHERE id = $1',
        [supportTicketId]
    );
    const currentDue = rows[0] && rows[0].resolution_due_at;

    // Push the deadline forward by the paused working time. Using the calendar
    // (not raw ms) keeps the new deadline inside a work window.
    const newDue = currentDue
        ? addWorkingHours(currentDue, pausedHours, holidays)
        : null;

    await client.query(
        `UPDATE support_tickets
         SET sla_paused_total_minutes = COALESCE(sla_paused_total_minutes, 0) + $1,
             resolution_due_at = COALESCE($2, resolution_due_at),
             sla_due_at = COALESCE($2, sla_due_at),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [Math.round(pausedHours * 60), newDue, supportTicketId]
    );

    return { pausedHours, resolution_due_at: newDue };
}

/** SLA status for a single ticket id, with calendar and open pause resolved. */
async function statusFor(supportTicketId, client = db) {
    const { rows } = await client.query(
        'SELECT * FROM support_tickets WHERE id = $1 AND deleted_at IS NULL',
        [supportTicketId]
    );
    if (!rows[0]) return null;

    const [{ holidays, targets }, openPause] = await Promise.all([
        loadCalendar(client),
        getOpenPause(supportTicketId, client),
    ]);
    return slaStatus(rows[0], { holidays, targets, openPause });
}

/**
 * Open tickets at or past `thresholdPct` on either clock — the query behind the
 * breach cron and the support dashboard.
 *
 * Consumption is computed in JS rather than SQL because business hours are not
 * expressible in a plain timestamp comparison, and one calendar implementation
 * beats two that can disagree. Bounded by open-ticket count, which is small.
 */
async function findBreaching({ thresholdPct = WARN_THRESHOLD_PCT, now = new Date() } = {}, client = db) {
    const done = SUPPORT_DONE_STATUSES;
    const { rows } = await client.query(
        `SELECT st.*,
                sp.name  AS project_name,
                dev.full_name AS assigned_dev_name,
                pm.full_name  AS assigned_pm_name,
                p.paused_at   AS open_paused_at
         FROM support_tickets st
         LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
         LEFT JOIN users dev ON st.assigned_dev_id = dev.id
         LEFT JOIN users pm  ON st.assigned_pm_id = pm.id
         LEFT JOIN LATERAL (
             SELECT paused_at FROM sla_pauses
             WHERE support_ticket_id = st.id AND resumed_at IS NULL
             ORDER BY paused_at DESC LIMIT 1
         ) p ON TRUE
         WHERE st.deleted_at IS NULL
           AND st.status <> ALL($1::support_ticket_status[])`,
        [done]
    );

    const { holidays, targets } = await loadCalendar(client);

    return rows
        .map((row) => {
            const status = slaStatus(row, {
                holidays,
                targets,
                now,
                openPause: row.open_paused_at ? { paused_at: row.open_paused_at } : null,
            });
            return { ticket: row, sla: status };
        })
        .filter(({ sla }) =>
            (!sla.firstResponse.respondedAt && sla.firstResponse.pct >= thresholdPct) ||
            (!sla.resolution.isPaused && sla.resolution.pct >= thresholdPct)
        )
        .sort((a, b) =>
            Math.max(b.sla.firstResponse.pct, b.sla.resolution.pct) -
            Math.max(a.sla.firstResponse.pct, a.sla.resolution.pct)
        );
}

module.exports = {
    // pure
    computeDeadlines,
    pauseDebitHours,
    consumption,
    slaStatus,
    isBreached,
    DEFAULT_TARGETS,
    WARN_THRESHOLD_PCT,
    // db
    loadCalendar,
    invalidateCache,
    getOpenPause,
    applyDeadlines,
    recordFirstResponse,
    pause,
    resume,
    statusFor,
    findBreaching,
};
