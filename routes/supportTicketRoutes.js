const express = require('express');
const router = express.Router();
const supportTicketController = require('../controllers/supportTicketController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.post('/', authenticateToken, supportTicketController.createTicket);
router.post('/:id/transition', authenticateToken, supportTicketController.transitionTicket);
router.post('/:id/transition', authenticateToken, supportTicketController.transitionTicket);
router.put('/:id', authenticateToken, supportTicketController.updateTicket);
router.get('/board', authenticateToken, supportTicketController.getBoardTickets);
// Let's add simple list fetch to controller first
// But wait, controller didn't have list fetch yet. 
// I'll add search/list logic to controller in a separate step or just update it now if I can.
// Let's stick to the plan: I need get logic for the board.

module.exports = router;
