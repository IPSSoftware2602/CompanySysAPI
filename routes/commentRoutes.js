const express = require('express');
const router = express.Router();
const commentController = require('../controllers/commentController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.post('/', authenticateToken, commentController.createComment);
router.get('/ticket/:ticketId', authenticateToken, commentController.getTicketComments);
router.get('/support-ticket/:ticketId', authenticateToken, commentController.getSupportTicketComments);
router.delete('/:id', authenticateToken, commentController.deleteComment);
router.put('/:id', authenticateToken, commentController.updateComment);

module.exports = router;
