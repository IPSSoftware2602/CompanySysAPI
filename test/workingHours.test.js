const test = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateWorkingHours,
    calculateTicketScore,
    addWorkingHours,
    normalizeHolidays,
} = require('../utils/workingHours');

/** Build an instant from a Malaysia-local wall-clock string. */
const myt = (s) => new Date(`${s}:00+08:00`);

/** Render an instant back as Malaysia-local wall clock, for readable assertions. */
const asMyt = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

// Calendar anchors, all verified weekdays:
//   Mon 2026-08-03   Fri 2026-08-07   Sat 2026-08-08   Sun 2026-08-09   Mon 2026-08-10
//   Fri 2026-08-28   Sat 2026-08-29   Sun 2026-08-30   Mon 2026-08-31 (Merdeka)   Tue 2026-09-01
const MERDEKA = ['2026-08-31'];

test('calculateWorkingHours', async (t) => {
    await t.test('a full weekday is 9.25 hours', () => {
        assert.equal(calculateWorkingHours(myt('2026-08-03T09:00'), myt('2026-08-03T18:15')), 9.25);
    });

    await t.test('counts only the overlap within the window', () => {
        assert.equal(calculateWorkingHours(myt('2026-08-03T10:00'), myt('2026-08-03T12:00')), 2);
    });

    await t.test('clamps a start before opening time', () => {
        assert.equal(calculateWorkingHours(myt('2026-08-03T07:00'), myt('2026-08-03T10:00')), 1);
    });

    await t.test('clamps an end after closing time', () => {
        assert.equal(calculateWorkingHours(myt('2026-08-03T17:00'), myt('2026-08-03T20:00')), 1.25);
    });

    await t.test('Saturday is a 4-hour half day', () => {
        assert.equal(calculateWorkingHours(myt('2026-08-08T09:00'), myt('2026-08-08T18:00')), 4);
    });

    await t.test('Sunday contributes nothing', () => {
        assert.equal(calculateWorkingHours(myt('2026-08-09T09:00'), myt('2026-08-09T18:00')), 0);
    });

    await t.test('Friday close to Monday open is just the Saturday half day', () => {
        assert.equal(calculateWorkingHours(myt('2026-08-07T18:15'), myt('2026-08-10T09:00')), 4);
    });

    await t.test('a holiday is excluded when supplied', () => {
        const span = [myt('2026-08-31T09:00'), myt('2026-08-31T18:15')];
        assert.equal(calculateWorkingHours(...span), 9.25, 'without holidays it is a normal Monday');
        assert.equal(calculateWorkingHours(...span, MERDEKA), 0, 'with Merdeka supplied it is closed');
    });

    await t.test('holidays only subtract, never add', () => {
        const a = calculateWorkingHours(myt('2026-08-28T09:00'), myt('2026-09-01T18:15'));
        const b = calculateWorkingHours(myt('2026-08-28T09:00'), myt('2026-09-01T18:15'), MERDEKA);
        assert.equal(a - b, 9.25, 'exactly one working day removed');
    });

    await t.test('omitting holidays matches passing an empty list (back-compat)', () => {
        const args = [myt('2026-08-03T09:00'), myt('2026-09-01T18:15')];
        assert.equal(calculateWorkingHours(...args), calculateWorkingHours(...args, []));
    });

    await t.test('degenerate inputs return 0 rather than throwing', () => {
        assert.equal(calculateWorkingHours(null, myt('2026-08-03T10:00')), 0);
        assert.equal(calculateWorkingHours(myt('2026-08-03T10:00'), null), 0);
        assert.equal(calculateWorkingHours(myt('2026-08-03T12:00'), myt('2026-08-03T10:00')), 0, 'end before start');
        assert.equal(calculateWorkingHours('not a date', myt('2026-08-03T10:00')), 0);
    });
});

