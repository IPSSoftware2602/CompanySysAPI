const express = require('express');
const router = express.Router();
const creditController = require('../controllers/creditController');
const { verifyToken, isAdmin } = require('../middleware/authMiddleware');

// Get summary for admin
router.get('/summary', verifyToken, isAdmin, creditController.getAdminSummary);

// Get specific user credits (Admin or Self - controller logic/middleware should refine 'Self' check if strictly needed, but verifyToken gives us req.user)
// For strict RBAC, add middleware to check if req.user.id == userId OR req.user.role == 'ADMIN'
router.get('/user/:userId', verifyToken, creditController.getUserCredits);

// Save/Update evaluation
router.post('/evaluation', verifyToken, creditController.saveEvaluation);

module.exports = router;
