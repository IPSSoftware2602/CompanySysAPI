const db = require('./db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('Adding deleted_at column to users table...');
        await client.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;
        `);

        console.log('Successfully added deleted_at column');

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
