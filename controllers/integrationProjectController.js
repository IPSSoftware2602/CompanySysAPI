const db = require('../db');

/**
 * GET /api/integration/v1/projects
 *
 * The project library the AI workflow matches a customer's message against.
 *
 * Read-only and deliberately narrow: enough for the workflow to decide which
 * project a customer means and to send back a `project_code` that
 * POST /tickets will resolve. It exposes no ticket data and no internal ids
 * beyond the project's own.
 *
 * `project_code` is the project NAME, because that is what POST /tickets
 * already matches on. Returning an id the create endpoint cannot accept would
 * be an invitation to a bug.
 *
 * The tech lead is included so the workflow can say who owns a project without
 * reimplementing the override rule — but it is display only. Assignment is
 * ours.
 */
exports.list = async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT p.id,
                   p.name,
                   p.status,
                   co.name         AS company,
                   co.account_code AS company_code,
                   p.client_name,
                   tl.full_name    AS tech_lead
            FROM projects p
            LEFT JOIN companies co ON co.id = p.company_id
            LEFT JOIN users tl ON tl.id = p.tech_lead_id
            ORDER BY p.name
        `);

        res.json({
            projects: rows.map((p) => ({
                project_code: p.name,
                name: p.name,
                status: p.status,
                company: p.company || p.client_name || null,
                company_code: p.company_code || null,
                tech_lead: p.tech_lead || null,
                // Aliases the AI can match a customer's wording against — the
                // same project gets called by its client's name as often as its
                // own.
                aliases: [p.name, p.company, p.client_name]
                    .filter(Boolean)
                    .filter((v, i, a) => a.indexOf(v) === i),
            })),
            count: rows.length,
            generated_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[integration] project list failed:', err);
        res.status(500).json({ error: 'Failed to list projects' });
    }
};
