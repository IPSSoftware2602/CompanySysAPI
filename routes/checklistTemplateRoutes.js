const express = require('express');
const router = express.Router();
const checklistTemplateController = require('../controllers/checklistTemplateController');

router.get('/', checklistTemplateController.getAllTemplates);

module.exports = router;
