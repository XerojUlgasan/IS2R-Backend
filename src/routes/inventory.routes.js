const express = require("express");
const inventoryController = require("../controllers/inventory.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every inventory route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped, read-only aggregated report.
router.get("/businesses/:businessId/inventory-report", inventoryController.getInventoryReport);

module.exports = router;
