require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'ios_db',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function seedUsers() {
    try {
        const passwordHash = await bcrypt.hash('password123', 10);

        // Tech Lead
        await pool.query(`
      INSERT INTO users (email, password_hash, role, full_name)
      VALUES ('waikeat@company.com', $1, 'TECH_LEAD', 'Waikeat')
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash]);

        // Developer
        await pool.query(`
      INSERT INTO users (email, password_hash, role, full_name)
      VALUES ('eugene@company.com', $1, 'DEV', 'Eugene')
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash]);

        console.log('Seeded users: Waikeat (TECH_LEAD) and Eugene (DEV)');
    } catch (err) {
        console.error('Error seeding users:', err);
    } finally {
        await pool.end();
    }
}

seedUsers();
