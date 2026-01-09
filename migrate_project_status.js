const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding PENDING and ONGOING to project_status enum...');
        await client.query(`
            ALTER TYPE project_status ADD VALUE IF NOT EXISTS 'PENDING';
            ALTER TYPE project_status ADD VALUE IF NOT EXISTS 'ONGOING';
        `);

        console.log('Successfully added PENDING and ONGOING to project_status');

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
