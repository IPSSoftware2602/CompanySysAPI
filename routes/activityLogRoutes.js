const express = require('express');
const router = express.Router();
const activityLogController = require('../controllers/activityLogController');

router.get('/ticket/:ticketId', activityLogController.getTicketLogs);

module.exports = router;
