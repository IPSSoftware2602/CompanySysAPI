/**
 * SLA breach detection — run from the system crontab.
 *
 *   *\/10 * * * * cd /path/to/backend && /usr/bin/node jobs/slaBreachCheck.js >> logs/sla.log 2>&1
 *
 * Two levels, not four. This team is five people; a 50/75/90/breach ladder
 * addressed to three tiers of management is theatre.
 *
 *   >= 80% consumed  -> SLA_WARNING   (assigned dev + PM)
 *   > 100% consumed  -> SLA_BREACH    (same, plus it shows on the dashboard)
 *
 * De-duplication: each notification is recorded in audit_logs keyed by
 * (entity_id, action), and a ticket that already has that row is skipped. So a
 * ticket warns once and breaches once, no matter how often the job runs. That
 * reuses the existing audit trail instead of adding a table, and gives you a
 * free history of when each ticket first went red.
 *
 * Flags:
 *   --dry-run   report what would be sent, write nothing, notify nobody
 *   --json      machine-readable output
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../db');
const SlaService = require('../services/slaService');
const { AUDIT_ACTION, AUDIT_ENTITY } = require('../constants');

const DRY_RUN = process.argv.includes('--dry-run');
const AS_JSON = process.argv.includes('--json');

/**
 * Delivery. Deliberately left as a single seam rather than a hardcoded
 * integration: wiring the Xchievers WhatsApp API needs credentials and a target
 * group id that belong in .env, not in source.
 *
 * To enable, set SLA_ALERT_WEBHOOK (or replace this body with an XWA call) —
 * see the `xchievers-wa-api` skill for the request shape.
 */
async function notify(message, payload) {
    const webhook = process.env.SLA_ALERT_WEBHOOK;
    if (!webhook) {
        console.log(`[sla] NO CHANNEL CONFIGURED — would have sent:\n${message}`);
        return { delivered: false, reason: 'SLA_ALERT_WEBHOOK not set' };
    }

    try {
        const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message, ...payload }),
        });
        if (!res.ok) return { delivered: false, reason: `HTTP ${res.status}` };
        return { delivered: true };
    } catch (err) {
        return { delivered: false, reason: err.message };
    }
}

/** Has this ticket already been notified at this level? */
async function alreadyNotified(ticketId, action) {
    const { rows } = await db.query(
        `SELECT 1 FROM audit_logs
         WHERE entity_type = $1 AND entity_id = $2 AND action = $3
         LIMIT 1`,
        [AUDIT_ENTITY.SUPPORT_TICKET, ticketId, action]
    );
    return rows.length > 0;
}

async function markNotified(ticketId, action, detail) {
    await db.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, after_data, reason)
         VALUES (NULL, $1, $2, $3, $4, $5)`,
        [action, AUDIT_ENTITY.SUPPORT_TICKET, ticketId, JSON.stringify(detail), 'automated SLA check']
    );
}

function describe({ ticket, sla }) {
    const clocks = [];
    if (!sla.firstResponse.respondedAt && sla.firstResponse.pct >= SlaService.WARN_THRESHOLD_PCT) {
        clocks.push(`first response ${sla.firstResponse.pct}%`);
    }
    if (!sla.resolution.isPaused && sla.resolution.pct >= SlaService.WARN_THRESHOLD_PCT) {
        clocks.push(`resolution ${sla.resolution.pct}%`);
    }

    const owner = ticket.assigned_dev_name || ticket.assigned_pm_name || 'UNASSIGNED';
    return `${ticket.ticket_key} [${ticket.priority}] ${ticket.title}\n` +
        `  project: ${ticket.project_name || '-'}  owner: ${owner}\n` +
        `  ${clocks.join(', ')}`;
}

async function main() {
    const at = new Date();
    const candidates = await SlaService.findBreaching({ now: at });

    const sent = [];
    const skipped = [];

    for (const entry of candidates) {
        const { ticket, sla } = entry;
        const breached = sla.firstResponse.breached ||
            (!sla.resolution.isPaused && sla.resolution.breached);
        const action = breached ? AUDIT_ACTION.SLA_BREACH : AUDIT_ACTION.SLA_WARNING;

        if (await alreadyNotified(ticket.id, action)) {
            skipped.push({ ticket_key: ticket.ticket_key, action, reason: 'already notified' });
            continue;
        }

        const message = `${breached ? '🔴 SLA BREACHED' : '🟠 SLA WARNING'}\n${describe(entry)}`;

        if (DRY_RUN) {
            sent.push({ ticket_key: ticket.ticket_key, action, delivered: false, dryRun: true, message });
            continue;
        }

        const result = await notify(message, {
            ticket_key: ticket.ticket_key,
            ticket_id: ticket.id,
            priority: ticket.priority,
            level: action,
        });

        // Mark it notified even if delivery failed: otherwise a broken webhook
        // turns into an alert storm the moment it comes back up. Delivery
        // failures are visible in this job's log.
        await markNotified(ticket.id, action, {
            first_response_pct: sla.firstResponse.pct,
            resolution_pct: sla.resolution.pct,
            delivered: result.delivered,
            reason: result.reason || null,
        });

        sent.push({ ticket_key: ticket.ticket_key, action, ...result });
    }

    const summary = {
        checked_at: at.toISOString(),
        candidates: candidates.length,
        notified: sent.length,
        skipped: skipped.length,
        dry_run: DRY_RUN,
        sent,
        skipped,
    };

    if (AS_JSON) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        console.log(`[sla] ${at.toISOString()} — ${candidates.length} at/over threshold, ` +
            `${sent.length} notified, ${skipped.length} already known${DRY_RUN ? ' (dry run)' : ''}`);
        for (const s of sent) console.log(`  -> ${s.action} ${s.ticket_key}${s.delivered ? '' : ` (NOT DELIVERED: ${s.reason || 'dry run'})`}`);
    }

    return summary;
}

// Only run when invoked directly. Without this guard, merely requiring the file
// (a test, a module sweep) fires a live SLA check as a side effect.
if (require.main === module) {
    main()
        .then(() => db.pool.end())
        .catch(async (err) => {
            console.error('[sla] check failed:', err.message);
            console.error(err.stack);
            try { await db.pool.end(); } catch { /* already closing */ }
            process.exit(1);
        });
}

module.exports = { main, notify };
