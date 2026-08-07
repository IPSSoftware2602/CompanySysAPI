/**
 * Time log rules: rounding, transitions, immutability.
 *
 * Pure functions where possible so the parts that decide what a client is
 * billed can be unit-tested without a database.
 */

const {
    TIME_LOG_TRANSITIONS,
    TIME_LOG_IMMUTABLE_STATUSES,
    TIME_ROUNDING_MODES,
} = require('../constants');

/** Minutes in the rounding increment. Only 15 is used today; kept as a constant
 *  so a client on 6-minute (tenth-of-hour) billing is a one-line change. */
const INCREMENT = 15;

/**
 * Apply a rounding mode to a set of entries.
 *
 * Rounding happens HERE, at report time — never on write. The stored minutes
 * stay exact so the same work can be re-billed under a different agreement
 * without having lost the original number.
 *
 * Modes:
 *   EXACT         - no rounding; what was worked is what is reported
 *   NEAREST_15    - each entry to the nearest quarter hour (7 -> 0, 8 -> 15)
 *   UP_15         - each entry up to the next quarter hour; the usual
 *                   agency default, and the most generous to you
 *   UP_PER_DAY_15 - sum a person's day first, then round the total up. Fairer
 *                   to the client than UP_15: five 5-minute entries become
 *                   15 minutes rather than 75.
 *
 * @param {Array<{minutes:number, user_id:string, logged_for_date:string|Date}>} entries
 * @param {string} mode
 * @returns {number} billable minutes for the set
 */
function roundMinutes(entries, mode = 'EXACT') {
    if (!TIME_ROUNDING_MODES.includes(mode)) {
        throw new Error(`Unknown rounding mode: ${mode}`);
    }
    if (!entries.length) return 0;

    const roundUp = (m) => Math.ceil(m / INCREMENT) * INCREMENT;
    const roundNear = (m) => Math.round(m / INCREMENT) * INCREMENT;

    switch (mode) {
        case 'EXACT':
            return entries.reduce((s, e) => s + e.minutes, 0);

        case 'NEAREST_15':
            return entries.reduce((s, e) => s + roundNear(e.minutes), 0);

        case 'UP_15':
            return entries.reduce((s, e) => s + roundUp(e.minutes), 0);

        case 'UP_PER_DAY_15': {
            // Group by person AND day — rounding one person's day is the unit a
            // client would recognise on an invoice line.
            const byPersonDay = new Map();
            for (const e of entries) {
                const day = e.logged_for_date instanceof Date
                    ? e.logged_for_date.toISOString().slice(0, 10)
                    : String(e.logged_for_date).slice(0, 10);
                const key = `${e.user_id}|${day}`;
                byPersonDay.set(key, (byPersonDay.get(key) || 0) + e.minutes);
            }
            let total = 0;
            for (const m of byPersonDay.values()) total += roundUp(m);
            return total;
        }

        default:
            return 0;
    }
}

/** Minutes -> decimal hours, 2dp. What an invoice line actually shows. */
function toHours(minutes) {
    return Math.round((minutes / 60) * 100) / 100;
}

/**
 * Is this status change allowed?
 * @returns {{ok: boolean, reason?: string}}
 */
function canTransition(from, to) {
    const allowed = TIME_LOG_TRANSITIONS[from];
    if (!allowed) return { ok: false, reason: `Unknown status "${from}"` };
    if (!allowed.includes(to)) {
        return {
            ok: false,
            reason: allowed.length
                ? `Cannot go ${from} -> ${to}. Allowed from ${from}: ${allowed.join(', ')}`
                : `${from} is terminal; entries cannot leave it`,
        };
    }
    return { ok: true };
}

/**
 * May this entry's own fields (minutes, date, note, billable) be edited?
 *
 * Once APPROVED the entry is part of a billing record. Editing it would make an
 * invoice you have already sent stop matching the data behind it, so a change
 * has to arrive as a correcting entry instead.
 */
function canEdit(entry) {
    if (entry.deleted_at) return { ok: false, reason: 'Entry is deleted' };
    if (TIME_LOG_IMMUTABLE_STATUSES.includes(entry.status)) {
        return {
            ok: false,
            reason: `Entry is ${entry.status} and immutable. Create a correcting entry instead.`,
        };
    }
    return { ok: true };
}

/**
 * Validate a new or edited entry's own values.
 * @returns {string[]} error messages, empty when valid
 */
function validate({ minutes, logged_for_date, ticket_id, support_ticket_id }) {
    const errors = [];

    if (minutes === undefined || minutes === null || minutes === '') {
        errors.push('minutes is required');
    } else {
        const m = Number(minutes);
        if (!Number.isInteger(m)) errors.push('minutes must be a whole number');
        else if (m <= 0) errors.push('minutes must be greater than 0');
        else if (m > 1440) errors.push('minutes cannot exceed 1440 (24h) in a single entry');
    }

    if (!logged_for_date) {
        errors.push('logged_for_date is required');
    } else {
        const d = new Date(logged_for_date);
        if (Number.isNaN(d.getTime())) {
            errors.push('logged_for_date is not a valid date');
        } else {
            // A day ahead of "today" is almost always a typo in the year or
            // month. Tomorrow is allowed for timezone slack; beyond that is not.
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(23, 59, 59, 999);
            if (d > tomorrow) errors.push('logged_for_date cannot be in the future');
        }
    }

    const hasKanban = Boolean(ticket_id);
    const hasSupport = Boolean(support_ticket_id);
    if (hasKanban === hasSupport) {
        errors.push('exactly one of ticket_id or support_ticket_id is required');
    }

    return errors;
}

module.exports = {
    INCREMENT,
    roundMinutes,
    toHours,
    canTransition,
    canEdit,
    validate,
};
