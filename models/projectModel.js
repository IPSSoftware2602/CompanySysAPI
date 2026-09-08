const db = require('../db');
const { normaliseRecipient } = require('../services/groupNotifyService');

class Project {
    /**
     * Resolves a client to a company row, creating it if new.
     *
     * The existing UI posts a free-text client_name, which is how the database
     * ended up with 20 project rows for 4 real projects. Rather than change the
     * form, every write funnels through here: the same typed name always lands
     * on the same company, matched case-insensitively.
     *
     * @returns {Promise<string|null>} company id
     */
    static async resolveCompany(clientName, client = db) {
        const name = String(clientName || '').trim();
        if (!name) return null;

        const found = await client.query(
            'SELECT id FROM companies WHERE lower(name) = lower($1) AND deleted_at IS NULL',
            [name]
        );
        if (found.rows.length) return found.rows[0].id;

        const code = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
        const created = await client.query(
            `INSERT INTO companies (name, account_code) VALUES ($1, $2)
             ON CONFLICT DO NOTHING RETURNING id`,
            [name, code]
        );
        if (created.rows.length) return created.rows[0].id;

        // Lost a race, or the account_code collided with a differently-cased
        // name. Re-read rather than failing the project create.
        const retry = await client.query(
            'SELECT id FROM companies WHERE lower(name) = lower($1) AND deleted_at IS NULL',
            [name]
        );
        return retry.rows[0]?.id || null;
    }

    static async create({ name, client_name, company_id, tech_lead_id, pm_id, status, whatsapp_group_jid }) {
        const companyId = company_id || await Project.resolveCompany(client_name);

        const result = await db.query(
            `INSERT INTO projects (name, client_name, company_id, tech_lead_id, pm_id, status, whatsapp_group_jid)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            // client_name is still written so a rollback to the previous release
            // keeps working. It stops being written when the column is dropped.
            [name, client_name, companyId, tech_lead_id, pm_id, status || 'PENDING',
                normaliseRecipient(whatsapp_group_jid) || null]
        );
        return result.rows[0];
    }

    /**
     * Company and tech lead names come along for the ride so the support
     * ticket's project picker can search on all three, and so picking a project
     * can show its tech lead without a second round trip. Purely additive —
     * every existing consumer still sees the columns it already read.
     */
    static async getAll() {
        const result = await db.query(`
            SELECT p.*,
                   co.name AS company_name,
                   tl.full_name AS tech_lead_name,
                   pm.full_name AS pm_name
            FROM projects p
            LEFT JOIN companies co ON co.id = p.company_id
            LEFT JOIN users tl ON tl.id = p.tech_lead_id
            LEFT JOIN users pm ON pm.id = p.pm_id
            ORDER BY p.created_at DESC
        `);
        return result.rows;
    }

    /**
     * This is what GET /api/projects actually serves, so the tech lead, PM and
     * company names are resolved here too — the support ticket form reads
     * tech_lead_name off this response to show a project's lead.
     */
    static async getWithStats() {
        const result = await db.query(`
            SELECT p.*,
                   co.name AS company_name,
                   tl.full_name AS tech_lead_name,
                   pmu.full_name AS pm_name,
                   (SELECT json_object_agg(status, count)
                    FROM (SELECT status, COUNT(*) as count
                          FROM tickets
                          WHERE project_id = p.id AND deleted_at IS NULL
                          GROUP BY status) t
                   ) as ticket_counts
            FROM projects p
            LEFT JOIN companies co ON co.id = p.company_id
            LEFT JOIN users tl ON tl.id = p.tech_lead_id
            LEFT JOIN users pmu ON pmu.id = p.pm_id
            ORDER BY p.created_at DESC
        `);
        return result.rows;
    }

    static async update(id, { name, client_name, company_id, tech_lead_id, pm_id, status, whatsapp_group_jid }) {
        const fields = [];
        const values = [];
        let idx = 1;

        // Renaming the client re-points the project at the right company,
        // creating it when the name is new.
        const companyId = company_id || (client_name ? await Project.resolveCompany(client_name) : null);

        if (name) { fields.push(`name = $${idx++}`); values.push(name); }
        if (client_name) { fields.push(`client_name = $${idx++}`); values.push(client_name); }
        if (companyId) { fields.push(`company_id = $${idx++}`); values.push(companyId); }
        if (tech_lead_id) { fields.push(`tech_lead_id = $${idx++}`); values.push(tech_lead_id); }
        if (pm_id) { fields.push(`pm_id = $${idx++}`); values.push(pm_id); }
        if (status) { fields.push(`status = $${idx++}`); values.push(status); }

        // Tested against undefined, not truthiness, because unmapping a group
        // means writing an empty value — every field above can only ever be
        // set, never cleared, and this one has to be clearable.
        if (whatsapp_group_jid !== undefined) {
            // A pasted "120363…@g.us" and the bare digits are the same group.
            // Stored one way so the IRIS receiver's lookup always matches.
            const jid = normaliseRecipient(whatsapp_group_jid) || null;
            fields.push(`whatsapp_group_jid = $${idx++}`);
            values.push(jid);
        }

        if (fields.length === 0) return null;

        values.push(id);
        const result = await db.query(
            `UPDATE projects SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
            values
        );
        return result.rows[0];
    }

    static async delete(id) {
        await db.query('DELETE FROM projects WHERE id = $1', [id]);
    }
}

module.exports = Project;
