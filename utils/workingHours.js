/**
 * Calculate working hours between two dates
 * Working hours: 
 * Mon-Fri: 9:00am - 6:15pm (9.25 hours) - No lunch break deduction
 * Sat: 9:00am - 1:00pm (4 hours)
 * Sun: Off
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

    // Working periods configuration
    // Mon-Fri
    const WEEKDAY_START_HOUR = 9;
    const WEEKDAY_START_MIN = 0;
    const WEEKDAY_END_HOUR = 18;
    const WEEKDAY_END_MIN = 15; // 6:15 PM

    // Saturday
    const SAT_START_HOUR = 9;
    const SAT_START_MIN = 0;
    const SAT_END_HOUR = 13;
    const SAT_END_MIN = 0; // 1:00 PM

    /**
     * Calculate hours within a specific work window for a given day
     */
    function getHoursInDay(dayDate, startHour, startMin, endHour, endMin, actualStart, actualEnd) {
        const periodStartTime = new Date(dayDate);
        periodStartTime.setHours(startHour, startMin, 0, 0);

        const periodEndTime = new Date(dayDate);
        periodEndTime.setHours(endHour, endMin, 0, 0);

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

        // Check if working day (Mon-Sat)
        if (dayOfWeek !== 0) { // 0 is Sunday
            // Determine actual start and end for this day
            const dayStart = new Date(current);
            dayStart.setHours(0, 0, 0, 0);

            const dayEnd = new Date(current);
            dayEnd.setHours(23, 59, 59, 999);

            // Effective boundaries for this day
            const effectiveDayStart = start > dayStart ? start : dayStart;
            const effectiveDayEnd = end < dayEnd ? end : dayEnd;

            if (effectiveDayEnd > effectiveDayStart) {
                if (dayOfWeek === 6) {
                    // Saturday: 9am - 1pm
                    totalHours += getHoursInDay(
                        current,
                        SAT_START_HOUR, SAT_START_MIN,
                        SAT_END_HOUR, SAT_END_MIN,
                        effectiveDayStart, effectiveDayEnd
                    );
                } else {
                    // Mon-Fri: 9am - 6:15pm
                    totalHours += getHoursInDay(
                        current,
                        WEEKDAY_START_HOUR, WEEKDAY_START_MIN,
                        WEEKDAY_END_HOUR, WEEKDAY_END_MIN,
                        effectiveDayStart, effectiveDayEnd
                    );
                }
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
