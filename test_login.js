require('dotenv').config();
const bcrypt = require('bcryptjs');
const User = require('./models/userModel');

async function testLogin() {
    try {
        const email = 'waikeat@company.com';
        const password = 'password123';

        console.log('Testing login for:', email);

        const user = await User.findByEmail(email);
        console.log('User found:', user ? 'Yes' : 'No');

        if (!user) {
            console.log('User not found!');
            return;
        }

        console.log('User data:', user);
        console.log('Password hash:', user.password_hash);

        const validPassword = await bcrypt.compare(password, user.password_hash);
        console.log('Password valid:', validPassword);

        if (validPassword) {
            console.log('✅ Login successful!');
        } else {
            console.log('❌ Password is invalid!');
        }

    } catch (err) {
        console.error('Error during test:', err);
    }

    process.exit(0);
}

testLogin();
