const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const dns = require('dns/promises');
const net = require('net');

const { ALLOWED } = require('../routes/uploadRoutes');

/**
 * Copies attachments the AI workflow references into our own storage.
 *
 * The workflow sends `[{ name, url }]` pointing at WhatsApp media. Those links
 * expire and some need the workflow's own credentials, so a ticket that merely
 * stores the URL has attachments that quietly stop working — usually weeks
 * later, when someone finally opens the ticket. We fetch the bytes once, at
 * ticket creation, and serve them ourselves.
 *
 * ── Why this file is defensive ───────────────────────────────────────────
 * This is the one place CompanySys fetches a URL chosen by something outside
 * it. That is a server-side request forgery primitive: without controls, an
 * "attachment" pointing at http://169.254.169.254/ or http://localhost:5432
 * turns our server into a proxy for scanning its own network. Hence:
 *
 *   - http/https only
 *   - the resolved IP must be public — no loopback, private, link-local
 *   - no redirects followed (a public URL can 302 to a private one)
 *   - a size cap enforced while streaming, not from Content-Length
 *   - the extension comes from the Content-Type, checked against the same
 *     allowlist the human upload route uses, so nothing browser-executable
 *     can ever land in /uploads
 *   - a timeout, so a URL that never responds cannot hold a request open
 *
 * A failure never fails the ticket: the original URL is kept and a warning is
 * returned. A missing screenshot is an inconvenience; a lost customer report is
 * not.
 */

const MAX_BYTES = 10 * 1024 * 1024;      // matches the human upload limit
const TIMEOUT_MS = 15 * 1000;
const MAX_ATTACHMENTS = 10;

/** content-type -> extension, derived from the upload route's allowlist. */
const EXT_FOR_TYPE = new Map(
    [...ALLOWED.entries()].map(([ext, type]) => [type, ext])
);

/**
 * Is this address one we must never fetch from?
 *
 * Covers loopback, RFC1918, link-local (including the cloud metadata address),
 * carrier-grade NAT and unique-local IPv6.
 */
function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;       // link-local + metadata
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        return false;
    }
    if (net.isIPv6(ip)) {
        const v = ip.toLowerCase();
        if (v === '::1' || v === '::') return true;
        if (v.startsWith('fe80')) return true;          // link-local
        if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local
        // ::ffff:10.0.0.1 — an IPv4 address wearing an IPv6 hat.
        const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateAddress(mapped[1]);
        return false;
    }
    return true; // unparseable: refuse
}

/** Throws unless the URL is safe to fetch. */
async function assertFetchable(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('not a valid URL');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`unsupported protocol ${url.protocol}`);
    }

    // Every address the host resolves to must be public — a name with one
    // public and one private A record would otherwise be a way through.
    const resolved = await dns.lookup(url.hostname, { all: true }).catch(() => {
        throw new Error(`could not resolve ${url.hostname}`);
    });
    if (!resolved.length) throw new Error(`could not resolve ${url.hostname}`);

    for (const { address } of resolved) {
        if (isPrivateAddress(address)) {
            throw new Error(`${url.hostname} resolves to a private address`);
        }
    }
    return url;
}

/**
 * Fetches one attachment and writes it into uploads/.
 *
 * @returns {Promise<{name, url, type, size}>}
 */
async function ingestOne(attachment, { baseUrl, fetchImpl = fetch }) {
    await assertFetchable(attachment.url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res;
    try {
        res = await fetchImpl(attachment.url, {
            signal: controller.signal,
            // A public URL redirecting to a private one would sidestep the DNS
            // check entirely.
            redirect: 'error',
            headers: { Accept: '*/*' },
        });
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);

    const contentType = String(res.headers.get('content-type') || '')
        .split(';')[0].trim().toLowerCase();
    const ext = EXT_FOR_TYPE.get(contentType);
    if (!ext) {
        throw new Error(`content type "${contentType || 'unknown'}" is not allowed`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    // Checked against the real byte count, not a Content-Length header the
    // source controls and can lie about.
    if (buffer.length > MAX_BYTES) {
        throw new Error(`file is ${Math.round(buffer.length / 1024 / 1024)}MB, over the 10MB limit`);
    }
    if (!buffer.length) throw new Error('file is empty');

    // Random name, allowlisted extension — the source's filename never touches
    // the filesystem, which removes traversal and double-extension tricks.
    const filename = `chat-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    await fs.writeFile(path.join(__dirname, '..', 'uploads', filename), buffer);

    return {
        name: attachment.name || `attachment${ext}`,
        url: `${baseUrl}/uploads/${filename}`,
        type: contentType,
        size: buffer.length,
        // Kept so it is always possible to tell where a file came from.
        source_url: attachment.url,
    };
}

/**
 * Ingests a list, never throwing.
 *
 * @returns {Promise<{attachments: Array, warnings: string[]}>}
 */
async function ingest(attachments, { baseUrl, fetchImpl = fetch } = {}) {
    if (!Array.isArray(attachments) || !attachments.length) {
        return { attachments: [], warnings: [] };
    }

    const list = attachments.slice(0, MAX_ATTACHMENTS);
    const warnings = [];
    if (attachments.length > MAX_ATTACHMENTS) {
        warnings.push(`Only the first ${MAX_ATTACHMENTS} attachments were stored (${attachments.length} were sent)`);
    }

    const out = [];
    for (const a of list) {
        if (!a || !a.url) continue;
        try {
            out.push(await ingestOne(a, { baseUrl, fetchImpl }));
        } catch (err) {
            // Keep the original reference rather than dropping it: a link that
            // may expire still beats no record that a screenshot existed.
            out.push({ name: a.name || 'attachment', url: a.url, unverified: true });
            warnings.push(`Could not store "${a.name || a.url}" (${err.message}) — the original link was kept and may expire`);
        }
    }

    return { attachments: out, warnings };
}

module.exports = { ingest, ingestOne, isPrivateAddress, assertFetchable, MAX_BYTES, MAX_ATTACHMENTS };
