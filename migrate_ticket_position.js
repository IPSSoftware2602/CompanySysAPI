const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding position column to tickets table...');
        await client.query(`
            ALTER TABLE tickets 
            ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0;
        `);

        console.log('Initializing positions for existing tickets...');
        // Initialize position based on created_at for each list
        const tickets = await client.query('SELECT id, list_id FROM tickets ORDER BY list_id, created_at ASC');

        let currentListId = null;
        let currentPosition = 0;

        for (const ticket of tickets.rows) {
            if (ticket.list_id !== currentListId) {
                currentListId = ticket.list_id;
                currentPosition = 0;
            }
            await client.query('UPDATE tickets SET position = $1 WHERE id = $2', [currentPosition, ticket.id]);
            currentPosition += 1024; // Use large gaps for easier reordering if needed, though simple index is fine too. Let's use simple index for now.
            // Actually, simple index 0, 1, 2... is easier to manage with array reordering.
        }

        // Let's redo with simple index 0, 1, 2...
        // Fetch again to be safe or just iterate.
        // The previous loop was fine but let's reset position logic to be 0, 1, 2...

        const listsResult = await client.query('SELECT DISTINCT list_id FROM tickets');
        for (const list of listsResult.rows) {
            if (!list.list_id) continue;
            const listTickets = await client.query('SELECT id FROM tickets WHERE list_id = $1 ORDER BY created_at ASC', [list.list_id]);
            for (let i = 0; i < listTickets.rows.length; i++) {
                await client.query('UPDATE tickets SET position = $1 WHERE id = $2', [i, listTickets.rows[i].id]);
            }
        }

        await client.query('COMMIT');
        console.log('Migration completed successfully.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', e);
        process.exit(1);
    } finally {
        client.release();
        process.exit(0);
    }
}

migrate();
