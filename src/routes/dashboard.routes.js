const express = require("express");
const dashboardController = require("../controllers/dashboard.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every dashboard route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped, read-only aggregated overview.
router.get("/businesses/:businessId/dashboard", dashboardController.getDashboard);

module.exports = router;
