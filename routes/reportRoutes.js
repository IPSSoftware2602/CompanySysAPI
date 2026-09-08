const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { authenticateToken } = require('../middleware/authMiddleware');

const timeReportController = require('../controllers/timeReportController');
const supportReportController = require('../controllers/supportReportController');

router.get('/performance', authenticateToken, reportController.getPerformanceReport);
router.get('/time', authenticateToken, timeReportController.getTimeReport);
router.get('/time/estimate-vs-actual', authenticateToken, timeReportController.getEstimateVsActual);
router.get('/support', authenticateToken, supportReportController.getSupportReport);

module.exports = router;
