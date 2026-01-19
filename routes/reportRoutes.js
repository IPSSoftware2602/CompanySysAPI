const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.get('/performance', authenticateToken, reportController.getPerformanceReport);

module.exports = router;
