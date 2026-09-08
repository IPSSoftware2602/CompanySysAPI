const { body, param } = require('express-validator');
const validator = require('validator');
const { SUPPORT_PRIORITIES, SUPPORT_REQUEST_TYPES, SUPPORT_STATUSES } = require('../constants');

// A cleared <select> posts "", which is neither a UUID nor null. Treated as
// "unset" so clearing an assignee from the modal is not a validation error.
const optionalUuid = (name) => body(name)
    .optional({ nullable: true })
    .custom((value) => value === '' || validator.isUUID(String(value)))
    .withMessage(`${name} must be a UUID`);

const isUuid = (name) => param(name).isUUID().withMessage(`${name} must be a valid UUID`);

const createTicket = [
    body('title').isString().trim().notEmpty().withMessage('title is required'),
    body('priority').optional().isIn(SUPPORT_PRIORITIES).withMessage(`priority must be one of: ${SUPPORT_PRIORITIES.join(', ')}`),
    body('request_type').optional().isIn(SUPPORT_REQUEST_TYPES).withMessage(`request_type must be one of: ${SUPPORT_REQUEST_TYPES.join(', ')}`),
    body('supporting_project_id').optional({ nullable: true }).isUUID().withMessage('supporting_project_id must be a UUID'),
    optionalUuid('assigned_dev_id'),
    optionalUuid('project_id'),
    optionalUuid('tech_lead_id'),
    optionalUuid('reviewer_user_id'),
];

// The edit modal saves every field at once, so all of them are validated here.
const updateTicket = [
    isUuid('id'),
    body('title').optional().isString().trim().notEmpty().withMessage('title cannot be blank'),
    body('priority').optional().isIn(SUPPORT_PRIORITIES).withMessage(`priority must be one of: ${SUPPORT_PRIORITIES.join(', ')}`),
    body('request_type').optional().isIn(SUPPORT_REQUEST_TYPES).withMessage(`request_type must be one of: ${SUPPORT_REQUEST_TYPES.join(', ')}`),
    body('status').optional().isIn(SUPPORT_STATUSES).withMessage(`status must be one of: ${SUPPORT_STATUSES.join(', ')}`),
    optionalUuid('project_id'),
    optionalUuid('supporting_project_id'),
    optionalUuid('company_id'),
    optionalUuid('assigned_dev_id'),
    optionalUuid('tech_lead_id'),
    optionalUuid('reviewer_user_id'),
];

const rejectReview = [
    isUuid('id'),
    body('reason').isString().trim().notEmpty().withMessage('reason is required to reject a review'),
];

const checklistItem = [
    isUuid('id'),
    body('content').optional().isString().trim().notEmpty().withMessage('content cannot be blank'),
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
    rejectReview, checklistItem,
};
