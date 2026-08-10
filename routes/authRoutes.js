const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/authController');

/**
 * bcrypt makes each guess slow, but nothing stopped an attacker making them
 * indefinitely. This caps the attempt rate per IP.
 *
 * 10 attempts per 15 minutes is generous for a team of five — a real person
 * fat-fingering a password three times in a row never notices it — while
 * reducing an online brute force to a rate that is not worth running.
 *
 * skipSuccessfulRequests means a working login does not consume budget, so an
 * active user is never locked out by their own normal use.
 */
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// Registration is rarer and more consequential than login, so it is tighter.
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many registration attempts. Try again later.' },
});

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginLimiter, authController.login);

module.exports = router;
