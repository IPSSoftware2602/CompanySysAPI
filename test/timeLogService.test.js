const test = require('node:test');
const assert = require('node:assert');
const {
    roundMinutes, toHours, canTransition, canEdit, validate, INCREMENT,
} = require('../services/timeLogService');

const entry = (minutes, user_id = 'u1', logged_for_date = '2026-08-03') =>
    ({ minutes, user_id, logged_for_date });

// ---------------------------------------------------------------- rounding

test('EXACT returns the sum untouched', () => {
    assert.strictEqual(roundMinutes([entry(7), entry(53)], 'EXACT'), 60);
});

test('EXACT does not round even awkward values', () => {
    assert.strictEqual(roundMinutes([entry(1)], 'EXACT'), 1);
});

test('NEAREST_15 rounds down below the midpoint', () => {
    assert.strictEqual(roundMinutes([entry(7)], 'NEAREST_15'), 0);
});

test('NEAREST_15 rounds up at the midpoint', () => {
    assert.strictEqual(roundMinutes([entry(8)], 'NEAREST_15'), 15);
});

test('NEAREST_15 leaves exact multiples alone', () => {
    assert.strictEqual(roundMinutes([entry(30)], 'NEAREST_15'), 30);
});

test('UP_15 always rounds up', () => {
    assert.strictEqual(roundMinutes([entry(1)], 'UP_15'), 15);
    assert.strictEqual(roundMinutes([entry(16)], 'UP_15'), 30);
});

test('UP_15 leaves exact multiples alone', () => {
    assert.strictEqual(roundMinutes([entry(45)], 'UP_15'), 45);
});

test('UP_15 rounds every entry separately — the expensive mode', () => {
    // Five 5-minute entries become five 15-minute blocks.
    const five = [entry(5), entry(5), entry(5), entry(5), entry(5)];
    assert.strictEqual(roundMinutes(five, 'UP_15'), 75);
});

test('UP_PER_DAY_15 sums the day before rounding — the fair mode', () => {
    // The same five entries: 25 minutes total, rounded up once to 30.
    const five = [entry(5), entry(5), entry(5), entry(5), entry(5)];
    assert.strictEqual(roundMinutes(five, 'UP_PER_DAY_15'), 30);
});

test('UP_PER_DAY_15 rounds each person separately', () => {
    // Two people, 5 minutes each on the same day -> 15 each, not 15 combined.
    const entries = [entry(5, 'u1'), entry(5, 'u2')];
    assert.strictEqual(roundMinutes(entries, 'UP_PER_DAY_15'), 30);
});

test('UP_PER_DAY_15 rounds each day separately', () => {
    const entries = [entry(5, 'u1', '2026-08-03'), entry(5, 'u1', '2026-08-04')];
    assert.strictEqual(roundMinutes(entries, 'UP_PER_DAY_15'), 30);
});

test('UP_PER_DAY_15 accepts Date objects as well as strings', () => {
    const entries = [
        entry(5, 'u1', new Date('2026-08-03T10:00:00Z')),
        entry(5, 'u1', '2026-08-03'),
    ];
    // Same person, same day, whatever the representation -> one 15m block.
    assert.strictEqual(roundMinutes(entries, 'UP_PER_DAY_15'), 15);
});

test('empty entry set is zero in every mode', () => {
    for (const mode of ['EXACT', 'NEAREST_15', 'UP_15', 'UP_PER_DAY_15']) {
        assert.strictEqual(roundMinutes([], mode), 0, mode);
    }
});

test('unknown rounding mode throws rather than silently mis-billing', () => {
    assert.throws(() => roundMinutes([entry(10)], 'NEAREST_7'), /Unknown rounding mode/);
});

test('the increment is a single constant', () => {
    assert.strictEqual(INCREMENT, 15);
});

// ------------------------------------------------------------------- hours

test('toHours converts to 2dp decimal hours', () => {
    assert.strictEqual(toHours(90), 1.5);
    assert.strictEqual(toHours(20), 0.33);
    assert.strictEqual(toHours(0), 0);
});

