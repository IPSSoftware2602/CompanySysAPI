const test = require('node:test');
const assert = require('node:assert/strict');

const { parseKey, KEY_PREFIX } = require('../services/apiKeyService');

const hex = (n) => 'a'.repeat(n);
const validKey = `${KEY_PREFIX}_${hex(8)}_${hex(48)}`;

/**
 * parseKey is the gate in front of the database and bcrypt: anything it rejects
 * costs one string operation instead of a query and a hash comparison. It is
 * also the only pure part of key handling, so it is where the format rules are
 * pinned.
 */
test('parseKey', async (t) => {
    await t.test('accepts a well-formed key', () => {
        const parsed = parseKey(validKey);
        assert.equal(parsed.prefix, `${KEY_PREFIX}_${hex(8)}`);
        assert.equal(parsed.secret, hex(48));
    });

    await t.test('the returned prefix is what the database is keyed by', () => {
        // Prefix includes the scheme, so a lookup cannot collide with another
        // credential type added later.
        assert.ok(parseKey(validKey).prefix.startsWith(`${KEY_PREFIX}_`));
    });

    await t.test('rejects a foreign scheme', () => {
        assert.equal(parseKey(`sk_${hex(8)}_${hex(48)}`), null);
    });

    await t.test('rejects wrong segment counts', () => {
        assert.equal(parseKey(`${KEY_PREFIX}_${hex(8)}`), null);
        assert.equal(parseKey(`${KEY_PREFIX}_${hex(8)}_${hex(48)}_extra`), null);
    });

    await t.test('rejects a wrong-length prefix or secret', () => {
        assert.equal(parseKey(`${KEY_PREFIX}_${hex(7)}_${hex(48)}`), null);
        assert.equal(parseKey(`${KEY_PREFIX}_${hex(8)}_${hex(47)}`), null);
    });

    await t.test('rejects non-hex characters', () => {
        assert.equal(parseKey(`${KEY_PREFIX}_${'g'.repeat(8)}_${hex(48)}`), null);
        assert.equal(parseKey(`${KEY_PREFIX}_${hex(8)}_${'z'.repeat(48)}`), null);
    });

    await t.test('rejects uppercase hex — the format is one canonical form', () => {
        assert.equal(parseKey(`${KEY_PREFIX}_${'A'.repeat(8)}_${hex(48)}`), null);
    });

    await t.test('tolerates surrounding whitespace', () => {
        assert.ok(parseKey(`  ${validKey}\n`));
    });

    await t.test('rejects non-strings without throwing', () => {
        for (const bad of [null, undefined, 42, {}, [], true]) {
            assert.equal(parseKey(bad), null, String(bad));
        }
    });

    await t.test('rejects the empty string', () => {
        assert.equal(parseKey(''), null);
    });

    await t.test('rejects a SQL-injection-shaped value before it reaches the database', () => {
        assert.equal(parseKey("csk_' OR 1=1 --_x"), null);
    });
});
