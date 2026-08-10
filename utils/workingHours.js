/**
 * Business calendar — the single source of truth for "how much working time
 * elapsed" and "when is N working hours from now".
 *
 * Working hours (Malaysia Time, UTC+8, regardless of server timezone):
 *   Mon-Fri  09:00 - 18:15  (9.25 h)  — no lunch deduction
 *   Sat      09:00 - 13:00  (4 h)
 *   Sun      closed
 *   Public / company holidays: closed (supplied by the caller)
 *
 * Holidays are INJECTED, never queried here. That keeps every function in this
 * module pure and unit-testable without a database, and lets the credit path
 * stay holiday-blind (it passes nothing) while SLA passes the real list.
 *
 * `holidays` accepts 'YYYY-MM-DD' strings, Date objects, or rows shaped like
 * { holiday_date }. Anything falsy is ignored.
 */

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

// Work windows keyed by day-of-week (0 = Sunday). null = closed.
const WORK_WINDOWS = {
    0: null,
    1: { startHour: 9, startMin: 0, endHour: 18, endMin: 15 },
    2: { startHour: 9, startMin: 0, endHour: 18, endMin: 15 },
    3: { startHour: 9, startMin: 0, endHour: 18, endMin: 15 },
    4: { startHour: 9, startMin: 0, endHour: 18, endMin: 15 },
    5: { startHour: 9, startMin: 0, endHour: 18, endMin: 15 },
    6: { startHour: 9, startMin: 0, endHour: 13, endMin: 0 },
};

// Safety rail for addWorkingHours: ~10 years of calendar days. A request that
// walks past this means the caller passed a nonsensical target.
const MAX_HORIZON_DAYS = 3650;

/** Shift an instant into "MYT space" so UTC getters read as Malaysia local time. */
function toMyt(date) {
    return new Date(new Date(date).getTime() + MYT_OFFSET_MS);
}

/** Shift back out of MYT space into a real UTC instant. */
function fromMyt(mytDate) {
    return new Date(mytDate.getTime() - MYT_OFFSET_MS);
}

