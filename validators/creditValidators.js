const { body, param } = require('express-validator');
const { CREDIT_STATUSES, CREDIT_SOURCES, CREDIT_TICKET_TYPES } = require('../constants');

const scoreField = (name) =>
    body(name).optional({ nullable: true }).isFloat({ min: 0, max: 100 })
        .withMessage(`${name} must be a number between 0 and 100`);

const saveEvaluation = [
    body('id').optional({ nullable: true }).isUUID().withMessage('id must be a UUID'),
    body('assignee_user_id').optional({ nullable: true }).isUUID().withMessage('assignee_user_id must be a UUID'),
    body('ticket_type').optional().isIn(CREDIT_TICKET_TYPES).withMessage(`ticket_type must be one of: ${CREDIT_TICKET_TYPES.join(', ')}`),
    body('status').optional().isIn(CREDIT_STATUSES).withMessage(`status must be one of: ${CREDIT_STATUSES.join(', ')}`),
    body('source').optional().isIn(CREDIT_SOURCES).withMessage(`source must be one of: ${CREDIT_SOURCES.join(', ')}`),
    scoreField('complexity_score'),
    scoreField('effectiveness_score'),
    scoreField('completeness_score'),
    scoreField('final_score'),
    body('final_credit').optional({ nullable: true }).isFloat().withMessage('final_credit must be a number'),
];

const idParam = [param('id').isUUID().withMessage('id must be a valid UUID')];

module.exports = { saveEvaluation, idParam };
