const express = require('express');
const router = express.Router();
const supportTicketController = require('../controllers/supportTicketController');
const { authenticateToken } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const v = require('../validators/supportTicketValidators');

router.post('/', authenticateToken, v.createTicket, validate, supportTicketController.createTicket);
router.post('/:id/transition', authenticateToken, v.transitionTicket, validate, supportTicketController.transitionTicket);
router.put('/:id', authenticateToken, v.updateTicket, validate, supportTicketController.updateTicket);
router.delete('/:id', authenticateToken, v.idParam, validate, supportTicketController.deleteSupportTicket);
router.get('/board', authenticateToken, supportTicketController.getBoardTickets);
router.post('/:id/block', authenticateToken, v.blockTicket, validate, supportTicketController.blockSupportTicket);
router.post('/:id/unblock', authenticateToken, v.idParam, validate, supportTicketController.unblockSupportTicket);
router.post('/:id/convert', authenticateToken, v.convertToTicket, validate, supportTicketController.convertToTicket);
router.post('/:id/link', authenticateToken, v.linkTicket, validate, supportTicketController.linkTicket);

module.exports = router;
