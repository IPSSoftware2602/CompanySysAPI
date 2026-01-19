const express = require('express');
const router = express.Router();
const supportTicketController = require('../controllers/supportTicketController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.post('/', authenticateToken, supportTicketController.createTicket);
router.post('/:id/transition', authenticateToken, supportTicketController.transitionTicket);
router.put('/:id', authenticateToken, supportTicketController.updateTicket);
router.delete('/:id', authenticateToken, supportTicketController.deleteSupportTicket);
router.get('/board', authenticateToken, supportTicketController.getBoardTickets);

module.exports = router;
