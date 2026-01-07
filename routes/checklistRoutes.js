const express = require('express');
const router = express.Router();
const checklistController = require('../controllers/checklistController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware.authenticateToken);

router.post('/', checklistController.createChecklist);
router.post('/template', checklistController.createFromTemplate);
router.get('/ticket/:ticketId', checklistController.getTicketChecklists);
router.delete('/:id', checklistController.deleteChecklist);
router.patch('/:id', checklistController.updateChecklist);

router.post('/items', checklistController.addItem);
router.put('/items/:id', checklistController.updateItem);
router.delete('/items/:id', checklistController.deleteItem);

router.post('/:id/complete', checklistController.completeChecklist);

module.exports = router;
