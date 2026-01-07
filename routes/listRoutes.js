const express = require('express');
const router = express.Router();
const listController = require('../controllers/listController');

router.post('/', listController.createList);
router.get('/project/:projectId', listController.getProjectLists);
router.put('/:id', listController.updateList);
router.delete('/:id', listController.deleteList);
router.post('/project/:projectId/reorder', listController.reorderLists);

module.exports = router;
