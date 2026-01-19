/**
 * Calculate working hours between two dates
 * Working hours: 9am - 6pm (9 hours/day), Monday to Friday
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

    const WORK_START_HOUR = 9;
    const WORK_END_HOUR = 18; // 6pm
    const LUNCH_BREAK_HOURS = 1; // 1 hour lunch break
    const HOURS_PER_DAY = WORK_END_HOUR - WORK_START_HOUR - LUNCH_BREAK_HOURS; // 8 hours (9-6 minus 1hr lunch)

    let totalHours = 0;
    let current = new Date(start);

    // Iterate day by day
    while (current < end) {
        const dayOfWeek = current.getDay();

        // Skip weekends (0 = Sunday, 6 = Saturday)
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            const currentDateStr = current.toDateString();
            const endDateStr = end.toDateString();

            // Get working hours for this day
            let dayStart = new Date(current);
            let dayEnd = new Date(current);

            // Set to work hours boundaries
            dayStart.setHours(WORK_START_HOUR, 0, 0, 0);
            dayEnd.setHours(WORK_END_HOUR, 0, 0, 0);

            // Adjust for actual start/end times
            if (currentDateStr === new Date(start).toDateString()) {
                // First day: start from actual start time (but not before work hours)
                if (start.getHours() >= WORK_END_HOUR) {
                    dayStart = null; // No work hours on this day
                } else if (start.getHours() > WORK_START_HOUR) {
                    dayStart.setHours(start.getHours(), start.getMinutes(), 0, 0);
                }
            }

            if (currentDateStr === endDateStr) {
                // Last day: end at actual end time (but not after work hours)
                if (end.getHours() <= WORK_START_HOUR) {
                    dayEnd = null; // No work hours on this day
                } else if (end.getHours() < WORK_END_HOUR) {
                    dayEnd.setHours(end.getHours(), end.getMinutes(), 0, 0);
                }
            }

            if (dayStart && dayEnd && dayEnd > dayStart) {
                const hoursThisDay = (dayEnd - dayStart) / (1000 * 60 * 60);
                totalHours += Math.min(hoursThisDay, HOURS_PER_DAY);
            }
        }

        // Move to next day
        current.setDate(current.getDate() + 1);
        current.setHours(WORK_START_HOUR, 0, 0, 0);
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
