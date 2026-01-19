/**
 * Calculate working hours between two dates
 * Working hours: 9am - 1pm (4 hours) + 2pm - 6pm (4 hours) = 8 hours/day
 * Monday to Friday only
 * @param {Date|string} startDate 
 * @param {Date|string} endDate 
 * @returns {number} Total working hours
 */
function calculateWorkingHours(startDate, endDate) {
    if (!startDate || !endDate) return 0;

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
    if (end <= start) return 0;

    // Working periods: 9am-1pm (morning) and 2pm-6pm (afternoon)
    const MORNING_START = 9;
    const MORNING_END = 13;   // 1pm
    const AFTERNOON_START = 14; // 2pm
    const AFTERNOON_END = 18;   // 6pm

    /**
     * Calculate hours within a specific work period for a given day
     */
    function getHoursInPeriod(dayDate, periodStart, periodEnd, actualStart, actualEnd) {
        const periodStartTime = new Date(dayDate);
        periodStartTime.setHours(periodStart, 0, 0, 0);

        const periodEndTime = new Date(dayDate);
        periodEndTime.setHours(periodEnd, 0, 0, 0);

        // Clamp to actual start/end times
        const effectiveStart = actualStart > periodStartTime ? actualStart : periodStartTime;
        const effectiveEnd = actualEnd < periodEndTime ? actualEnd : periodEndTime;

        if (effectiveEnd <= effectiveStart) return 0;
        if (effectiveStart >= periodEndTime) return 0;
        if (effectiveEnd <= periodStartTime) return 0;

        return (effectiveEnd - effectiveStart) / (1000 * 60 * 60);
    }

    let totalHours = 0;
    let current = new Date(start);
    current.setHours(0, 0, 0, 0); // Start of day

    const endOfLastDay = new Date(end);
    endOfLastDay.setHours(23, 59, 59, 999);

    // Iterate day by day
    while (current <= endOfLastDay) {
        const dayOfWeek = current.getDay();

        // Skip weekends (0 = Sunday, 6 = Saturday)
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            // Determine actual start and end for this day
            const dayStart = new Date(current);
            dayStart.setHours(0, 0, 0, 0);

            const dayEnd = new Date(current);
            dayEnd.setHours(23, 59, 59, 999);

            // Effective boundaries for this day
            const effectiveDayStart = start > dayStart ? start : dayStart;
            const effectiveDayEnd = end < dayEnd ? end : dayEnd;

            if (effectiveDayEnd > effectiveDayStart) {
                // Calculate morning period (9am - 1pm)
                const morningHours = getHoursInPeriod(current, MORNING_START, MORNING_END, effectiveDayStart, effectiveDayEnd);

                // Calculate afternoon period (2pm - 6pm)
                const afternoonHours = getHoursInPeriod(current, AFTERNOON_START, AFTERNOON_END, effectiveDayStart, effectiveDayEnd);

                totalHours += morningHours + afternoonHours;
            }
        }

        // Move to next day
        current.setDate(current.getDate() + 1);
    }

    return Math.round(totalHours * 100) / 100; // Round to 2 decimal places
}

/**
 * Calculate ticket score based on working hours
 * @param {Date|string} startDate 
 * @param {Date|string} endDate 
 * @param {number} marksPerHour - Default 10
 * @returns {number} Ticket score
 */
function calculateTicketScore(startDate, endDate, marksPerHour = 10) {
    const hours = calculateWorkingHours(startDate, endDate);
    return hours * marksPerHour;
}

module.exports = {
    calculateWorkingHours,
    calculateTicketScore
};
