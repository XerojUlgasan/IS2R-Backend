const express = require("express");
const auditController = require("../controllers/audit.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every audit-log route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped, read-only, owner only.
router.get("/businesses/:businessId/audit-logs", auditController.listAuditLogs);

module.exports = router;
