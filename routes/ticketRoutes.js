const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');

router.post('/', ticketController.createTicket);
router.get('/project/:projectId', ticketController.getProjectTickets);
router.get('/:id', ticketController.getTicketById);
router.put('/:id', ticketController.updateTicket);
router.post('/:id/transition', ticketController.transitionTicket);
router.post('/:id/members', ticketController.addMember);
router.delete('/:id/members/:userId', ticketController.removeMember);
router.post('/reorder', ticketController.reorderTickets);
router.post('/search', ticketController.searchTickets);

module.exports = router;
