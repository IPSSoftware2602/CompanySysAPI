const { test, describe } = require('node:test');
const assert = require('node:assert');
const Ingest = require('../services/attachmentIngestService');

/**
 * This service fetches URLs chosen by an external system, which makes it the
 * one SSRF surface in the codebase. Every case below is an attack that would
 * otherwise turn CompanySys into a proxy onto its own network.
 */
describe('SSRF address filtering', () => {
    const blocked = [
        ['loopback', '127.0.0.1'],
        ['RFC1918 /8', '10.1.2.3'],
        ['RFC1918 /12', '172.16.0.1'],
        ['RFC1918 /16', '192.168.1.1'],
        ['cloud metadata', '169.254.169.254'],
        ['carrier-grade NAT', '100.64.0.1'],
        ['IPv6 loopback', '::1'],
        ['IPv6 unique-local', 'fd00::1'],
        ['IPv4-mapped private', '::ffff:10.0.0.1'],
        ['unparseable', 'not-an-ip'],
    ];
    for (const [name, ip] of blocked) {
        test(`blocks ${name} (${ip})`, () => {
            assert.equal(Ingest.isPrivateAddress(ip), true);
        });
    }

    const allowed = [['public IPv4', '8.8.8.8'], ['just outside RFC1918', '172.32.0.1'], ['public IPv6', '2001:4860:4860::8888']];
    for (const [name, ip] of allowed) {
        test(`allows ${name} (${ip})`, () => {
            assert.equal(Ingest.isPrivateAddress(ip), false);
        });
    }
});

describe('URL validation', () => {
    test('refuses a non-http scheme', async () => {
        await assert.rejects(
            () => Ingest.assertFetchable('file:///etc/passwd'),
            /unsupported protocol/
        );
    });

    test('refuses a URL that resolves to loopback', async () => {
        await assert.rejects(
            () => Ingest.assertFetchable('http://localhost:5432/'),
            /private address/
        );
    });

    test('refuses gibberish', async () => {
        await assert.rejects(() => Ingest.assertFetchable('nonsense'), /not a valid URL/);
    });
});

describe('ingest never fails the ticket', () => {
    test('a broken attachment keeps its original link and warns', async () => {
        const { attachments, warnings } = await Ingest.ingest(
            [{ name: 'shot.png', url: 'http://127.0.0.1/x.png' }],
            { baseUrl: 'https://example.test' }
        );
        assert.equal(attachments.length, 1);
        assert.equal(attachments[0].url, 'http://127.0.0.1/x.png');
        assert.equal(attachments[0].unverified, true);
        assert.match(warnings[0], /Could not store/);
    });

    test('an empty list is not an error', async () => {
        assert.deepEqual(await Ingest.ingest([], { baseUrl: 'x' }), { attachments: [], warnings: [] });
        assert.deepEqual(await Ingest.ingest(undefined, { baseUrl: 'x' }), { attachments: [], warnings: [] });
    });

    test('a disallowed content type is refused even on a 200', async () => {
        const fetchImpl = async () => ({
            ok: true, status: 200,
            headers: { get: () => 'text/html' },
            arrayBuffer: async () => new ArrayBuffer(10),
        });
        await assert.rejects(
            () => Ingest.ingestOne({ name: 'x.html', url: 'https://example.com/x' }, { baseUrl: 'x', fetchImpl }),
            /not allowed/
        );
    });

    test('oversize content is refused by real byte count', async () => {
        const fetchImpl = async () => ({
            ok: true, status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () => new ArrayBuffer(Ingest.MAX_BYTES + 1),
        });
        await assert.rejects(
            () => Ingest.ingestOne({ name: 'big.png', url: 'https://example.com/x' }, { baseUrl: 'x', fetchImpl }),
            /over the 10MB limit/
        );
    });
});
