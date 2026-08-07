/**
 * Malaysian public holidays for the business calendar.
 *
 * ############################################################################
 * # READ THIS BEFORE TRUSTING SLA NUMBERS                                    #
 * #                                                                          #
 * # Only FIXED-DATE holidays are seeded below. Malaysia's lunar and Islamic  #
 * # holidays (Chinese New Year, Wesak, both Hari Rayas, Deepavali, Awal      #
 * # Muharram, Maulidur Rasul, Thaipusam, Nuzul Al-Quran) move every year and #
 * # are gazetted annually by JPM. They are NOT guessed here — a wrong        #
 * # holiday date silently corrupts every SLA deadline that spans it, and a   #
 * # confidently-wrong calendar is worse than an obviously incomplete one.    #
 * #                                                                          #
 * # ACTION REQUIRED: copy the gazetted dates from                            #
 * #   https://www.malaysia.gov.my/portal/content/30736                       #
 * # into VARIABLE_TODO below (or insert straight into public_holidays), then #
 * # re-run:  node migrate_sla_v2.js                                          #
 * #                                                                          #
 * # Until then the calendar treats those days as normal working days.        #
 * ############################################################################
 *
 * Scope: federal holidays plus Federal Territory Day (KL / Putrajaya / Labuan).
 * Add state holidays for your own office location if they apply.
 *
 * `is_company` marks IPS shutdown days that are not public holidays
 * (year-end closure, team offsites, etc).
 */

const FIXED = [
    // --- 2026 ---
    { holiday_date: '2026-01-01', name: "New Year's Day" },
    { holiday_date: '2026-02-01', name: 'Federal Territory Day' },
    { holiday_date: '2026-05-01', name: 'Labour Day' },
    { holiday_date: '2026-08-31', name: 'National Day (Merdeka)' },
    { holiday_date: '2026-09-16', name: 'Malaysia Day' },
    { holiday_date: '2026-12-25', name: 'Christmas Day' },

    // --- 2027 ---
    { holiday_date: '2027-01-01', name: "New Year's Day" },
    { holiday_date: '2027-02-01', name: 'Federal Territory Day' },
    { holiday_date: '2027-05-01', name: 'Labour Day' },
    { holiday_date: '2027-08-31', name: 'National Day (Merdeka)' },
    { holiday_date: '2027-09-16', name: 'Malaysia Day' },
    { holiday_date: '2027-12-25', name: 'Christmas Day' },
];

/**
 * Fill in `holiday_date` from the official gazette and move each entry into
 * FIXED (or just add the date here — anything with a date gets seeded).
 * Entries with a null date are skipped and reported by the migration.
 */
const VARIABLE_TODO = [
    { holiday_date: null, name: 'Thaipusam (2026)' },
    { holiday_date: null, name: 'Chinese New Year Day 1 (2026)' },
    { holiday_date: null, name: 'Chinese New Year Day 2 (2026)' },
    { holiday_date: null, name: 'Nuzul Al-Quran (2026)' },
    { holiday_date: null, name: 'Hari Raya Aidilfitri Day 1 (2026)' },
    { holiday_date: null, name: 'Hari Raya Aidilfitri Day 2 (2026)' },
    { holiday_date: null, name: 'Wesak Day (2026)' },
    { holiday_date: null, name: "Agong's Birthday (2026)" },
    { holiday_date: null, name: 'Hari Raya Haji (2026)' },
    { holiday_date: null, name: 'Awal Muharram (2026)' },
    { holiday_date: null, name: 'Maulidur Rasul (2026)' },
    { holiday_date: null, name: 'Deepavali (2026)' },
];

/** Company shutdown days that are not public holidays. */
const COMPANY = [
    // { holiday_date: '2026-12-31', name: 'Year-end shutdown', is_company: true },
];

module.exports = {
    FIXED,
    VARIABLE_TODO,
    COMPANY,
    /** Every entry that actually has a date and can be seeded. */
    seedable: () =>
        [...FIXED, ...VARIABLE_TODO, ...COMPANY].filter((h) => Boolean(h.holiday_date)),
    /** Entries still missing a date, for the migration to warn about. */
    missing: () => VARIABLE_TODO.filter((h) => !h.holiday_date),
};
