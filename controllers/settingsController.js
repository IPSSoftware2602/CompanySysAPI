const Settings = require('../services/settingsService');
const GroupNotify = require('../services/groupNotifyService');
const AuditService = require('../services/auditService');

/**
 * The settings page.
 *
 * Only keys on this list can be written. A settings endpoint that accepts any
 * key is a way to write arbitrary rows into a table the rest of the app trusts.
 */
const WRITABLE = new Set([
    'xtech_api_url', 'xtech_api_token', 'xtech_group_id', 'xtech_message_template',
    // Shared with IRIS: it signs every delivery with this, we verify with it.
    'iris_webhook_secret',
]);

exports.getSettings = async (req, res) => {
    try {
        res.json({
            settings: await Settings.forClient(),
            // The page needs these to offer a Reset button and to list what a
            // template may contain.
            message_default: GroupNotify.DEFAULT_TEMPLATE,
            message_placeholders: GroupNotify.PLACEHOLDERS,
        });
    } catch (err) {
        console.error('Get settings error:', err);
        res.status(500).json({ error: 'Failed to load settings' });
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const body = req.body || {};
        const unknown = Object.keys(body).filter((k) => !WRITABLE.has(k));
        if (unknown.length) {
            return res.status(400).json({ error: `Unknown setting(s): ${unknown.join(', ')}` });
        }

        await Settings.setMany(body, { userId: req.user?.id });

        await AuditService.record(req, {
            action: 'UPDATE',
            entity_type: 'APP_SETTINGS',
            entity_id: null,
            // The keys that changed, never the values — an audit log is not
            // where a token should end up.
            after_data: { keys: Object.keys(body) },
            reason: 'Settings updated',
        });

        res.json({ settings: await Settings.forClient() });
    } catch (err) {
        console.error('Update settings error:', err);
        res.status(500).json({ error: 'Failed to save settings', details: err.message });
    }
};

/**
 * POST /api/settings/xtech/test
 *
 * Sends one real message with whatever is currently saved, and hands back what
 * XTECH actually replied — including the failure body, which is the only thing
 * that tells us whether the request shape is right.
 */
/**
 * POST /api/settings/xtech/preview
 *
 * Renders a template against a sample ticket. Nothing is sent — this is how the
 * settings page shows what a message will look like while it is being edited.
 */
exports.previewMessage = (req, res) => {
    const sample = {
        ticket_key: 'SC-202608-0042',
        title: 'Commission not calculated on invoice INV-18382',
        project: 'iBeauty POS',
        company: 'One Hair',
        request_type: 'BUG',
        priority: 'P1',
        tech_lead: 'Waikeat',
        assigned_dev: null,
        reported_by: 'Ms Tan',
        status: 'NEW',
        app_url: `${process.env.APP_URL || 'https://task.ips.com.my'}/#support`,
    };
    res.json({ preview: GroupNotify.composeMessage(sample, req.body?.template) });
};

exports.testXTech = async (req, res) => {
    try {
        const cfg = await GroupNotify.config();
        const override = String(req.body?.to || '').trim();
        const recipients = GroupNotify.normaliseRecipients(override || cfg.groupId);

        const missing = [
            !cfg.url && 'WhatsApp API URL',
            !cfg.token && 'API token',
            !recipients.length && 'at least one number to notify',
        ].filter(Boolean);

        if (missing.length) {
            return res.status(400).json({ error: `Still missing: ${missing.join(', ')}` });
        }

        const message = GroupNotify.composeMessage({
            ticket_key: 'SC-TEST-0001',
            title: 'Test message from CompanySys — please ignore',
            project: 'Connection test',
            company: null,
            request_type: 'BUG',
            priority: 'P1',
            tech_lead: req.user?.full_name || null,
            assigned_dev: null,
            reported_by: 'Settings page test',
            source: 'INTERNAL',
            app_url: `${process.env.APP_URL || 'https://task.ips.com.my'}/#support`,
        // An unsaved template can be previewed and tested before committing to
        // it, which is the whole point of a test button.
        }, req.body?.template || cfg.template);

        // Sent one at a time, and reported one at a time: "it failed" is not
        // useful when three numbers are configured and only one is wrong.
        const results = [];
        for (const to of recipients) {
            try {
                const r = await GroupNotify.send({ message, group_id: to }, { settings: cfg });
                results.push({
                    to,
                    ok: Boolean(r.ok),
                    status: r.status || null,
                    response: r.body || r.reason || null,
                });
            } catch (err) {
                // A refused connection is a result, not a server fault.
                results.push({ to, ok: false, status: null, response: err.message });
            }
        }

        res.json({
            ok: results.every((r) => r.ok),
            results,
            message,
        });
    } catch (err) {
        res.json({ ok: false, results: [{ to: null, ok: false, status: null, response: err.message }] });
    }
};
