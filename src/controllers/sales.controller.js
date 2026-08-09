const salesService = require("../services/sales.service");

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

// GET /api/businesses/:businessId/sales — paginated, filtered sales list.
async function listSales(req, res) {
  const { status, materialId, dateFrom, dateTo } = req.query;

  if (status !== undefined && !salesService.VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be PENDING or PAID" });
  }
  if (dateFrom !== undefined && !isYmd(dateFrom)) {
    return res.status(400).json({ error: "dateFrom must be in YYYY-MM-DD format" });
  }
  if (dateTo !== undefined && !isYmd(dateTo)) {
    return res.status(400).json({ error: "dateTo must be in YYYY-MM-DD format" });
  }

  try {
    const result = await salesService.listSales(req.user.id, req.params.businessId, {
      page: parsePositiveInt(req.query.page, 1),
      limit: parsePositiveInt(req.query.limit, 30),
      status,
      materialId,
      dateFrom,
      dateTo,
    });
    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, "listSales");
  }
}

// POST /api/businesses/:businessId/sales — record a sale.
async function createSale(req, res) {
  const { materialId, qty_used, total_amount, status, remarks } = req.body || {};

  if (typeof materialId !== "string" || materialId.trim() === "") {
    return res.status(400).json({ error: "materialId is required" });
  }
  if (typeof qty_used !== "number" || Number.isNaN(qty_used) || qty_used <= 0) {
    return res.status(400).json({ error: "qty_used is required and must be a number greater than 0" });
  }
  if (typeof total_amount !== "number" || Number.isNaN(total_amount) || total_amount < 0) {
    return res.status(400).json({ error: "total_amount is required and must be a number of at least 0" });
  }
  if (status !== undefined && !salesService.VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be PENDING or PAID" });
  }
  if (remarks !== undefined && remarks !== null && typeof remarks !== "string") {
    return res.status(400).json({ error: "remarks must be a string" });
  }

  try {
    const sale = await salesService.createSale(req.user.id, req.params.businessId, {
      materialId,
      qty_used,
      total_amount,
      status: status || "PENDING",
      remarks,
    });
    return res.status(201).json({ sale });
  } catch (err) {
    return sendError(res, err, "createSale");
  }
}

// PATCH /api/sales/:saleId — update status and/or remarks.
async function updateSale(req, res) {
  const { status, remarks } = req.body || {};

  if (status !== undefined && !salesService.VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "status must be PENDING or PAID" });
  }
  if (remarks !== undefined && remarks !== null && typeof remarks !== "string") {
    return res.status(400).json({ error: "remarks must be a string" });
  }

  const updates = {};
  if (status !== undefined) updates.status = status;
  if (remarks !== undefined) updates.remarks = remarks;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No editable fields provided" });
  }

  try {
    const sale = await salesService.updateSale(req.user.id, req.params.saleId, updates);
    return res.status(200).json({ sale });
  } catch (err) {
    return sendError(res, err, "updateSale");
  }
}

// DELETE /api/sales/:saleId — soft-delete a sale and restore its stock.
async function deleteSale(req, res) {
  try {
    await salesService.deleteSale(req.user.id, req.params.saleId);
    return res.status(204).send();
  } catch (err) {
    return sendError(res, err, "deleteSale");
  }
}

// GET /api/businesses/:businessId/sales-report?period=<...> — analytics.
async function getSalesReport(req, res) {
  const period = req.query.period === undefined ? "daily" : req.query.period;

  if (!salesService.VALID_PERIODS.includes(period)) {
    return res.status(400).json({
      error: `period must be one of ${salesService.VALID_PERIODS.join(", ")}`,
    });
  }

  try {
    const report = await salesService.getSalesReport(req.user.id, req.params.businessId, period);
    return res.status(200).json({ report });
  } catch (err) {
    return sendError(res, err, "getSalesReport");
  }
}

module.exports = { listSales, createSale, updateSale, deleteSale, getSalesReport };
