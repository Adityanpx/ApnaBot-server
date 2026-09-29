const express = require('express');
const router = express.Router();
const aiFlowController = require('../controllers/aiFlow.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireGraphEngine } = require('../middleware/flowGraph.middleware');
const { requireRole } = require('../middleware/role.middleware');

// Mounted at /api/flow-graph/ai ONLY when ENABLE_AI_FLOW_GEN=true (app.js).
// Same stack as flowGraph.routes.js: protect, requireBusiness,
// requireGraphEngine (which attaches req.graphBusiness for /apply's
// category/disabled-fields checks). Writes require requireRole('owner');
// /compile is read-only, so any business member may call it, mirroring the
// read-only preview endpoint.
router.use(protect, requireBusiness, requireGraphEngine);

// POST /compile - { spec } or { answers } -> compiled graph + warnings, no writes
router.post('/compile', aiFlowController.compileFlow);

// POST /apply - { spec } or { answers } -> snapshot current flow, then replace it
router.post('/apply', requireRole('owner'), aiFlowController.applyFlow);

module.exports = router;
