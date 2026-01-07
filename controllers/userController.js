const db = require('../db');

exports.getAllUsers = async (req, res) => {
    try {
        const result = await db.query('SELECT id, full_name, email, role FROM users ORDER BY full_name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
};

exports.createUser = async (req, res) => {
    try {
        const { email, password, role, full_name } = req.body;
        const User = require('../models/userModel');
        const bcrypt = require('bcryptjs');

        const existingUser = await User.findByEmail(email);
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const password_hash = await bcrypt.hash(password, 10);
        const user = await User.create({ email, password_hash, role, full_name });

        delete user.password_hash;
        res.status(201).json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create user' });
    }
};

exports.updateUser = async (req, res) => {
    try {
        const { password } = req.body;
        const updateData = { ...req.body };

        if (password) {
            const bcrypt = require('bcryptjs');
            updateData.password_hash = await bcrypt.hash(password, 10);
            delete updateData.password;
        }

        const User = require('../models/userModel');
        const user = await User.update(req.params.id, updateData);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update user' });
    }
};

exports.deleteUser = async (req, res) => {
    try {
        const User = require('../models/userModel');
        await User.delete(req.params.id);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
};
