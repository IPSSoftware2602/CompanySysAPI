const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding ADMIN to user_role enum...');
        await client.query(`
            ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ADMIN';
        `);

        console.log('Successfully added ADMIN role');

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
