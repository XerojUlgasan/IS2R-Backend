const dashboardService = require("../services/dashboard.service");

// Maps a thrown error to the right HTTP response.
function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// GET /api/businesses/:businessId/dashboard?period=<weekly|monthly> — overview.
async function getDashboard(req, res) {
  const period = req.query.period === undefined ? "monthly" : req.query.period;

  if (!dashboardService.VALID_PERIODS.includes(period)) {
    return res.status(400).json({
      error: `period must be one of ${dashboardService.VALID_PERIODS.join(", ")}`,
    });
  }

  try {
    const summary = await dashboardService.getDashboard(req.user.id, req.params.businessId, period);
    return res.status(200).json({ summary });
  } catch (err) {
    return sendError(res, err, "getDashboard");
  }
}

module.exports = { getDashboard };
