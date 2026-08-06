const express = require("express");
const salesController = require("../controllers/sales.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every sales route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped: list and create live under the business.
router.get("/businesses/:businessId/sales", salesController.listSales);
router.post("/businesses/:businessId/sales", salesController.createSale);

// Sale-scoped: authorization resolves the sale's business internally.
router.patch("/sales/:saleId", salesController.updateSale);
router.delete("/sales/:saleId", salesController.deleteSale);

module.exports = router;
