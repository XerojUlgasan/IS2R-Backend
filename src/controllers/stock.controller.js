const stockService = require("../services/stock.service");

// Maps a thrown error to the right HTTP response.
function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// Parses a positive integer query param, falling back to a default.
function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Checks a string is a YYYY-MM-DD date.
function isYmd(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// GET /api/businesses/:businessId/stocks — paginated, filtered stock history.
async function listStocks(req, res) {
  const { status, materialId, dateFrom, dateTo } = req.query;

  if (status !== undefined && !stockService.VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be AVAILABLE or CONSUMED" });
  }
  if (dateFrom !== undefined && !isYmd(dateFrom)) {
    return res.status(400).json({ error: "dateFrom must be in YYYY-MM-DD format" });
  }
  if (dateTo !== undefined && !isYmd(dateTo)) {
    return res.status(400).json({ error: "dateTo must be in YYYY-MM-DD format" });
  }

  try {
    const result = await stockService.listStocks(req.user.id, req.params.businessId, {
      page: parsePositiveInt(req.query.page, 1),
      limit: parsePositiveInt(req.query.limit, 30),
      status,
      materialId,
      dateFrom,
      dateTo,
    });
    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, "listStocks");
  }
}

// GET /api/businesses/:businessId/stocks/:stockId/history — paginated consumption ledger.
async function getStockHistory(req, res) {
  try {
    const result = await stockService.getStockHistory(
      req.user.id,
      req.params.businessId,
      req.params.stockId,
      {
        page: parsePositiveInt(req.query.page, 1),
        limit: parsePositiveInt(req.query.limit, 20),
      }
    );
    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, "getStockHistory");
  }
}

module.exports = { listStocks, getStockHistory };
