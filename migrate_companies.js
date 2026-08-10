/**
 * Companies: the client company as a first-class record.
 *
 * projects.client_name is free text. That is how the database ended up with 20
 * project rows for 4 real projects, and why per-client hours would have split
 * five ways and under-billed. A company row fixes attribution for billing, and
 * is also what the AI workflow integration needs to resolve "ONEHAIR" to
 * something real.
 *
 * client_name is NOT dropped here. Reads move to COALESCE(companies.name,
 * projects.client_name) so nothing breaks mid-migration; the column comes out
 * in a later release once nothing references it. Dropping a column in the same
 * release that stops writing it is how you take an outage.
 *
 * Additive and idempotent. Safe to re-run, and safe against a restored backup
 * where the duplicate projects still exist.
 *
 *   node migrate_companies.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const db = require('./db');

/** "ABC Corporation" -> "ABC_CORPORATION", the stable key an integration sends. */
function toAccountCode(name) {
    return String(name)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50);
}

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('1. Creating companies...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS companies (
                id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name          VARCHAR(255) NOT NULL,
                -- Stable external key. The AI workflow sends this rather than
                -- needing to know our UUIDs.
                account_code  VARCHAR(50) UNIQUE,
                status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
                support_level VARCHAR(20),
                created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                deleted_at    TIMESTAMP WITH TIME ZONE
            );
        `);
        // Case-insensitive uniqueness on name: "One Hair" and "one hair" are the
        // same client, and free-text entry is exactly how duplicates got in.
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_lower
                ON companies (lower(name)) WHERE deleted_at IS NULL;
        `);

        console.log('2. Linking projects and support tickets...');
        await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);');
        await client.query('ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_projects_company ON projects (company_id);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_support_tickets_company ON support_tickets (company_id);');

        console.log('3. Creating companies from existing client names...');
        // DISTINCT collapses the duplicate project rows onto one company each —
        // which is the whole point.
        const { rows: names } = await client.query(`
            SELECT DISTINCT trim(client_name) AS name
            FROM projects
            WHERE client_name IS NOT NULL AND trim(client_name) <> ''
            ORDER BY 1
        `);

        let created = 0;
        for (const { name } of names) {
            const res = await client.query(
                `INSERT INTO companies (name, account_code)
                 VALUES ($1, $2)
                 ON CONFLICT DO NOTHING
                 RETURNING id`,
                [name, toAccountCode(name)]
            );
            if (res.rows.length) created++;
        }
        console.log(`   ${created} company/companies created from ${names.length} distinct client name(s)`);

        console.log('4. Backfilling projects.company_id...');
        const linked = await client.query(`
            UPDATE projects p SET company_id = c.id
            FROM companies c
            WHERE p.company_id IS NULL
              AND p.client_name IS NOT NULL
              AND lower(trim(p.client_name)) = lower(c.name)
        `);
        console.log(`   ${linked.rowCount} project(s) linked`);

        console.log('5. Backfilling support_tickets.company_id...');
        // Only via project_id — supporting_project_id is the legacy path being
        // retired and carries no company of its own.
        const st = await client.query(`
            UPDATE support_tickets st SET company_id = p.company_id
            FROM projects p
            WHERE st.company_id IS NULL AND st.project_id = p.id AND p.company_id IS NOT NULL
        `);
        console.log(`   ${st.rowCount} support ticket(s) linked`);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed, rolled back:', err.message);
        throw err;
    } finally {
        client.release();
    }

    // Reporting is deliberately OUTSIDE the transaction block above. A failure
    // here must not print "rolled back" over a migration that already
    // committed — a migration that lies about its outcome gets re-run in a
    // panic, which is worse than the original error.
    try {
        const { rows: [orphanProjects] } = await db.query(
            `SELECT count(*) n FROM projects WHERE company_id IS NULL`
        );
        const { rows: [orphanSupport] } = await db.query(
            `SELECT count(*) n FROM support_tickets WHERE company_id IS NULL AND deleted_at IS NULL`
        );
        const { rows: [legacy] } = await db.query(
            `SELECT count(*) n FROM support_tickets
             WHERE supporting_project_id IS NOT NULL AND project_id IS NULL AND deleted_at IS NULL`
        );
        const { rows: companies } = await db.query(
            `SELECT name, account_code FROM companies WHERE deleted_at IS NULL ORDER BY name`
        );

        console.log('\n✅ Companies migration complete.');
        if (companies.length) {
            console.log('\n   Companies:');
            for (const c of companies) console.log(`     ${c.account_code.padEnd(24)} ${c.name}`);
        } else {
            console.log('\n   No companies yet — create them as projects are added.');
        }

        if (Number(orphanProjects.n) > 0) {
            console.log(`\n⚠️  ${orphanProjects.n} project(s) have no company.`);
            console.log('   Their time will report as unattributed and reach no invoice.');
        }
        if (Number(orphanSupport.n) > 0) {
            console.log(`\n⚠️  ${orphanSupport.n} support ticket(s) have no company.`);
        }
        if (Number(legacy.n) > 0) {
            console.log(`\n⚠️  ${legacy.n} support ticket(s) still reference supporting_projects only.`);
            console.log('   New tickets write project_id; these need repointing before the');
            console.log('   supporting_projects column can be dropped.');
        }
    } catch (err) {
        // Schema changes are already committed at this point.
        console.warn('\n⚠️  Migration succeeded, but the summary could not be produced:', err.message);
    }
}

migrate()
    .then(() => db.pool.end())
    .catch(async () => { try { await db.pool.end(); } catch { /* closing */ } process.exit(1); });
