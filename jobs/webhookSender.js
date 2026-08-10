/**
 * Drains the webhook outbox. Run from the system crontab.
 *
 *   *\/2 * * * * cd /path/to/backend && /usr/bin/node jobs/webhookSender.js >> logs/webhook.log 2>&1
 *
 * Every two minutes is ample: the first retry is a minute out, and at client
 * staff volume there are only ever a handful of events in flight.
 *
 * Flags:
 *   --dry-run   report what is due, send nothing
 *   --json      machine-readable output
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../db');
const Webhook = require('../services/webhookService');

const DRY_RUN = process.argv.includes('--dry-run');
const AS_JSON = process.argv.includes('--json');

async function main() {
    const url = process.env.WEBHOOK_URL;
    const secret = process.env.WEBHOOK_SECRET;

    if (!url) {
        console.log('[webhook] WEBHOOK_URL not set — events are queuing but cannot be delivered.');
        const { rows: [c] } = await db.query(
            `SELECT count(*) FILTER (WHERE status IN ('PENDING','FAILED'))::int waiting FROM webhook_deliveries`
        );
        if (c.waiting > 0) {
            console.log(`[webhook] ${c.waiting} event(s) waiting. A customer may be expecting one of these.`);
        }
        return { skipped: true };
    }

    if (!secret) {
        // Not fatal, but the receiver cannot tell a real delivery from a forged
        // one, and this endpoint changes what a customer is told.
        console.warn('[webhook] WEBHOOK_SECRET not set — deliveries will be UNSIGNED.');
    }

    if (DRY_RUN) {
        const { rows } = await db.query(
            `SELECT id, event, attempts, payload->>'ticket_key' AS ticket_key
             FROM webhook_deliveries
             WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= now()
             ORDER BY next_attempt_at LIMIT 25`
        );
        console.log(`[webhook] ${rows.length} delivery/deliveries due (dry run):`);
        for (const r of rows) console.log(`  -> ${r.event} ${r.ticket_key} (attempt ${r.attempts + 1})`);
        return { dryRun: true, due: rows.length };
    }

    const result = await Webhook.deliverDue({ url, secret });

    if (AS_JSON) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(`[webhook] ${new Date().toISOString()} — ${result.attempted} attempted, ` +
            `${result.sent} sent, ${result.failed} retrying, ${result.dead} dead`);
        for (const d of result.details || []) {
            if (d.status !== 'SENT') console.log(`  !! ${d.status} ${d.event} ${d.ticket}: ${d.error}`);
        }
    }

    // A dead letter means someone is waiting on news that will never arrive
    // unless a human intervenes. Say so loudly.
    const { rows: [dead] } = await db.query(
        `SELECT count(*)::int n FROM webhook_deliveries WHERE status='DEAD'`
    );
    if (dead.n > 0) {
        console.warn(`[webhook] ⚠️  ${dead.n} dead letter(s) — undelivered status updates a customer may be waiting for.`);
    }

    return result;
}

if (require.main === module) {
    main()
        .then(() => db.pool.end())
        .catch(async (err) => {
            console.error('[webhook] sender failed:', err.message);
            console.error(err.stack);
            try { await db.pool.end(); } catch { /* already closing */ }
            process.exit(1);
        });
}

module.exports = { main };
