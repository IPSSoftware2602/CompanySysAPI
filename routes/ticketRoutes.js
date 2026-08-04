const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticketController');
const authMiddleware = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const v = require('../validators/ticketValidators');

router.use(authMiddleware.authenticateToken);

router.post('/', v.createTicket, validate, ticketController.createTicket);
router.get('/project/:projectId', ticketController.getProjectTickets);
router.get('/:id', v.idParam, validate, ticketController.getTicketById);
router.put('/:id', v.updateTicket, validate, ticketController.updateTicket);
router.delete('/:id', v.idParam, validate, ticketController.deleteTicket);
router.post('/:id/transition', v.transitionTicket, validate, ticketController.transitionTicket);
router.post('/:id/block', v.blockTicket, validate, ticketController.blockTicket);
router.post('/:id/unblock', v.idParam, validate, ticketController.unblockTicket);
router.post('/:id/members', v.idParam, validate, ticketController.addMember);
router.delete('/:id/members/:userId', ticketController.removeMember);
router.post('/reorder', ticketController.reorderTickets);
router.post('/search', ticketController.searchTickets);

module.exports = router;
