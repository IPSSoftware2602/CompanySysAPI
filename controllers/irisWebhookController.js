const crypto = require('crypto');
const db = require('../db');
const Settings = require('../services/settingsService');
const AuditService = require('../services/auditService');
const { normaliseRecipient } = require('../services/groupNotifyService');
const ticketCtl = require('./integrationTicketController');
const { AUDIT_ACTION, AUDIT_ENTITY } = require('../constants');

/**
 * Receiver for IRIS, the AI that answers customers on WhatsApp.
 *
 * IRIS's outbound webhook can send a URL and an HMAC signature and nothing
 * else — no custom headers — so it cannot call POST /api/integration/v1/tickets
 * directly: that router requires an `Authorization: Bearer csk_…` key and an
 * `Idempotency-Key` header. This endpoint is the adapter. It authenticates by
 * signature, translates IRIS's event into the body that endpoint expects, and
 * then hands over to the very same controller.
 *
 * Delegating rather than re-implementing is the whole point: idempotency,
 * company/project resolution, attachment re-hosting, the SLA clocks, the status
 * webhooks back to IRIS and the WhatsApp group announcement all come along
 * unchanged. A second create path would drift from the first within a month.
 */

/** Only this one opens a ticket. Everything else is recorded and ignored. */
const TICKET_EVENT = 'ticket.create';

/**
 * IRIS sends no request type, and ours is mandatory.
 *
 * QUESTION is the honest default for "a customer asked something the bot could
 * not finish" — calling it a BUG would assert a diagnosis nobody has made yet.
 * A PM re-triages on the board, the same as they do with the P3 priority the
 * create path already defaults to.
 */
const DEFAULT_REQUEST_TYPE = 'QUESTION';

/** A WhatsApp group id in any spelling reduces to the digits we store. */
function groupKey(raw) {
    return normaliseRecipient(raw) || null;
}

/**
 * Verifies `X-Iris-Signature: sha256=<hex>` over the raw bytes received.
 *
 * Against the RAW body, never a re-serialised copy: JSON.stringify reorders
 * keys and changes whitespace, and the signature would never match.
 *
 * An unsigned delivery is rejected outright. The URL is otherwise the only
 * thing between the open internet and the ticket board, and it lives in a
 * third party's config screen and delivery log.
 */
function verifySignature(req, secret) {
    const received = req.get('x-iris-signature') || '';
    if (!received) return { ok: false, reason: 'Missing X-Iris-Signature' };
    if (!req.rawBody) return { ok: false, reason: 'Raw body unavailable' };

    const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(req.rawBody)
        .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    // Length check first: timingSafeEqual throws on a length mismatch, and a
    // thrown error here would read as a server fault rather than a bad signature.
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return ok ? { ok: true } : { ok: false, reason: 'Signature mismatch' };
}

/**
 * A stable key per ESCALATION, not per conversation.
 *
 * `conversation_id` is stable for the life of a conversation, so using it alone
 * would make the same customer's second issue next month replay into the first
 * ticket instead of opening a new one.
 *
 * The hash fallback is safe precisely because IRIS re-sends failed deliveries
 * byte-for-byte: an identical body hashes to an identical key, so a re-send
 * replays rather than duplicating. It is only a fallback — a real delivery id
 * from IRIS is better, and is used whenever one arrives.
 */
function idempotencyKeyFor(req, payload) {
    const supplied = payload.event_id || payload.id
        || req.get('x-iris-delivery') || req.get('x-iris-event-id');
    if (supplied) return `iris:${supplied}`;

    const basis = [payload.conversation_id, payload.timestamp, payload.summary]
        .filter(Boolean).join('|');
    return 'iris:' + crypto.createHash('sha256').update(basis).digest('hex');
}

/** The project whose customers talk in this WhatsApp group. */
async function projectForGroup(jid) {
    const key = groupKey(jid);
    if (!key) return null;

    const { rows } = await db.query(
        `SELECT p.id, p.name, c.account_code, c.name AS company_name
         FROM projects p
         LEFT JOIN companies c ON c.id = p.company_id
         WHERE p.whatsapp_group_jid = $1`,
        [key]
    );
    return rows[0] || null;
}

/**
 * POST /api/integration/iris/events
 *
 * Answers 2xx fast whatever happens — IRIS treats a non-2xx as a failure and
 * schedules a retry, and a ticket we already filed must not be filed twice
 * because our response was slow or our mapping was imperfect.
 */
exports.receive = async (req, res) => {
    const payload = req.body || {};
    const event = payload.event || 'unknown';

    const secret = await Settings.get('iris_webhook_secret');
    if (!secret) {
        // Refusing while unconfigured is deliberate: accepting unsigned events
        // "until the secret is set" is how an endpoint stays unsigned forever.
        console.warn('[iris] delivery refused — iris_webhook_secret is not set');
        return res.status(503).json({ error: 'IRIS receiver is not configured' });
    }

    const sig = verifySignature(req, secret);
    if (!sig.ok) {
        console.warn(`[iris] rejected delivery: ${sig.reason}`);
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // Marks the actor as a service rather than a logged-in person, for this
    // record and the ticket's own audit trail. IRIS holds no API key — the
    // signature is its credential.
    req.apiKey = req.apiKey || { id: null, name: 'IRIS' };

    // Recorded before anything is interpreted, so a payload we mapped badly is
    // still on file to map again. audit_logs already stores actor, JSON and a
    // reason, so this needs no table of its own.
    await AuditService.record(req, {
        action: AUDIT_ACTION.CREATE,
        entity_type: AUDIT_ENTITY.IRIS_EVENT,
        entity_id: null,
        after_data: payload,
        reason: `IRIS ${event}`,
    });

    if (event !== TICKET_EVENT) {
        return res.status(200).json({ received: true, ignored: true, event });
    }

    const project = await projectForGroup(payload.group_jid);
    if (!project) {
        // Filed anyway, unattributed. Dropping it would lose a real customer
        // request over a missing configuration row; a PM can set the project on
        // the board, and the warning says why it arrived bare.
        console.warn(`[iris] no project mapped to group ${payload.group_jid} (${payload.group})`);
    }

    const title = String(payload.title || payload.summary || 'Customer request via WhatsApp')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 255);

    req.body = {
        external_ref: payload.conversation_id || null,
        company_code: project?.account_code || project?.company_name || null,
        project_code: project?.name || null,
        request_type: payload.request_type || DEFAULT_REQUEST_TYPE,
        suggested_priority: payload.suggested_priority || payload.priority || undefined,
        title,
        description: payload.description || payload.message || payload.summary || null,
        steps_to_reproduce: payload.steps_to_reproduce || null,
        reported_by_name: payload.customer_name || null,
        reported_by_contact: payload.customer_phone || null,
        ai_summary: payload.summary || null,
        ai_preliminary_diagnosis: payload.diagnosis || payload.ai_preliminary_diagnosis || null,
        // The bot answers in about seven seconds, so the event time is when the
        // customer was first responded to. Without it the first-response clock
        // would start at ticket creation and every IRIS ticket would look like
        // an instant breach.
        first_responded_at: payload.first_responded_at || payload.timestamp || null,
        attachments: Array.isArray(payload.attachments) ? payload.attachments : undefined,
    };

    req.headers['idempotency-key'] = idempotencyKeyFor(req, payload);

    return ticketCtl.submit(req, res);
};
