const express = require('express');
const router = express.Router();
const supportTicketController = require('../controllers/supportTicketController');
const { authenticateToken, requireAnyRole } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const v = require('../validators/supportTicketValidators');
const { MANAGER_ROLES } = require('../constants');

router.post('/', authenticateToken, v.createTicket, validate, supportTicketController.createTicket);
router.post('/:id/transition', authenticateToken, v.transitionTicket, validate, supportTicketController.transitionTicket);
router.put('/:id', authenticateToken, v.updateTicket, validate, supportTicketController.updateTicket);
router.delete('/:id', authenticateToken, v.idParam, validate, supportTicketController.deleteSupportTicket);
router.post('/:id/restore', authenticateToken, requireAnyRole(MANAGER_ROLES), v.idParam, validate, supportTicketController.restoreSupportTicket);
router.get('/board', authenticateToken, supportTicketController.getBoardTickets);
// Listed before /:id so "history" is never read as a ticket id.
router.get('/history', authenticateToken, supportTicketController.getHistory);
router.get('/:id/sla', authenticateToken, v.idParam, validate, supportTicketController.getSlaStatus);
router.post('/:id/block', authenticateToken, v.blockTicket, validate, supportTicketController.blockSupportTicket);
router.post('/:id/unblock', authenticateToken, v.idParam, validate, supportTicketController.unblockSupportTicket);
router.post('/:id/convert', authenticateToken, v.convertToTicket, validate, supportTicketController.convertToTicket);
router.post('/:id/link', authenticateToken, v.linkTicket, validate, supportTicketController.linkTicket);

// Review is soft by design: anyone may sign off, including the person who did
// the work. Rejecting requires a reason, which is posted into the comments.
router.post('/:id/review/approve', authenticateToken, v.idParam, validate, supportTicketController.approveReview);
router.post('/:id/review/reject', authenticateToken, v.rejectReview, validate, supportTicketController.rejectReview);

// Free-form checklist. Item routes are nested under the ticket so an item can
// never be touched through the wrong ticket.
router.get('/:id/checklist', authenticateToken, v.idParam, validate, supportTicketController.getChecklist);
router.post('/:id/checklist', authenticateToken, v.checklistItem, validate, supportTicketController.addChecklistItem);
// Before the :itemId route so "log" is never read as an item id.
router.get('/:id/checklist/log', authenticateToken, v.idParam, validate, supportTicketController.getChecklistLog);
router.put('/:id/checklist/:itemId', authenticateToken, v.checklistItem, validate, supportTicketController.updateChecklistItem);
router.delete('/:id/checklist/:itemId', authenticateToken, v.idParam, validate, supportTicketController.deleteChecklistItem);

module.exports = router;
