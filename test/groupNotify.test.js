const { test, describe } = require('node:test');
const assert = require('node:assert');
const GroupNotify = require('../services/groupNotifyService');

/**
 * The WATO contract, pinned.
 *
 * Every assertion here was learned from WATO's own validation error rather than
 * guessed, and each one cost a round trip to find. A regression would look like
 * "notifications silently stopped", which is exactly the failure nobody
 * notices — hence the test.
 */
describe('WATO recipient normalisation', () => {
    test('a personal JID is reduced to bare digits', () => {
        // WATO rejects the JID form: "Invalid number or lid format".
        assert.equal(GroupNotify.normaliseRecipient('601155849969@s.whatsapp.net'), '601155849969');
    });

    test('a group JID is reduced to bare digits', () => {
        assert.equal(GroupNotify.normaliseRecipient('120363046735396444@g.us'), '120363046735396444');
    });

    test('punctuation people paste from a phone book is stripped', () => {
        assert.equal(GroupNotify.normaliseRecipient('+60 11-5584 9969'), '601155849969');
    });

    test('a lid keeps its digits', () => {
        assert.equal(GroupNotify.normaliseRecipient('12345@lid'), '12345');
    });

    test('empty stays empty rather than becoming a plausible recipient', () => {
        assert.equal(GroupNotify.normaliseRecipient(''), '');
        assert.equal(GroupNotify.normaliseRecipient(null), '');
    });
});

describe('WATO recipient lists', () => {
    test('splits on commas and newlines, cleaning each entry', () => {
        assert.deepEqual(
            GroupNotify.normaliseRecipients('601155849969@s.whatsapp.net, 60123456789\n+60 12 345 6780'),
            ['601155849969', '60123456789', '60123456780']
        );
    });

    test('does NOT split on spaces — a pasted number contains them', () => {
        // "+60 11-5584 9969" split on whitespace became four bogus recipients.
        assert.deepEqual(GroupNotify.normaliseRecipients('+60 11-5584 9969'), ['601155849969']);
    });

    test('the same number twice is sent to once', () => {
        assert.deepEqual(
            GroupNotify.normaliseRecipients('601155849969, 601155849969@s.whatsapp.net'),
            ['601155849969']
        );
    });

    test('nothing configured yields no recipients, not a blank one', () => {
        assert.deepEqual(GroupNotify.normaliseRecipients(''), []);
        assert.deepEqual(GroupNotify.normaliseRecipients(null), []);
    });
});

describe('WATO request shape', () => {
    test('token goes in the body, the text field is "message", to is bare digits', async () => {
        let captured = null;
        const fetchImpl = async (url, opts) => {
            captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
            return { ok: true, status: 200, text: async () => '{"result":"queued"}' };
        };

        const res = await GroupNotify.send(
            { message: 'hello', group_id: '601155849969@s.whatsapp.net' },
            { fetchImpl, settings: { url: 'https://example.test/send', token: 'tok', groupId: null } }
        );

        assert.equal(res.ok, true);
        assert.equal(captured.url, 'https://example.test/send');
        // In the body, NOT an Authorization header — WATO returned
        // "token: Required" when it was only sent as a header.
        assert.equal(captured.body.token, 'tok');
        assert.equal(captured.headers.Authorization, undefined);
        assert.equal(captured.body.message, 'hello');
        assert.equal(captured.body.to, '601155849969');
    });

    test('no send is attempted when the token is missing', async () => {
        let called = false;
        const res = await GroupNotify.send(
            { message: 'x', group_id: '601155849969' },
            { fetchImpl: async () => { called = true; }, settings: { url: 'https://e.test', token: null } }
        );
        assert.equal(called, false);
        assert.equal(res.skipped, true);
    });
});

describe('the message template', () => {
    test('a line whose placeholders are all empty is dropped', () => {
        const out = GroupNotify.renderTemplate('A: {a}\nB: {b}\nC', { a: 'x', b: '' });
        assert.equal(out, 'A: x\nC');
    });

    test('a line keeps the values it does have', () => {
        assert.equal(GroupNotify.renderTemplate('{a} · {b}', { a: 'Project', b: '' }), 'Project');
    });

    test('a stranded separator is tidied from either end', () => {
        assert.equal(GroupNotify.renderTemplate('{a} · {b}', { a: '', b: 'Company' }), 'Company');
    });

    test('literal text with no placeholders always survives', () => {
        assert.equal(GroupNotify.renderTemplate('Hello\n{x}', { x: '' }), 'Hello');
    });

    test('an unknown placeholder is treated as empty, dropping its line', () => {
        // Consistent with the rule above: the line's only placeholder resolved
        // to nothing, so the line goes. It does not throw and does not leak
        // "{nope}" into a customer-visible message.
        assert.equal(GroupNotify.renderTemplate('{nope}!', {}), '');
        // ...but a line that also carries a real value keeps it.
        assert.equal(GroupNotify.renderTemplate('{nope}{ticket_key}', { ticket_key: 'SC-1' }), 'SC-1');
    });

    test('no template falls back to the default', () => {
        const t = { ticket_key: 'SC-1', title: 'T', priority: 'P1', request_type: 'BUG' };
        assert.equal(GroupNotify.composeMessage(t), GroupNotify.composeMessage(t, GroupNotify.DEFAULT_TEMPLATE));
    });

    test('an unassigned ticket still says so', () => {
        assert.match(GroupNotify.composeMessage({ ticket_key: 'SC-1' }), /Assigned: nobody yet/);
    });
});

describe('the announcement itself', () => {
    test('leads with the ticket key and names the tech lead', () => {
        const msg = GroupNotify.composeMessage({
            ticket_key: 'SC-202608-0042', title: 'Commission wrong',
            project: 'iBeauty POS', company: 'One Hair',
            request_type: 'BUG', priority: 'P1', tech_lead: 'Waikeat',
        });
        assert.match(msg.split('\n')[0], /SC-202608-0042/);
        assert.match(msg, /iBeauty POS · One Hair/);
        assert.match(msg, /Tech lead: Waikeat/);
        assert.match(msg, /Assigned: nobody yet/);
    });
});
