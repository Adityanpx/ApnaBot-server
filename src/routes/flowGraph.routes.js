const express = require('express');
const router = express.Router();
const flowGraphController = require('../controllers/flowGraph.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireGraphEngine } = require('../middleware/flowGraph.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness, requireGraphEngine
// POST, PUT, DELETE also require: requireRole('owner')
// GET, toggle also allow 'staff' (mirrors rule.routes.js)

router.use(protect, requireBusiness, requireGraphEngine);

// GET /reply-nodes - List reply-type flow_nodes
router.get('/reply-nodes', flowGraphController.getReplyNodes);

// POST /reply-nodes - Create a reply node (no buttons/listOptions - see
// flowGraph.controller.js#createReplyNode doc comment; add those via
// POST /edges below)
router.post('/reply-nodes', requireRole('owner'), flowGraphController.createReplyNode);

// PUT /reply-nodes/:id - Update a reply node's own fields
router.put('/reply-nodes/:id', requireRole('owner'), flowGraphController.updateReplyNode);

// DELETE /reply-nodes/:id - Delete a reply node (blocked if other nodes'
// edges target it - see doc comment)
router.delete('/reply-nodes/:id', requireRole('owner'), flowGraphController.deleteReplyNode);

// PUT /reply-nodes/:id/toggle - Toggle isActive
router.put('/reply-nodes/:id/toggle', flowGraphController.toggleReplyNode);

// GET /question-nodes - List question/vehicle_carousel/rentalPackage flow_nodes
router.get('/question-nodes', flowGraphController.getQuestionNodes);

// POST /question-nodes - Create an authored question node (isolated, no
// edges - wire it in via POST /edges below)
router.post('/question-nodes', requireRole('owner'), flowGraphController.createQuestionNode);

// PUT /question-nodes/:id - Update an authored question node's own fields
// (computed nodes are unreachable through this endpoint - see controller)
router.put('/question-nodes/:id', requireRole('owner'), flowGraphController.updateQuestionNode);

// DELETE /question-nodes/:id - Delete a question/vehicle_carousel/
// rentalPackage node (blocked by the reserved-key/fallback-sibling guards;
// the reachability guard alone accepts { force: true } to proceed anyway -
// see flowGraph.controller.js#deleteQuestionNode)
router.delete('/question-nodes/:id', requireRole('owner'), flowGraphController.deleteQuestionNode);

// GET /full - Entire graph in one response (all reply nodes, all question
// nodes, all edges) - for the flow editor, avoids N+1 client-side fetching.
// Registered before /edges so it's unambiguous as its own literal path.
router.get('/full', flowGraphController.getFullGraph);

// PUT /full - Batch-save the entire desired end state (canvas editor save
// button). Diffs against current DB state; validates the proposed end state
// as a whole before writing anything - see flowGraph.controller.js#saveFullGraph.
router.put('/full', requireRole('owner'), flowGraphController.saveFullGraph);

// GET /edges?fromNodeId= - Outgoing edges for one node
router.get('/edges', flowGraphController.getEdges);

// POST /edges - Create one edge (surgical - see flowGraph.controller.js#createEdge)
router.post('/edges', requireRole('owner'), flowGraphController.createEdge);

// PUT /edges/reorder - Batch reorder a node's outgoing edges' display_order.
// Registered BEFORE /edges/:id so 'reorder' isn't swallowed as an :id value.
router.put('/edges/reorder', requireRole('owner'), flowGraphController.reorderEdges);

// PUT /edges/:id - Surgical edit (retarget/condition/label/description/
// displayOrder) - updates the row in place, never replaces it (Finding A:
// an edge's id is a live WhatsApp interaction id)
router.put('/edges/:id', requireRole('owner'), flowGraphController.updateEdge);

// DELETE /edges/:id - Remove one edge (reachability re-validated first)
router.delete('/edges/:id', requireRole('owner'), flowGraphController.deleteEdge);

module.exports = router;
