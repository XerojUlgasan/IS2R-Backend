const express = require("express");
const stockController = require("../controllers/stock.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every stock route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped, read-only stock history.
router.get("/businesses/:businessId/stocks", stockController.listStocks);

module.exports = router;
