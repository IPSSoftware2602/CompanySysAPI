const express = require('express');
const router = express.Router();
const timeLogController = require('../controllers/timeLogController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Period routes come before /:id so "period" is never parsed as an id.
router.get('/period/status', authenticateToken, timeLogController.periodStatus);
router.post('/period/lock', authenticateToken, timeLogController.lockPeriod);

router.post('/', authenticateToken, timeLogController.create);
router.get('/', authenticateToken, timeLogController.list);
router.patch('/:id', authenticateToken, timeLogController.update);
router.delete('/:id', authenticateToken, timeLogController.remove);
router.post('/:id/transition', authenticateToken, timeLogController.transition);
router.post('/:id/correct', authenticateToken, timeLogController.correct);

module.exports = router;