// -------------------------------------------------------------- transitions

test('draft may be submitted', () => {
    assert.strictEqual(canTransition('DRAFT', 'SUBMITTED').ok, true);
});

test('draft may not jump straight to approved', () => {
    const r = canTransition('DRAFT', 'APPROVED');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /Cannot go DRAFT -> APPROVED/);
});

test('submitted may be approved or sent back', () => {
    assert.strictEqual(canTransition('SUBMITTED', 'APPROVED').ok, true);
    assert.strictEqual(canTransition('SUBMITTED', 'DRAFT').ok, true);
});

test('approved may be locked or reopened', () => {
    assert.strictEqual(canTransition('APPROVED', 'LOCKED').ok, true);
    assert.strictEqual(canTransition('APPROVED', 'DRAFT').ok, true);
});

test('locked is terminal', () => {
    const r = canTransition('LOCKED', 'DRAFT');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /terminal/);
});

test('unknown status is rejected', () => {
    assert.strictEqual(canTransition('BOGUS', 'DRAFT').ok, false);
});

// -------------------------------------------------------------- immutability

test('draft entries are editable', () => {
    assert.strictEqual(canEdit({ status: 'DRAFT' }).ok, true);
});

test('submitted entries are still editable', () => {
    assert.strictEqual(canEdit({ status: 'SUBMITTED' }).ok, true);
});

test('approved entries are immutable', () => {
    const r = canEdit({ status: 'APPROVED' });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /correcting entry/);
});

test('locked entries are immutable', () => {
    assert.strictEqual(canEdit({ status: 'LOCKED' }).ok, false);
});

test('deleted entries are not editable', () => {
    assert.strictEqual(canEdit({ status: 'DRAFT', deleted_at: new Date() }).ok, false);
});

// --------------------------------------------------------------- validation

const valid = { minutes: 60, logged_for_date: '2026-08-03', ticket_id: 'abc' };

test('a well-formed entry validates', () => {
    assert.deepStrictEqual(validate(valid), []);
});

test('minutes must be present', () => {
    assert.ok(validate({ ...valid, minutes: undefined }).some((e) => /minutes is required/.test(e)));
});

test('minutes must be positive', () => {
    assert.ok(validate({ ...valid, minutes: 0 }).some((e) => /greater than 0/.test(e)));
    assert.ok(validate({ ...valid, minutes: -30 }).some((e) => /greater than 0/.test(e)));
});

test('minutes must be a whole number', () => {
    assert.ok(validate({ ...valid, minutes: 1.5 }).some((e) => /whole number/.test(e)));
});

test('a single entry cannot exceed 24 hours', () => {
    assert.ok(validate({ ...valid, minutes: 1441 }).some((e) => /1440/.test(e)));
});

test('logged_for_date is required', () => {
    assert.ok(validate({ ...valid, logged_for_date: null }).some((e) => /required/.test(e)));
});

test('logged_for_date must be a real date', () => {
    assert.ok(validate({ ...valid, logged_for_date: 'not-a-date' }).some((e) => /valid date/.test(e)));
});

test('logged_for_date cannot be in the future', () => {
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    assert.ok(validate({ ...valid, logged_for_date: nextYear }).some((e) => /future/.test(e)));
});

test('yesterday is fine — people log late', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    assert.deepStrictEqual(validate({ ...valid, logged_for_date: yesterday }), []);
});

test('exactly one work item is required', () => {
    assert.ok(validate({ ...valid, ticket_id: null }).some((e) => /exactly one/.test(e)));
    assert.ok(validate({ ...valid, support_ticket_id: 'def' }).some((e) => /exactly one/.test(e)));
});

test('a support-only entry validates', () => {
    assert.deepStrictEqual(
        validate({ minutes: 30, logged_for_date: '2026-08-03', support_ticket_id: 'def' }),
        []
    );
});
