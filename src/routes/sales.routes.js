const express = require("express");
const salesController = require("../controllers/sales.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every sales route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped: list and create live under the business.
router.get("/businesses/:businessId/sales", salesController.listSales);
router.post("/businesses/:businessId/sales", salesController.createSale);

// Business-scoped, read-only aggregated analytics.
router.get("/businesses/:businessId/sales-report", salesController.getSalesReport);

// Sale-scoped: require businessId in the URL and verify membership.
router.patch("/businesses/:businessId/sales/:saleId", salesController.updateSale);
router.delete("/businesses/:businessId/sales/:saleId", salesController.deleteSale);

module.exports = router;
