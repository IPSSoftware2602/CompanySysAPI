const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding start_date column to tickets table...');
        await client.query(`
            ALTER TABLE tickets 
            ADD COLUMN IF NOT EXISTS start_date TIMESTAMP WITH TIME ZONE;
        `);

        console.log('Renaming due_date to end_date...');
        const checkRes = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='tickets' AND column_name='due_date';
        `);

        if (checkRes.rows.length > 0) {
            await client.query(`
                ALTER TABLE tickets 
                RENAME COLUMN due_date TO end_date;
            `);
        } else {
            console.log('Column due_date does not exist, skipping rename.');
        }

        console.log('Migrating existing data: end_date values are preserved, start_date remains null');
        // No additional data migration needed - existing due_date is now end_date

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
