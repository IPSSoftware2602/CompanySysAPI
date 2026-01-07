const express = require('express');
const router = express.Router();
const labelController = require('../controllers/labelController');

router.post('/', labelController.createLabel);
router.get('/project/:projectId', labelController.getProjectLabels);
router.get('/ticket/:ticketId', labelController.getTicketLabels);
router.post('/ticket/:ticketId', labelController.addLabelToTicket);
router.delete('/ticket/:ticketId/:labelId', labelController.removeLabelFromTicket);
router.delete('/:id', labelController.deleteLabel);

module.exports = router;
