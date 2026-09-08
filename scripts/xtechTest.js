/**
 * Sends one test message to the internal WhatsApp group through XTECH.
 *
 *   npm run xtech:test                        -- send a sample "new ticket" message
 *   npm run xtech:test -- --show              -- print the message and the exact
 *                                               request, send nothing
 *   npm run xtech:test -- --to <id>           -- send to this recipient instead
 *                                               of XTECH_GROUP_ID
 *
 * `--to` takes a recipient in digits (`601155849969`). A pasted JID is trimmed
 * automatically. Useful for testing against yourself before announcing into a
 * real group.
 *
 * Exists because the XTECH request shape is the one part of this integration
 * that was written against a guessed contract. Run it, read what comes back,
 * and adjust services/groupNotifyService.js send() until it is a 200.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const GroupNotify = require('../services/groupNotifyService');

const SHOW_ONLY = process.argv.includes('--show');

/** `--to <jid>` overrides XTECH_GROUP_ID for this run only. */
function recipientOverride() {
    const i = process.argv.indexOf('--to');
    return i !== -1 ? process.argv[i + 1] || null : null;
}

const SAMPLE = {
    ticket_key: 'SC-TEST-0001',
    title: 'Test message from CompanySys — please ignore',
    project: 'E-commerce Platform',
    company: 'RetailCo',
    request_type: 'BUG',
    priority: 'P1',
    tech_lead: 'Waikeat',
    assigned_dev: null,
    reported_by: 'XTECH connection test',
    source: 'INTERNAL',
    app_url: `${process.env.APP_URL || 'https://task.ips.com.my'}/#support`,
};

async function main() {
    const cfg = await GroupNotify.config();
    const override = recipientOverride();
    const recipient = override || cfg.groupId;
    const message = GroupNotify.composeMessage(SAMPLE);

    console.log('--- configuration ---');
    console.log(`  XTECH_API_URL    ${cfg.url || '(not set)'}`);
    console.log(`  XTECH_API_TOKEN  ${cfg.token ? `set, ${cfg.token.length} chars` : '(not set)'}`);
    console.log(`  recipient       ${recipient || '(not set)'}${override ? '   (from --to)' : ''}`);

    const normalised = GroupNotify.normaliseRecipient(recipient);
    if (recipient && normalised !== recipient) {
        console.log(`  → sent as   ${normalised}   (XTECH rejects the JID form)`);
    }

    console.log('\n--- message ---');
    console.log(message.split('\n').map((l) => `  ${l}`).join('\n'));

    console.log('\n--- request that will be sent ---');
    console.log(`  POST ${cfg.url || '<XTECH_API_URL>'}`);
    console.log('  Content-Type: application/json');
    console.log(`  body: ${JSON.stringify({ token: '<token>', to: normalised || '<recipient>', message: '<the message above>' })}`);

    if (SHOW_ONLY) {
        console.log('\n(--show given: nothing was sent)');
        return;
    }

    const missing = [
        !cfg.url && 'XTECH_API_URL',
        !cfg.token && 'XTECH_API_TOKEN',
        !recipient && 'XTECH_GROUP_ID (or pass --to <jid>)',
    ].filter(Boolean);

    if (missing.length) {
        console.log(`\n❌ Not sending — set ${missing.join(', ')} in CompanySysAPI/.env first.`);
        process.exitCode = 1;
        return;
    }

    console.log('\n--- sending ---');
    const result = await GroupNotify.send({ message, group_id: recipient });

    if (result.ok) {
        console.log(`✅ XTECH accepted it (HTTP ${result.status}). Check the group.`);
        if (result.body) console.log(`   response: ${result.body}`);
    } else if (result.skipped) {
        console.log(`❌ Skipped: ${result.reason}`);
        process.exitCode = 1;
    } else {
        console.log(`❌ XTECH rejected it (HTTP ${result.status}).`);
        console.log(`   response: ${result.body}`);
        console.log('\n   The body shape is a guess. Send me this response and the XTECH');
        console.log('   docs, and the fix is in groupNotifyService.js send().');
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error('❌ Could not reach XTECH:', err.message);
    process.exitCode = 1;
});
