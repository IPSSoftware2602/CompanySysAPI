const { body, param } = require('express-validator');
const { SUPPORT_PRIORITIES, SUPPORT_REQUEST_TYPES, SUPPORT_STATUSES } = require('../constants');

const isUuid = (name) => param(name).isUUID().withMessage(`${name} must be a valid UUID`);

const createTicket = [
    body('title').isString().trim().notEmpty().withMessage('title is required'),
    body('priority').optional().isIn(SUPPORT_PRIORITIES).withMessage(`priority must be one of: ${SUPPORT_PRIORITIES.join(', ')}`),
    body('request_type').optional().isIn(SUPPORT_REQUEST_TYPES).withMessage(`request_type must be one of: ${SUPPORT_REQUEST_TYPES.join(', ')}`),
    body('supporting_project_id').optional({ nullable: true }).isUUID().withMessage('supporting_project_id must be a UUID'),
    body('assigned_pm_id').optional({ nullable: true }).isUUID(),
    body('assigned_dev_id').optional({ nullable: true }).isUUID(),
];

const updateTicket = [
    isUuid('id'),
    body('priority').optional().isIn(SUPPORT_PRIORITIES).withMessage(`priority must be one of: ${SUPPORT_PRIORITIES.join(', ')}`),
    body('status').optional().isIn(SUPPORT_STATUSES).withMessage(`status must be one of: ${SUPPORT_STATUSES.join(', ')}`),
];

const transitionTicket = [
    isUuid('id'),
    body('status').optional().isIn(SUPPORT_STATUSES).withMessage(`status must be one of: ${SUPPORT_STATUSES.join(', ')}`),
];

const blockTicket = [
    isUuid('id'),
    body('reason').isString().trim().notEmpty().withMessage('reason is required to block a ticket'),
];

const convertToTicket = [
    isUuid('id'),
    body('project_id').isUUID().withMessage('project_id (target dev project) is required and must be a UUID'),
    body('list_id').optional({ nullable: true }).isUUID().withMessage('list_id must be a UUID'),
];

const linkTicket = [
    isUuid('id'),
    body('ticket_id').isUUID().withMessage('ticket_id is required and must be a UUID'),
];

const idParam = [isUuid('id')];

module.exports = {
    createTicket, updateTicket, transitionTicket,
    blockTicket, convertToTicket, linkTicket, idParam,
};
