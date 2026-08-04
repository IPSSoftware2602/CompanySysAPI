require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/**
 * Environment configuration with fail-fast validation.
 *
 * JWT_SECRET intentionally has NO fallback. A hardcoded default meant any token
 * signed with that publicly-known string was accepted as valid — including one
 * claiming an admin role. Refusing to boot is the correct, loud failure.
 */
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error(
        'JWT_SECRET is not set.\n' +
        'Refusing to start rather than fall back to an insecure default.\n' +
        'Set it in .env (local) or as an environment variable (production).'
    );
}

if (JWT_SECRET === 'super_secret_key_change_me') {
    throw new Error(
        'JWT_SECRET is still the old hardcoded default value.\n' +
        'This value is published in the git history and must not be used. Generate a new one:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
}

module.exports = { JWT_SECRET };
