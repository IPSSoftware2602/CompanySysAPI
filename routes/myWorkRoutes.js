const express = require('express');
const router = express.Router();
const myWorkController = require('../controllers/myWorkController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.use(authenticateToken);

router.get('/', myWorkController.getMyWork);

module.exports = router;