test('addWorkingHours', async (t) => {
    await t.test('adds within a single day', () => {
        assert.equal(asMyt(addWorkingHours(myt('2026-08-03T09:00'), 2)), '2026-08-03 11:00');
    });

    await t.test('rolls over the end of the working day', () => {
        // 17:00 -> 18:15 spends 1.25h, the remaining 0.75h lands next morning.
        assert.equal(asMyt(addWorkingHours(myt('2026-08-03T17:00'), 2)), '2026-08-04 09:45');
    });

    await t.test('rolls a Saturday overflow across the closed Sunday', () => {
        // Sat 12:00 -> 13:00 is 1h, remaining 1h resumes Monday morning.
        assert.equal(asMyt(addWorkingHours(myt('2026-08-08T12:00'), 2)), '2026-08-10 10:00');
    });

    await t.test('a start outside working hours rolls forward to the next open window', () => {
        assert.equal(asMyt(addWorkingHours(myt('2026-08-09T12:00'), 0)), '2026-08-10 09:00', 'Sunday');
        assert.equal(asMyt(addWorkingHours(myt('2026-08-03T07:00'), 0)), '2026-08-03 09:00', 'before opening');
        assert.equal(asMyt(addWorkingHours(myt('2026-08-03T21:00'), 0)), '2026-08-04 09:00', 'after closing');
    });

    await t.test('zero hours inside the window is a no-op', () => {
        assert.equal(asMyt(addWorkingHours(myt('2026-08-03T11:30'), 0)), '2026-08-03 11:30');
    });

    await t.test('skips a holiday that lands mid-span', () => {
        // Fri 17:00 +8h: Fri 1.25 + Sat 4 = 5.25, remaining 2.75.
        // Sun closed; Mon 31st is Merdeka; so it lands Tuesday 09:00 + 2.75h.
        assert.equal(
            asMyt(addWorkingHours(myt('2026-08-28T17:00'), 8, MERDEKA)),
            '2026-09-01 11:45'
        );
        // Same span without the holiday finishes a day earlier.
        assert.equal(
            asMyt(addWorkingHours(myt('2026-08-28T17:00'), 8)),
            '2026-08-31 11:45'
        );
    });

    await t.test('rejects invalid input instead of returning a wrong deadline', () => {
        assert.throws(() => addWorkingHours(myt('2026-08-03T09:00'), -1), TypeError);
        assert.throws(() => addWorkingHours('not a date', 4), TypeError);
        assert.throws(() => addWorkingHours(myt('2026-08-03T09:00'), NaN), TypeError);
    });
});

test('addWorkingHours is the inverse of calculateWorkingHours', async (t) => {
    // The property that matters: if a deadline is N working hours away, then
    // exactly N working hours elapse between now and it. Any disagreement
    // between the two functions would make SLA % consumed drift from the deadline.
    const starts = [
        '2026-08-03T09:00', // Monday, window open
        '2026-08-03T17:30', // late weekday, forces rollover
        '2026-08-07T18:14', // one minute before Friday close
        '2026-08-08T12:30', // Saturday half day
        '2026-08-09T12:00', // Sunday, closed
        '2026-08-28T16:00', // Friday before a weekend + holiday
    ];
    const hourValues = [0.5, 1, 4, 8, 9.25, 24, 40, 80];

    for (const s of starts) {
        for (const h of hourValues) {
            await t.test(`${s} + ${h}h round-trips`, () => {
                const end = addWorkingHours(myt(s), h, MERDEKA);
                const elapsed = calculateWorkingHours(myt(s), end, MERDEKA);
                assert.equal(elapsed, h);
            });
        }
    }
});

test('normalizeHolidays', async (t) => {
    await t.test('accepts strings, Dates and pg rows alike', () => {
        const set = normalizeHolidays([
            '2026-08-31',
            '2026-09-16T00:00:00.000Z',
            { holiday_date: '2026-12-25' },
            new Date('2026-05-01T04:00:00+08:00'),
        ]);
        assert.ok(set.has('2026-08-31'));
        assert.ok(set.has('2026-09-16'));
        assert.ok(set.has('2026-12-25'));
        assert.ok(set.has('2026-05-01'));
    });

    await t.test('ignores empty and malformed entries', () => {
        assert.equal(normalizeHolidays([null, undefined, '', { holiday_date: null }]).size, 0);
        assert.equal(normalizeHolidays(undefined).size, 0);
        assert.equal(normalizeHolidays('2026-08-31').size, 0, 'a bare string is not a list');
    });

    await t.test('a date-only string is not shifted by timezone', () => {
        // The bug this guards: parsing '2026-08-31' as UTC midnight then shifting
        // to MYT would move the holiday to the 31st 08:00 and, for negative
        // offsets, to the wrong calendar day entirely.
        assert.ok(normalizeHolidays(['2026-08-31']).has('2026-08-31'));
    });
});

test('calculateTicketScore stays holiday-blind by default', async (t) => {
    await t.test('existing two-argument calls are unchanged', () => {
        // Credit is working hours x 10. This is the regression guard for the
        // decision to keep credit figures identical while SLA gains holidays.
        assert.equal(calculateTicketScore(myt('2026-08-31T09:00'), myt('2026-08-31T18:15')), 92.5);
    });

    await t.test('holidays apply only when explicitly opted in', () => {
        assert.equal(calculateTicketScore(myt('2026-08-31T09:00'), myt('2026-08-31T18:15'), 10, MERDEKA), 0);
    });
});
