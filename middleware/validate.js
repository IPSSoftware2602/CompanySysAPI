const { validationResult } = require('express-validator');

/**
 * Runs after a validation chain array. Collects any failures into a single
 * 400 response. Lenient by design: chains only assert required fields, formats
 * and enum membership — unknown/extra keys are ignored so existing frontend
 * payloads keep working.
 */
function validate(req, res, next) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();

    return res.status(400).json({
        error: 'Validation failed',
        details: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
}

module.exports = validate;
