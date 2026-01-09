const db = require('./db');

async function checkColumn() {
    try {
        const result = await db.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='users' AND column_name='deleted_at';
        `);

        if (result.rows.length > 0) {
            console.log("✅ 'deleted_at' column exists in 'users' table.");
        } else {
            console.error("❌ 'deleted_at' column MISSING in 'users' table.");
        }
        process.exit(0);
    } catch (error) {
        console.error("Error checking column:", error);
        process.exit(1);
    }
}

checkColumn();
