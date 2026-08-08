const inventoryService = require("../services/inventory.service");

// Maps a thrown error to the right HTTP response.
function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// GET /api/businesses/:businessId/inventory-report?period=<...> — analytics.
async function getInventoryReport(req, res) {
  const period = req.query.period === undefined ? "weekly" : req.query.period;

  if (!inventoryService.VALID_PERIODS.includes(period)) {
    return res.status(400).json({
      error: `period must be one of ${inventoryService.VALID_PERIODS.join(", ")}`,
    });
  }

  try {
    const report = await inventoryService.getInventoryReport(
      req.user.id,
      req.params.businessId,
      period
    );
    return res.status(200).json({ report });
  } catch (err) {
    return sendError(res, err, "getInventoryReport");
  }
}

module.exports = { getInventoryReport };
