const { body, param } = require('express-validator');
const { TICKET_TYPES, TICKET_STATUSES } = require('../constants');

const isUuid = (name) => param(name).isUUID().withMessage(`${name} must be a valid UUID`);

const createTicket = [
    body('project_id').isUUID().withMessage('project_id is required and must be a UUID'),
    body('title').isString().trim().notEmpty().withMessage('title is required'),
    body('type').optional().isIn(TICKET_TYPES).withMessage(`type must be one of: ${TICKET_TYPES.join(', ')}`),
    body('description').optional({ nullable: true }).isString(),
];

const updateTicket = [
    isUuid('id'),
    body('title').optional().isString().trim().notEmpty().withMessage('title cannot be empty'),
    body('type').optional().isIn(TICKET_TYPES).withMessage(`type must be one of: ${TICKET_TYPES.join(', ')}`),
    body('status').optional().isIn(TICKET_STATUSES).withMessage(`status must be one of: ${TICKET_STATUSES.join(', ')}`),
];

const transitionTicket = [
    isUuid('id'),
    // Either an explicit target status, or a list to move into, must be present.
    body().custom((value, { req }) => {
        const { to_status, targetStatus, to_list_id } = req.body;
        if (!to_status && !targetStatus && !to_list_id) {
            throw new Error('One of to_status, targetStatus or to_list_id is required');
        }
        const status = to_status || targetStatus;
        if (status && !TICKET_STATUSES.includes(status)) {
            throw new Error(`status must be one of: ${TICKET_STATUSES.join(', ')}`);
        }
        return true;
    }),
];

const blockTicket = [
    isUuid('id'),
    body('reason').isString().trim().notEmpty().withMessage('reason is required to block a ticket'),
];

const idParam = [isUuid('id')];

module.exports = { createTicket, updateTicket, transitionTicket, blockTicket, idParam };