/** 'YYYY-MM-DD' for a date already in MYT space. */
function mytDateKey(mytDate) {
    const y = mytDate.getUTCFullYear();
    const m = String(mytDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(mytDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Normalise a holiday list into a Set of 'YYYY-MM-DD' keys.
 * @param {Array<string|Date|{holiday_date: string|Date}>} [holidays]
 * @returns {Set<string>}
 */
function normalizeHolidays(holidays) {
    const set = new Set();
    if (!Array.isArray(holidays)) return set;

    for (const entry of holidays) {
        if (!entry) continue;
        const raw = typeof entry === 'object' && !(entry instanceof Date)
            ? entry.holiday_date
            : entry;
        if (!raw) continue;

        if (typeof raw === 'string') {
            // Already a date-only string, or an ISO timestamp we trim.
            // A bare 'YYYY-MM-DD' is a calendar date, not an instant — take it verbatim
            // rather than parsing it into UTC midnight and shifting it a day.
            set.add(raw.slice(0, 10));
        } else {
            const asDate = raw instanceof Date ? raw : new Date(raw);
            if (!isNaN(asDate.getTime())) set.add(mytDateKey(toMyt(asDate)));
        }
    }
    return set;
}

/** Is this MYT-space day a working day (not Sunday, not a holiday)? */
function isWorkingMytDay(mytDayStart, holidaySet) {
    if (!WORK_WINDOWS[mytDayStart.getUTCDay()]) return false;
    return !holidaySet.has(mytDateKey(mytDayStart));
}

/**
 * Total working hours between two instants.
 *
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @param {Array} [holidays=[]] - omit to ignore holidays entirely (legacy behaviour)
 * @returns {number} working hours, rounded to 2dp
 */
function calculateWorkingHours(startDate, endDate, holidays = []) {
    if (!startDate || !endDate) return 0;

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    if (end <= start) return 0;

    const holidaySet = normalizeHolidays(holidays);
    const startMYT = toMyt(start);
    const endMYT = toMyt(end);

    let totalHours = 0;

    const current = new Date(startMYT);
    current.setUTCHours(0, 0, 0, 0);

    const endOfLastDay = new Date(endMYT);
    endOfLastDay.setUTCHours(23, 59, 59, 999);

    while (current <= endOfLastDay) {
        const window = WORK_WINDOWS[current.getUTCDay()];

        if (window && !holidaySet.has(mytDateKey(current))) {
            const periodStart = new Date(current);
            periodStart.setUTCHours(window.startHour, window.startMin, 0, 0);

            const periodEnd = new Date(current);
            periodEnd.setUTCHours(window.endHour, window.endMin, 0, 0);

            // Clamp the work window to the requested span.
            const effectiveStart = startMYT > periodStart ? startMYT : periodStart;
            const effectiveEnd = endMYT < periodEnd ? endMYT : periodEnd;

            if (effectiveEnd > effectiveStart) {
                totalHours += (effectiveEnd - effectiveStart) / (1000 * 60 * 60);
            }
        }

        current.setUTCDate(current.getUTCDate() + 1);
    }

    return Math.round(totalHours * 100) / 100;
}

/**
 * The instant that is `hours` working hours after `startDate`.
 *
 * If the start falls outside a work window it is first rolled forward to the
 * next working instant, so `addWorkingHours(sundayNoon, 0)` is Monday 09:00.
 * This is the inverse of calculateWorkingHours and is what produces SLA deadlines.
 *
 * @param {Date|string} startDate
 * @param {number} hours - must be >= 0
 * @param {Array} [holidays=[]]
 * @returns {Date} a real UTC instant
 */
function addWorkingHours(startDate, hours, holidays = []) {
    const start = new Date(startDate);
    if (isNaN(start.getTime())) throw new TypeError('addWorkingHours: invalid startDate');
    if (typeof hours !== 'number' || isNaN(hours) || hours < 0) {
        throw new TypeError('addWorkingHours: hours must be a non-negative number');
    }

    const holidaySet = normalizeHolidays(holidays);
    let remainingMs = hours * 60 * 60 * 1000;

    let cursor = toMyt(start);
    const day = new Date(cursor);
    day.setUTCHours(0, 0, 0, 0);

    for (let guard = 0; guard < MAX_HORIZON_DAYS; guard++) {
        const window = WORK_WINDOWS[day.getUTCDay()];

        if (window && !holidaySet.has(mytDateKey(day))) {
            const windowStart = new Date(day);
            windowStart.setUTCHours(window.startHour, window.startMin, 0, 0);

            const windowEnd = new Date(day);
            windowEnd.setUTCHours(window.endHour, window.endMin, 0, 0);

            // Never start before the window opens.
            const from = cursor > windowStart ? cursor : windowStart;

            if (from < windowEnd) {
                const availableMs = windowEnd - from;
                if (remainingMs <= availableMs) {
                    return fromMyt(new Date(from.getTime() + remainingMs));
                }
                remainingMs -= availableMs;
            }
        }

        day.setUTCDate(day.getUTCDate() + 1);
        day.setUTCHours(0, 0, 0, 0);
        cursor = new Date(day);
    }

    throw new RangeError(
        `addWorkingHours: ${hours}h exceeds the ${MAX_HORIZON_DAYS}-day horizon from ${start.toISOString()}`
    );
}

/**
 * Legacy credit scoring: working hours x marks-per-hour.
 *
 * Deliberately called WITHOUT holidays so existing credit figures are unchanged
 * by the SLA work. Pass a holiday list explicitly if/when credit v2 opts in.
 *
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @param {number} [marksPerHour=10]
 * @param {Array} [holidays=[]]
 * @returns {number}
 */
function calculateTicketScore(startDate, endDate, marksPerHour = 10, holidays = []) {
    const hours = calculateWorkingHours(startDate, endDate, holidays);
    return hours * marksPerHour;
}

module.exports = {
    calculateWorkingHours,
    calculateTicketScore,
    addWorkingHours,
    normalizeHolidays,
    isWorkingMytDay,
    toMyt,
    mytDateKey,
    WORK_WINDOWS,
    MYT_OFFSET_MS,
};
