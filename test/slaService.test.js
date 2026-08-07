const test = require('node:test');
const assert = require('node:assert/strict');

const {
    computeDeadlines,
    pauseDebitHours,
    consumption,
    slaStatus,
    DEFAULT_TARGETS,
} = require('../services/slaService');

const myt = (s) => new Date(`${s}:00+08:00`);
const asMyt = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

const MERDEKA = ['2026-08-31'];

test('computeDeadlines', async (t) => {
    await t.test('P1 from Monday morning, in business hours', () => {
        const d = computeDeadlines({ priority: 'P1', startAt: myt('2026-08-03T09:00') });
        // first response 4h -> same morning
        assert.equal(asMyt(d.first_response_due_at), '2026-08-03 13:00');
        // resolution 24 business hours = Mon 9.25 + Tue 9.25 + Wed 5.5
        assert.equal(asMyt(d.resolution_due_at), '2026-08-05 14:30');
    });

    await t.test('P0 raised late Friday does not breach over the weekend', () => {
        // The bug in the old wall-clock calculateSLA(): P0 = 2 calendar hours,
        // so a Friday 17:30 ticket was breached before Saturday breakfast.
        const d = computeDeadlines({ priority: 'P0', startAt: myt('2026-08-07T17:30') });
        assert.equal(asMyt(d.first_response_due_at), '2026-08-08 09:15',
            'rolls into Saturday morning, not Friday 19:30');
    });

    await t.test('honours supplied holidays', () => {
        const withHoliday = computeDeadlines({
            priority: 'P0', startAt: myt('2026-08-28T17:00'), holidays: MERDEKA,
        });
        const without = computeDeadlines({
            priority: 'P0', startAt: myt('2026-08-28T17:00'),
        });
        assert.notEqual(
            withHoliday.resolution_due_at.getTime(),
            without.resolution_due_at.getTime()
        );
    });

    await t.test('accepts custom targets from the sla_targets table', () => {
        const d = computeDeadlines({
            priority: 'P2',
            startAt: myt('2026-08-03T09:00'),
            targets: { P2: { first_response_hours: 2, resolution_hours: 4 } },
        });
        assert.equal(asMyt(d.first_response_due_at), '2026-08-03 11:00');
        assert.equal(asMyt(d.resolution_due_at), '2026-08-03 13:00');
    });

    await t.test('throws rather than inventing a deadline for an unknown priority', () => {
        assert.throws(
            () => computeDeadlines({ priority: 'P9', startAt: myt('2026-08-03T09:00') }),
            /no SLA target configured/
        );
    });

    await t.test('every configured priority has a default', () => {
        for (const p of ['P0', 'P1', 'P2', 'P3']) {
            assert.ok(DEFAULT_TARGETS[p], `${p} must have a fallback target`);
            assert.ok(DEFAULT_TARGETS[p].first_response_hours < DEFAULT_TARGETS[p].resolution_hours);
        }
    });
});

test('pauseDebitHours', async (t) => {
    await t.test('counts only business hours inside the pause', () => {
        // Fri 17:00 -> Mon 10:00 = Fri 1.25 + Sat 4 + Mon 1
        assert.equal(pauseDebitHours(myt('2026-08-07T17:00'), myt('2026-08-10T10:00')), 6.25);
    });

    await t.test('a pause entirely over a weekend costs the customer nothing', () => {
        assert.equal(pauseDebitHours(myt('2026-08-09T09:00'), myt('2026-08-09T18:00')), 0);
    });

    await t.test('an unresolved pause debits nothing yet', () => {
        assert.equal(pauseDebitHours(myt('2026-08-03T09:00'), null), 0);
        assert.equal(pauseDebitHours(null, myt('2026-08-03T09:00')), 0);
    });
});

test('consumption', async (t) => {
    await t.test('reports percentage against target', () => {
        const c = consumption({
            startAt: myt('2026-08-03T09:00'),
            stopAt: myt('2026-08-03T13:00'),
            targetHours: 8,
        });
        assert.equal(c.consumedHours, 4);
        assert.equal(c.pct, 50);
        assert.equal(c.breached, false);
    });

    await t.test('flags a breach past 100%', () => {
        const c = consumption({
            startAt: myt('2026-08-03T09:00'),
            stopAt: myt('2026-08-04T13:00'),
            targetHours: 8,
        });
        assert.ok(c.consumedHours > 8);
        assert.equal(c.breached, true);
    });

    await t.test('paused hours are excluded', () => {
        const args = {
            startAt: myt('2026-08-03T09:00'),
            stopAt: myt('2026-08-03T17:00'),
            targetHours: 8,
        };
        assert.equal(consumption(args).consumedHours, 8);
        assert.equal(consumption({ ...args, pausedHours: 3 }).consumedHours, 5);
    });

    await t.test('never reports negative consumption', () => {
        const c = consumption({
            startAt: myt('2026-08-03T09:00'),
            stopAt: myt('2026-08-03T11:00'),
            targetHours: 8,
            pausedHours: 99,
        });
        assert.equal(c.consumedHours, 0);
    });
});

