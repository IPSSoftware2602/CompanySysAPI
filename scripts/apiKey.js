#!/usr/bin/env node
/**
 * Mint, list and revoke API keys.
 *
 *   npm run apikey:create -- "AI Workflow" tickets:write tickets:read
 *   npm run apikey:list
 *   npm run apikey:revoke -- <id>
 *
 * The plaintext is printed once, at creation. It is not stored and cannot be
 * recovered — mint a new key and revoke the old one if it is lost.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../db');
const ApiKeyService = require('../services/apiKeyService');

const DEFAULT_SCOPES = ['tickets:write', 'tickets:read'];

async function main() {
    const [command, ...args] = process.argv.slice(2);

    if (command === 'create') {
        const name = args[0];
        if (!name) {
            console.error('Usage: npm run apikey:create -- "<name>" [scope ...]');
            process.exitCode = 1;
            return;
        }
        const scopes = args.slice(1).length ? args.slice(1) : DEFAULT_SCOPES;
        const key = await ApiKeyService.create({ name, scopes });

        console.log('\n✅ API key created.\n');
        console.log(`   name    ${key.name}`);
        console.log(`   id      ${key.id}`);
        console.log(`   scopes  ${key.scopes.join(', ')}`);
        console.log('\n   ────────────────────────────────────────────────────────────');
        console.log(`   ${key.plaintext}`);
        console.log('   ────────────────────────────────────────────────────────────');
        console.log('\n   Shown once. Store it in the AI workflow now — it cannot be');
        console.log('   recovered, only replaced.\n');
        console.log('   Use as:  Authorization: Bearer <key>\n');
        return;
    }

    if (command === 'list') {
        const keys = await ApiKeyService.list();
        if (!keys.length) {
            console.log('No API keys. Create one with: npm run apikey:create -- "AI Workflow"');
            return;
        }
        console.log('');
        for (const k of keys) {
            const state = k.revoked_at ? 'REVOKED' : 'active';
            const used = k.last_used_at ? new Date(k.last_used_at).toISOString().slice(0, 16).replace('T', ' ') : 'never used';
            console.log(`  ${state.padEnd(8)} ${k.key_prefix}…  ${k.name}`);
            console.log(`           ${k.id}`);
            console.log(`           scopes: ${k.scopes.join(', ') || '(none)'}  ·  last used: ${used}`);
        }
        console.log('');
        return;
    }

    if (command === 'revoke') {
        const id = args[0];
        if (!id) {
            console.error('Usage: npm run apikey:revoke -- <id>');
            process.exitCode = 1;
            return;
        }
        const revoked = await ApiKeyService.revoke(id);
        if (!revoked) {
            console.error('No active key with that id.');
            process.exitCode = 1;
            return;
        }
        console.log(`✅ Revoked ${revoked.key_prefix}… (${revoked.name}). Requests using it now fail immediately.`);
        return;
    }

    console.error('Usage:');
    console.error('  npm run apikey:create -- "<name>" [scope ...]');
    console.error('  npm run apikey:list');
    console.error('  npm run apikey:revoke -- <id>');
    process.exitCode = 1;
}

main()
    .then(() => db.pool.end())
    .catch(async (err) => {
        console.error('Failed:', err.message);
        try { await db.pool.end(); } catch { /* closing */ }
        process.exit(1);
    });
