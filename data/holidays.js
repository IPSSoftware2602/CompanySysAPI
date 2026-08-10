/**
 * Malaysian public holidays for the business calendar.
 *
 * Scope: federal holidays plus Federal Territory Day (KL / Putrajaya / Labuan)
 * and the KL/Selangor state holidays IPS observes. Add other state holidays if
 * you open an office elsewhere.
 *
 * 2026 variable dates were taken from two independent sources that agree in
 * full (Malaysia Public Holiday and the Malaysian Employers Federation) — see
 * VARIABLE_2026 below. 2027's lunar and Islamic dates are NOT yet filled in:
 * they are gazetted annually and must be copied from the JPM list, not
 * predicted. A confidently-wrong calendar is worse than an obviously
 * incomplete one.
 *
 *   https://www.malaysia.gov.my/portal/content/30736
 *
 * `is_company` marks IPS shutdown days that are not public holidays
 * (year-end closure, team offsites, etc).
 */

const FIXED = [
    // --- 2026 ---
    { holiday_date: '2026-01-01', name: "New Year's Day" },
    // Thaipusam also falls on 1 Feb 2026. public_holidays is keyed by date, so
    // only one row can exist — the name carries both rather than one silently
    // losing to ON CONFLICT DO NOTHING.
    { holiday_date: '2026-02-01', name: 'Federal Territory Day / Thaipusam' },
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
 * 2026 gazetted variable-date holidays. Cross-checked against two independent
 * sources which agree on every date.
 *
 * The `costsHours` note on each is the working time it actually removes from
 * the IPS calendar (Mon–Fri 9.25h, Sat 4h, Sun closed). Four of these fall on a
 * Sunday and therefore change nothing on their own — see SUBSTITUTE_CANDIDATES.
 *
 * Thaipusam is absent: it shares 1 Feb with Federal Territory Day and is
 * recorded there.
 */
const VARIABLE_2026 = [
    { holiday_date: '2026-02-17', name: 'Chinese New Year Day 1' },      // Tue, 9.25h
    { holiday_date: '2026-02-18', name: 'Chinese New Year Day 2' },      // Wed, 9.25h
    { holiday_date: '2026-03-07', name: 'Nuzul Al-Quran' },              // Sat, 4h
    { holiday_date: '2026-03-21', name: 'Hari Raya Aidilfitri Day 1' },  // Sat, 4h
    { holiday_date: '2026-03-22', name: 'Hari Raya Aidilfitri Day 2' },  // Sun, 0h
    { holiday_date: '2026-05-27', name: 'Hari Raya Haji' },              // Wed, 9.25h
    { holiday_date: '2026-05-31', name: 'Wesak Day' },                   // Sun, 0h
    { holiday_date: '2026-06-01', name: "Yang di-Pertuan Agong's Birthday" }, // Mon, 9.25h
    { holiday_date: '2026-06-17', name: 'Awal Muharram' },               // Wed, 9.25h
    { holiday_date: '2026-08-25', name: 'Maulidur Rasul' },              // Tue, 9.25h
    { holiday_date: '2026-11-08', name: 'Deepavali' },                   // Sun, 0h
];

/**
 * NOT SEEDED — needs a decision from IPS.
 *
 * Under the Employment Act 1955 a gazetted holiday falling on a rest day is
 * substituted by the next working day. Four 2026 holidays fall on a Sunday, so
 * the substitute is what actually costs working hours; the Sunday itself costs
 * nothing.
 *
 * These are company policy rather than gazetted fact, so they are deliberately
 * excluded from seedable() until confirmed. To adopt them, move the entries
 * into VARIABLE_2026 and re-run the migration.
 *
 * Note the Wesak cascade: 31 May is a Sunday, but the following working day
 * (1 Jun) is already the Agong's Birthday, so the substitute lands on 2 Jun.
 */
const SUBSTITUTE_CANDIDATES = [
    { holiday_date: '2026-02-02', name: 'Substitute for Thaipusam / FT Day (1 Feb, Sun)' },
    { holiday_date: '2026-03-23', name: 'Substitute for Hari Raya Aidilfitri Day 2 (22 Mar, Sun)' },
    { holiday_date: '2026-06-02', name: 'Substitute for Wesak Day (31 May, Sun — 1 Jun already a holiday)' },
    { holiday_date: '2026-11-09', name: 'Substitute for Deepavali (8 Nov, Sun)' },
];

/**
 * 2027 variable dates are gazetted annually and are NOT predicted here.
 * Copy them from the JPM list before January 2027 or the calendar will treat
 * Chinese New Year, both Hari Rayas and Deepavali as ordinary working days.
 */
const VARIABLE_TODO = [
    { holiday_date: null, name: 'Thaipusam (2027)' },
    { holiday_date: null, name: 'Chinese New Year Day 1 (2027)' },
    { holiday_date: null, name: 'Chinese New Year Day 2 (2027)' },
    { holiday_date: null, name: 'Nuzul Al-Quran (2027)' },
    { holiday_date: null, name: 'Hari Raya Aidilfitri Day 1 (2027)' },
    { holiday_date: null, name: 'Hari Raya Aidilfitri Day 2 (2027)' },
    { holiday_date: null, name: 'Wesak Day (2027)' },
    { holiday_date: null, name: "Agong's Birthday (2027)" },
    { holiday_date: null, name: 'Hari Raya Haji (2027)' },
    { holiday_date: null, name: 'Awal Muharram (2027)' },
    { holiday_date: null, name: 'Maulidur Rasul (2027)' },
    { holiday_date: null, name: 'Deepavali (2027)' },
];

/** Company shutdown days that are not public holidays. */
const COMPANY = [
    // { holiday_date: '2026-12-31', name: 'Year-end shutdown', is_company: true },
];

module.exports = {
    FIXED,
    VARIABLE_2026,
    SUBSTITUTE_CANDIDATES,
    VARIABLE_TODO,
    COMPANY,
    /**
     * Every entry that actually has a date and can be seeded.
     * SUBSTITUTE_CANDIDATES is excluded on purpose — it is company policy, not
     * gazetted fact, and has not been confirmed.
     */
    seedable: () =>
        [...FIXED, ...VARIABLE_2026, ...VARIABLE_TODO, ...COMPANY]
            .filter((h) => Boolean(h.holiday_date)),
    /** Entries still missing a date, for the migration to warn about. */
    missing: () => VARIABLE_TODO.filter((h) => !h.holiday_date),
    /** Unconfirmed rest-day substitutes, reported separately by the migration. */
    unconfirmedSubstitutes: () => SUBSTITUTE_CANDIDATES,
};
