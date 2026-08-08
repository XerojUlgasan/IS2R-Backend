const expenseService = require("../services/expense.service");

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

// Validates a title value; returns an error message or null.
function validateTitle(title) {
  if (typeof title !== "string" || title.trim() === "") {
    return "title is required and must be a non-empty string";
  }
  return null;
}

// Validates a category value; returns an error message or null.
function validateCategory(category) {
  if (typeof category !== "string" || category.trim() === "") {
    return "category is required and must be a non-empty string";
  }
  return null;
}

// Validates an amount value (non-negative integer); returns an error message or null.
function validateAmount(amount) {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    return "amount is required and must be a non-negative integer";
  }
  return null;
}

// GET /api/businesses/:businessId/expenses — paginated, filtered expense list.
async function listExpenses(req, res) {
  const { category, dateFrom, dateTo } = req.query;

  if (dateFrom !== undefined && !isYmd(dateFrom)) {
    return res.status(400).json({ error: "dateFrom must be in YYYY-MM-DD format" });
  }
  if (dateTo !== undefined && !isYmd(dateTo)) {
    return res.status(400).json({ error: "dateTo must be in YYYY-MM-DD format" });
  }

  try {
    const result = await expenseService.listExpenses(req.user.id, req.params.businessId, {
      page: parsePositiveInt(req.query.page, 1),
      limit: parsePositiveInt(req.query.limit, 30),
      category,
      dateFrom,
      dateTo,
    });
    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, "listExpenses");
  }
}

// POST /api/businesses/:businessId/expenses — record an expense.
async function createExpense(req, res) {
  const { title, category, amount, remarks } = req.body || {};

  const titleError = validateTitle(title);
  if (titleError) return res.status(400).json({ error: titleError });

  const categoryError = validateCategory(category);
  if (categoryError) return res.status(400).json({ error: categoryError });

  const amountError = validateAmount(amount);
  if (amountError) return res.status(400).json({ error: amountError });

  if (remarks !== undefined && remarks !== null && typeof remarks !== "string") {
    return res.status(400).json({ error: "remarks must be a string" });
  }

  try {
    const expense = await expenseService.createExpense(req.user.id, req.params.businessId, {
      title: title.trim(),
      category: category.trim(),
      amount,
      remarks,
    });
    return res.status(201).json({ expense });
  } catch (err) {
    return sendError(res, err, "createExpense");
  }
}

// PATCH /api/expenses/:expenseId — update editable fields.
async function updateExpense(req, res) {
  const { title, category, amount, remarks } = req.body || {};

  if (title !== undefined) {
    const titleError = validateTitle(title);
    if (titleError) return res.status(400).json({ error: titleError });
  }
  if (category !== undefined) {
    const categoryError = validateCategory(category);
    if (categoryError) return res.status(400).json({ error: categoryError });
  }
  if (amount !== undefined) {
    const amountError = validateAmount(amount);
    if (amountError) return res.status(400).json({ error: amountError });
  }
  if (remarks !== undefined && remarks !== null && typeof remarks !== "string") {
    return res.status(400).json({ error: "remarks must be a string" });
  }

  const updates = {};
  if (title !== undefined) updates.title = title.trim();
  if (category !== undefined) updates.category = category.trim();
  if (amount !== undefined) updates.amount = amount;
  if (remarks !== undefined) updates.remarks = remarks === "" ? null : remarks;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No editable fields provided" });
  }

  try {
    const expense = await expenseService.updateExpense(
      req.user.id,
      req.params.expenseId,
      updates
    );
    return res.status(200).json({ expense });
  } catch (err) {
    return sendError(res, err, "updateExpense");
  }
}

// DELETE /api/expenses/:expenseId — hard-delete an expense.
async function deleteExpense(req, res) {
  try {
    await expenseService.deleteExpense(req.user.id, req.params.expenseId);
    return res.status(204).send();
  } catch (err) {
    return sendError(res, err, "deleteExpense");
  }
}

module.exports = { listExpenses, createExpense, updateExpense, deleteExpense };