test('slaStatus', async (t) => {
    const baseTicket = {
        priority: 'P0', // 1h first response, 8h resolution
        start_date: myt('2026-08-03T09:00'),
        status: 'DOING',
        first_response_at: null,
        sla_paused_total_minutes: 0,
        actual_end_date: null,
        closed_at: null,
        first_response_due_at: myt('2026-08-03T10:00'),
        resolution_due_at: myt('2026-08-03T17:15'),
    };
    const now = myt('2026-08-03T12:00');

    await t.test('an unanswered ticket past target is a first-response breach', () => {
        const s = slaStatus(baseTicket, { now });
        assert.equal(s.firstResponse.consumedHours, 3);
        assert.equal(s.firstResponse.breached, true);
        assert.equal(s.firstResponse.met, false);
        assert.equal(s.resolution.pct, 37.5, '3 of 8 hours');
        assert.equal(s.resolution.breached, false);
    });

    await t.test('a reply inside target marks first response met and stops that clock', () => {
        const s = slaStatus(
            { ...baseTicket, first_response_at: myt('2026-08-03T09:30') },
            { now }
        );
        assert.equal(s.firstResponse.met, true);
        assert.equal(s.firstResponse.consumedHours, 0.5, 'clock stops at the reply, not now');
        assert.equal(s.firstResponse.breached, false);
    });

    await t.test('pausing does NOT rescue a missed first response', () => {
        // The anti-gaming rule: parking a new ticket in WAITING_FOR_CLIENT must
        // not stop the first-response clock.
        const s = slaStatus(
            { ...baseTicket, sla_paused_total_minutes: 120 },
            { now, openPause: { paused_at: myt('2026-08-03T10:00') } }
        );
        assert.equal(s.firstResponse.consumedHours, 3, 'unaffected by the pause');
        assert.equal(s.firstResponse.breached, true);
        assert.ok(s.resolution.consumedHours < 3, 'resolution clock IS reduced');
    });

    await t.test('an open pause is debited live, not just on resume', () => {
        const s = slaStatus(baseTicket, {
            now,
            openPause: { paused_at: myt('2026-08-03T10:00') },
        });
        // 3h elapsed, 2h of it paused
        assert.equal(s.resolution.consumedHours, 1);
        assert.equal(s.resolution.isPaused, true);
    });

    await t.test('a completed ticket stops its resolution clock at completion', () => {
        const s = slaStatus(
            {
                ...baseTicket,
                status: 'COMPLETED',
                first_response_at: myt('2026-08-03T09:30'),
                actual_end_date: myt('2026-08-03T15:00'),
            },
            { now: myt('2026-08-31T09:00') } // long after the fact
        );
        assert.equal(s.resolution.consumedHours, 6, 'measured to completion, not to now');
        assert.equal(s.resolution.breached, false);
    });

    await t.test('needsAttention fires at the warning threshold, not only on breach', () => {
        const calm = slaStatus(
            { ...baseTicket, first_response_at: myt('2026-08-03T09:15') },
            { now: myt('2026-08-03T10:00') }
        );
        assert.equal(calm.needsAttention, false);

        const warm = slaStatus(
            { ...baseTicket, first_response_at: myt('2026-08-03T09:15') },
            { now: myt('2026-08-03T16:00') } // 7 of 8 resolution hours = 87.5%
        );
        assert.equal(warm.needsAttention, true);
    });

    await t.test('a paused ticket is not nagged about resolution', () => {
        const s = slaStatus(
            { ...baseTicket, first_response_at: myt('2026-08-03T09:15') },
            { now: myt('2026-08-03T16:00'), openPause: { paused_at: myt('2026-08-03T09:30') } }
        );
        assert.equal(s.resolution.isPaused, true);
        assert.equal(s.needsAttention, false);
    });

    await t.test('falls back to created_at when start_date is missing', () => {
        const s = slaStatus(
            { ...baseTicket, start_date: null, created_at: myt('2026-08-03T09:00') },
            { now }
        );
        assert.equal(s.resolution.consumedHours, 3);
    });
});
