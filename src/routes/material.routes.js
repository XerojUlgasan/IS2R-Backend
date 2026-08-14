const express = require("express");
const materialController = require("../controllers/material.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every material route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped: search must be registered before the generic list path.
router.get("/businesses/:businessId/materials/search", materialController.searchMaterials);
router.get("/businesses/:businessId/materials", materialController.listMaterials);
router.post("/businesses/:businessId/materials", materialController.createMaterial);

// Material-scoped: authorization resolves the material's business internally.
router.patch("/materials/:materialId", materialController.updateMaterial);
// router.delete("/materials/:materialId", materialController.deleteMaterial);
router.post("/materials/:materialId/stock", materialController.addStock);

module.exports = router;
