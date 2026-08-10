const dashboardService = require("../services/dashboard.service");

// Maps a thrown error to the right HTTP response.
function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// GET /api/businesses/:businessId/dashboard — overview.
// The legacy `period` query param is ignored; both weekly and monthly figures
// are always returned under summary.periods.
async function getDashboard(req, res) {
  try {
    const summary = await dashboardService.getDashboard(req.user.id, req.params.businessId);
    return res.status(200).json({ summary });
  } catch (err) {
    return sendError(res, err, "getDashboard");
  }
}

module.exports = { getDashboard };
