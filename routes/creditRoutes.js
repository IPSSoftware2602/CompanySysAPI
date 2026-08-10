const express = require('express');
const router = express.Router();
const creditController = require('../controllers/creditController');
const { authenticateToken } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const v = require('../validators/creditValidators');

const isAdmin = (req, res, next) => {
    console.log('Checking Admin Role for:', req.user.role);
    if (['ADMIN', 'CEO', 'PM'].includes(req.user.role)) {
        next();
    } else {
        console.log('Access Denied: Role not authorized');
        res.status(403).json({ error: 'Access denied' });
    }
};

// Get summary for admin
router.get('/summary', authenticateToken, isAdmin, creditController.getAdminSummary);

// Get specific user credits (Admin or Self - controller logic/middleware should refine 'Self' check if strictly needed, but verifyToken gives us req.user)
// For strict RBAC, add middleware to check if req.user.id == userId OR req.user.role == 'ADMIN'
// Get specific user credits
router.get('/user/:userId', authenticateToken, creditController.getUserCredits);

// Save/Update evaluation
router.post('/evaluation', authenticateToken, v.saveEvaluation, validate, creditController.saveEvaluation);

// Get specific evaluation
router.get('/evaluation/:id', authenticateToken, v.idParam, validate, creditController.getEvaluation);

module.exports = router;
