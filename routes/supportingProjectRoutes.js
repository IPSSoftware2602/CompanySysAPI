const express = require('express');
const router = express.Router();
const controller = require('../controllers/supportingProjectController');
const { authenticateToken } = require('../middleware/authMiddleware');

router.post('/', authenticateToken, controller.createProject);
router.get('/', authenticateToken, controller.getAllProjects);
router.get('/:id', authenticateToken, controller.getProjectById);
router.put('/:id', authenticateToken, controller.updateProject);
router.delete('/:id', authenticateToken, controller.deleteProject);

module.exports = router;
