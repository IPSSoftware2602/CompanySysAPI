const db = require('./db');

async function checkSchema() {
    try {
        const listsTable = await db.query("SELECT to_regclass('public.lists');");
        console.log('Lists table exists:', listsTable.rows[0].to_regclass !== null);

        if (listsTable.rows[0].to_regclass) {
            const columns = await db.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'lists';
            `);
            console.log('Lists columns:', columns.rows.map(r => r.column_name));
        }

        const ticketsColumns = await db.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'tickets';
        `);
        console.log('Tickets columns:', ticketsColumns.rows.map(r => r.column_name).filter(c => c === 'list_id' || c === 'position'));

    } catch (err) {
        console.error('Error checking schema:', err);
    } finally {
        // We can't easily close the pool if it's exported and used by the running server in the same process, 
        // but here we are running a separate process, so we should try to close if the db module allows, 
        // or just let the process exit. 
        // Assuming db.pool exists and has end().
        if (db.pool && db.pool.end) {
            await db.pool.end();
        }
    }
}

checkSchema();
