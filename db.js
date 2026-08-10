require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool, types } = require('pg');

/**
 * Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date objects.
 *
 * A DATE has no time and no timezone, but node-pg builds a Date at LOCAL
 * midnight. Serialized to JSON that becomes the previous day in any zone east
 * of UTC: in MYT (UTC+8), logged_for_date 2026-08-10 left the API as
 * "2026-08-09T16:00:00.000Z". The timesheet grouped an entry under the wrong
 * day, and — more seriously — work logged on the 1st of a month would have
 * reported inside the previous month's billing period.
 *
 * Affects credit_evaluations.period_month, public_holidays.holiday_date and
 * work_time_logs.logged_for_date. normalizeHolidays() and roundMinutes()
 * already accept either form, and both have tests covering it.
 */
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'ios_db',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool: pool
};
