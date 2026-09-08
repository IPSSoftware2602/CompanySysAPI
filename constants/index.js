/**
 * Centralized domain constants.
 *
 * These mirror the ACTUAL PostgreSQL enum types in ios_db (verified against the
 * live schema, not schema.sql which is stale). Do not add a value here without
 * also adding it to the corresponding enum via a migration, or validation will
 * reject rows the database would otherwise accept and vice-versa.
 */

// ---- Users ----
const USER_ROLES = ['CEO', 'TECH_LEAD', 'PM', 'QA', 'DEV', 'FINANCE', 'ADMIN'];

// Roles allowed to act on behalf of / view other users' work, lock credits, etc.
const MANAGER_ROLES = ['CEO', 'TECH_LEAD', 'PM', 'ADMIN'];

// ---- Kanban tickets ----
const TICKET_TYPES = ['FEATURE', 'BUG', 'CHANGE_REQUEST'];
const TICKET_STATUSES = [
    'BACKLOG', 'TECH_DESIGN', 'READY_FOR_DEV', 'IN_PROGRESS',
    'CODE_REVIEW', 'QA', 'READY_TO_DEPLOY', 'DONE',
];
// Terminal status: a ticket here is no longer "active work".
const TICKET_DONE_STATUSES = ['DONE'];
// Statuses that mean "waiting on a human review gate" (used by My Work).
const TICKET_REVIEW_STATUSES = ['CODE_REVIEW', 'QA'];

// ---- Support tickets ----
const SUPPORT_PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const SUPPORT_REQUEST_TYPES = ['BUG', 'AMENDMENT', 'CHANGE_REQUEST', 'FEATURE', 'QUESTION', 'DATA_ISSUE'];
const SUPPORT_STATUSES = [
    'NEW', 'DOING', 'WAITING_FOR_CLIENT',
    'TESTING', 'PENDING_DEPLOYMENT', 'COMPLETED', 'CLOSED', 'CANCELLED',
];
// Terminal statuses: no longer active support work.
// CANCELLED is terminal but NOT resolved — work that never happened. Counting
// it as done would flatter every delivery metric that reads this list.
const SUPPORT_DONE_STATUSES = ['COMPLETED', 'CLOSED', 'CANCELLED'];
// "Awaiting review/verification" gate for My Work.
const SUPPORT_REVIEW_STATUSES = ['TESTING', 'PENDING_DEPLOYMENT'];

// Priorities that make a support ticket urgent on their own, before any SLA
// clock is consulted. Used by the dashboard's urgent section.
const SUPPORT_URGENT_PRIORITIES = ['P0', 'P1'];

// How long a finished ticket stays on the board after it is closed. Past this
// it lives only in History — a Closed column that grows forever stops being a
// board and becomes an archive nobody scrolls.
const SUPPORT_BOARD_CLOSED_DAYS = 30;

// Terminal states that belong in History rather than on the board. COMPLETED is
// deliberately NOT one: it is waiting on a review, which is live work.
const SUPPORT_ARCHIVED_STATUSES = ['CLOSED', 'CANCELLED'];

// Maps a support request_type onto a kanban ticket_type when converting.
const SUPPORT_TO_TICKET_TYPE = {
    BUG: 'BUG',
    FEATURE: 'FEATURE',
    AMENDMENT: 'CHANGE_REQUEST',
    CHANGE_REQUEST: 'CHANGE_REQUEST',
    QUESTION: 'CHANGE_REQUEST',
    DATA_ISSUE: 'CHANGE_REQUEST',
};

// ---- Credits ----
const CREDIT_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'ADJUSTED', 'REJECTED'];
const CREDIT_SOURCES = ['SELF', 'COORDINATOR'];
const CREDIT_TICKET_TYPES = ['KANBAN', 'SUPPORT'];

// ---- Time logging ----
const TIME_LOG_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'LOCKED'];
// Past these, an entry is part of a billing record and must not be mutated.
// Corrections create a new entry pointing at the original via corrects_entry_id.
const TIME_LOG_IMMUTABLE_STATUSES = ['APPROVED', 'LOCKED'];
// Allowed transitions. A rejected submission goes back to DRAFT for editing.
const TIME_LOG_TRANSITIONS = {
    DRAFT: ['SUBMITTED'],
    SUBMITTED: ['APPROVED', 'DRAFT'],
    APPROVED: ['LOCKED', 'DRAFT'],
    LOCKED: [],
};
// Rounding applied at report/invoice time only — never stored.
const TIME_ROUNDING_MODES = ['EXACT', 'NEAREST_15', 'UP_15', 'UP_PER_DAY_15'];

// ---- Audit log ----
// Entity types recorded in audit_logs.
const AUDIT_ENTITY = {
    TICKET: 'TICKET',
    SUPPORT_TICKET: 'SUPPORT_TICKET',
    // Checklist changes are logged against the TICKET id, not the item id, so
    // "what happened to this ticket's checklist" is one query.
    SUPPORT_CHECKLIST: 'SUPPORT_CHECKLIST',
    CREDIT_EVALUATION: 'CREDIT_EVALUATION',
    TIME_LOG: 'TIME_LOG',
    // One row per webhook delivery from IRIS, payload verbatim in after_data.
    IRIS_EVENT: 'IRIS_EVENT',
};
// Action verbs recorded in audit_logs.
const AUDIT_ACTION = {
    CREATE: 'CREATE',
    UPDATE: 'UPDATE',
    DELETE: 'DELETE',
    STATUS_CHANGE: 'STATUS_CHANGE',
    BLOCK: 'BLOCK',
    UNBLOCK: 'UNBLOCK',
    CONVERT: 'CONVERT',
    LINK: 'LINK',
    LOCK: 'LOCK',
    RESTORE: 'RESTORE',
    // Emitted by jobs/slaBreachCheck.js. Doubles as the de-duplication key:
    // one warning and one breach notification per ticket, ever.
    SLA_WARNING: 'SLA_WARNING',
    SLA_BREACH: 'SLA_BREACH',
};

module.exports = {
    USER_ROLES,
    MANAGER_ROLES,
    TICKET_TYPES,
    TICKET_STATUSES,
    TICKET_DONE_STATUSES,
    TICKET_REVIEW_STATUSES,
    SUPPORT_PRIORITIES,
    SUPPORT_REQUEST_TYPES,
    SUPPORT_STATUSES,
    SUPPORT_DONE_STATUSES,
    SUPPORT_REVIEW_STATUSES,
    SUPPORT_URGENT_PRIORITIES,
    SUPPORT_BOARD_CLOSED_DAYS,
    SUPPORT_ARCHIVED_STATUSES,
    SUPPORT_TO_TICKET_TYPE,
    CREDIT_STATUSES,
    CREDIT_SOURCES,
    CREDIT_TICKET_TYPES,
    TIME_LOG_STATUSES,
    TIME_LOG_IMMUTABLE_STATUSES,
    TIME_LOG_TRANSITIONS,
    TIME_ROUNDING_MODES,
    AUDIT_ENTITY,
    AUDIT_ACTION,
};
