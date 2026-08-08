const express = require("express");
const stockController = require("../controllers/stock.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every stock route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped, read-only stock history.
router.get("/businesses/:businessId/stocks", stockController.listStocks);

// Per-batch consumption ledger for the History modal.
router.get(
  "/businesses/:businessId/stocks/:stockId/history",
  stockController.getStockHistory
);

module.exports = router;
