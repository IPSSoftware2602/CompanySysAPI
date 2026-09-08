const Settings = require('./settingsService');

/**
 * "A ticket now exists" — announced to the internal WhatsApp group via XTECH.
 *
 * Two halves, deliberately separated, the same shape as webhookService:
 *
 *   The message is COMPOSED here and queued into webhook_deliveries with
 *   channel 'WHATSAPP', inside the transaction that creates the ticket.
 *   It is SENT later by jobs/webhookSender.js, with the outbox's retries.
 *
 * Posting to XTECH inline at creation would tie "can this PM file a ticket" to
 * "is XTECH up right now", and a failure would be silent. Queued, a XTECH outage
 * delays the announcement instead of losing the ticket.
 *
 * ── Configuration ────────────────────────────────────────────────────────
 * Edited in the app under Settings, and stored in app_settings:
 *   xtech_api_url     full URL of the send-message endpoint
 *   xtech_api_token   API token
 *   xtech_group_id    the internal group to announce into
 *
 * Environment variables of the same names still work as a fallback, so a
 * machine configured before the settings page existed keeps running.
 *
 * With none of these set, messages still queue and simply are not delivered —
 * the same failure mode as an unset WEBHOOK_URL, and visible in the same
 * dead-letter view.
 */

/** Read at call time, not import time, so a change in the UI takes effect. */
async function config() {
    const s = await Settings.all();
    return {
        url: s.xtech_api_url || process.env.XTECH_API_URL || process.env.WATO_API_URL || null,
        token: s.xtech_api_token || process.env.XTECH_API_TOKEN || process.env.WATO_API_TOKEN || null,
        // WATO_* is the pre-rename spelling, kept so a machine configured
        // before this does not silently stop sending.
        groupId: s.xtech_group_id || process.env.XTECH_GROUP_ID || process.env.WATO_GROUP_ID || null,
        template: s.xtech_message_template || null,
    };
}

/**
 * The default announcement, used until someone edits it in Settings.
 *
 * Written for someone glancing at a phone: what came in, for whom, how urgent,
 * and who owns it. The ticket key leads because that is what anyone will quote
 * back in the group.
 */
const DEFAULT_TEMPLATE = [
    '🎫 New support ticket — {ticket_key}',
    '{project} · {company}',
    '{request_type} · {priority}',
    '',
    '{title}',
    'Tech lead: {tech_lead}',
    'Assigned: {assigned_dev}',
    'Reported by: {reported_by}',
    '',
    '{app_url}',
].join('\n');

/** Every placeholder a template may use, with what it means. */
const PLACEHOLDERS = [
    { key: 'ticket_key', description: 'e.g. SC-202608-0042' },
    { key: 'title', description: 'The ticket title' },
    { key: 'project', description: 'Project name' },
    { key: 'company', description: 'Client / company name' },
    { key: 'request_type', description: 'BUG, FEATURE, …' },
    { key: 'priority', description: 'P0-P3' },
    { key: 'tech_lead', description: "The project's tech lead" },
    { key: 'assigned_dev', description: 'Assignee, or "nobody yet"' },
    { key: 'reported_by', description: 'Customer name, when the AI filed it' },
    { key: 'status', description: 'Ticket status' },
    { key: 'app_url', description: 'Link into CompanySys' },
];

/**
 * Fills a template.
 *
 * A line whose placeholders are ALL empty is dropped entirely, so
 * "Reported by: {reported_by}" leaves no dangling label on a ticket a PM typed
 * in. A line with some values present keeps them, and a separator left hanging
 * by an empty neighbour is tidied away.
 */
function renderTemplate(template, values) {
    return String(template)
        .split('\n')
        .map((line) => {
            const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
            if (keys.length && keys.every((k) => !values[k])) return null;

            return line
                .replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '')
                // " · " left stranded when one side was empty.
                .replace(/\s*·\s*$/, '')
                .replace(/^\s*·\s*/, '')
                .replace(/[ \t]{2,}/g, ' ')
                .trimEnd();
        })
        .filter((line) => line !== null)
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * The announcement text for one ticket.
 *
 * @param {object} t   the queued payload
 * @param {string} [template]  from Settings; the default is used when unset
 */
function composeMessage(t, template) {
    return renderTemplate(template || DEFAULT_TEMPLATE, {
        ticket_key: t.ticket_key || '',
        title: t.title || '',
        project: t.project || '',
        company: t.company || '',
        request_type: t.request_type || '',
        priority: t.priority || '',
        tech_lead: t.tech_lead || '',
        // Deliberately never empty: "nobody has picked this up" is exactly what
        // a group notification exists to say.
        assigned_dev: t.assigned_dev || 'nobody yet',
        reported_by: t.reported_by || '',
        status: t.status || '',
        app_url: t.app_url || '',
    });
}

/**
 * Normalises a recipient into what XTECH accepts.
 *
 * XTECH validates `to` as "number or lid format" and rejects a full WhatsApp
 * JID, so `601155849969@s.whatsapp.net` has to be sent as `601155849969`.
 * Punctuation people paste from a phone book goes too.
 *
 * The suffix is stripped from group JIDs too. XTECH rejected
 * `120363046735396444@g.us` outright with "Invalid number or lid format", so
 * the JID form is definitely wrong; the bare digits at least satisfy the
 * validator, and whether they actually route to the group is the next thing to
 * find out. Confirmed working for a personal number.
 */
/**
 * Splits the configured recipient setting into individual recipients.
 *
 * XTECH's send endpoint addresses PEOPLE, not groups — an 18-digit WhatsApp
 * group id is rejected as "Invalid number or lid format" in every form tried.
 * Until a group endpoint exists, "tell the internal group" is implemented as
 * "tell these people", so the setting takes a list.
 *
 * Separated by commas, semicolons or newlines — NOT spaces, because a pasted
 * number like "+60 11-5584 9969" contains them and splitting on whitespace
 * turned one number into four.
 */
function normaliseRecipients(raw) {
    return String(raw || '')
        .split(/[\n,;]+/)
        .map((r) => normaliseRecipient(r))
        .filter(Boolean)
        // Two spellings of the same number would send the message twice.
        .filter((v, i, a) => a.indexOf(v) === i);
}

function normaliseRecipient(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';

    if (value.endsWith('@lid')) return value.replace(/@lid$/, '');

    // Group JID, personal JID or a typed phone number all reduce to digits.
    const digits = value
        .replace(/@g\.us$/, '')
        .replace(/@s\.whatsapp\.net$/, '')
        .replace(/[^0-9]/g, '');
    return digits || value;
}

/**
 * Posts one composed message to XTECH.
 *
 * The contract below is XTECH's own, learned from its validation error rather
 * than guessed: the token goes in the BODY as `token` (not an Authorization
 * header), the text field is `message` (not `text`), and `to` is a bare number.
 */
async function send(payload, { fetchImpl = fetch, settings = null } = {}) {
    const { url, token, groupId } = settings || await config();
    if (!url || !token) {
        return { ok: false, skipped: true, reason: 'XTECH API URL / token not set' };
    }

    const target = normaliseRecipient(payload.group_id || groupId);
    if (!target) return { ok: false, skipped: true, reason: 'No XTECH recipient set' };

    const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token,
            to: target,
            message: payload.message,
        }),
    });

    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: body.slice(0, 500), sent_to: target };
}

module.exports = {
    composeMessage, send, config, normaliseRecipient, normaliseRecipients,
    renderTemplate, DEFAULT_TEMPLATE, PLACEHOLDERS,
};
