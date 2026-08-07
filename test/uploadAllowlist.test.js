const test = require('node:test');
const assert = require('node:assert/strict');

const { ALLOWED } = require('../routes/uploadRoutes');

/**
 * Uploads are served back from our own origin, so a file the browser will
 * EXECUTE is script execution on our domain — and with the JWT in the browser,
 * that is session theft.
 *
 * This guards the allowlist against a well-meaning future widening. If someone
 * needs one of these formats, the answer is object storage on a separate
 * origin, not an entry here.
 */
const NEVER_ALLOW = [
    '.html', '.htm', '.xhtml', '.shtml',
    '.svg',                       // can carry <script>
    '.js', '.mjs', '.cjs',
    '.xml', '.xsl',               // XSLT executes
    '.swf',
    '.php', '.phtml', '.jsp', '.asp', '.aspx', '.cgi',  // if ever served by a real web server
    '.sh', '.bash', '.exe', '.bat', '.cmd', '.ps1',
];

test('upload allowlist', async (t) => {
    await t.test('never permits a browser-executable type', () => {
        for (const ext of NEVER_ALLOW) {
            assert.equal(ALLOWED.has(ext), false, `${ext} must not be uploadable`);
        }
    });

    await t.test('permits the formats actually in use today', () => {
        // Live uploads/ currently holds pdf, xlsx and png only.
        for (const ext of ['.pdf', '.xlsx', '.png']) {
            assert.equal(ALLOWED.has(ext), true, `${ext} is in real use`);
        }
    });

    await t.test('every entry is lowercase and dot-prefixed', () => {
        for (const ext of ALLOWED.keys()) {
            assert.equal(ext, ext.toLowerCase(), `${ext} must be lowercase`);
            assert.ok(ext.startsWith('.'), `${ext} must start with a dot`);
        }
    });

    await t.test('every entry declares an expected MIME type', () => {
        for (const [ext, mime] of ALLOWED) {
            assert.equal(typeof mime, 'string');
            assert.ok(mime.length > 0, `${ext} needs a MIME type to check against`);
        }
    });

    await t.test('no entry maps to a MIME type the browser will render as markup', () => {
        // Matched exactly, not by substring: the Office formats legitimately
        // contain "openxmlformats" and are ZIP containers, not markup.
        const RENDERABLE = new Set([
            'text/html',
            'application/xhtml+xml',
            'image/svg+xml',
            'text/xml',
            'application/xml',
            'text/javascript',
            'application/javascript',
            'application/x-shockwave-flash',
        ]);
        for (const [ext, mime] of ALLOWED) {
            assert.equal(RENDERABLE.has(mime), false, `${ext} -> ${mime} would render as markup`);
        }
    });
});
