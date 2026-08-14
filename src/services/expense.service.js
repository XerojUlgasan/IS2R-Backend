const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");
const { assertMembership, assertAction, ACTIONS } = require("./membership.service");
const { recordLog } = require("./audit.service");

// UI dropdown values (stored uppercase). Unknown/legacy values still render raw,
// so this list can grow without breaking the frontend.
const VALID_CATEGORIES = [
  "MATERIALS",
  "UTILITIES",
  "RENT",
  "SALARIES",
  "EQUIPMENT",
  "MAINTENANCE",
  "OTHER",
];

const EXPENSE_COLUMNS =
  "id, title, category, amount, remarks, created_by, businessId, created_at, stock_id, stocks(quantity, mfg_price)";

// Returns the ISO timestamp for midnight UTC of the day after the given YYYY-MM-DD.
function startOfNextDay(dateStr) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

// Builds a Map of userId -> fullname for the given actor ids (is2r.users).
async function getUserNamesByIds(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from("users")
    .select("userId, fullname")
    .in("userId", ids);

  if (error) {
    throw new Error(error.message);
  }
  return new Map((data || []).map((u) => [u.userId, u.fullname]));
}

// Resolves the effective amount for an expense. Stock-linked expenses derive
// their cost from the stock's mfg_price × quantity; manual expenses use the
// stored amount directly.
function resolveAmount(expense) {
  if (expense.stock_id && expense.stocks) {
    return expense.stocks.mfg_price;
  }
  return expense.amount;
}

// Shapes an expense row for the API, resolving the actor's display name.
function buildExpenseResponse(expense, createdByName) {
  return {
    id: expense.id,
    title: expense.title,
    category: expense.category,
    amount: resolveAmount(expense),
    remarks: expense.remarks,
    created_by_name: createdByName || null,
    created_at: expense.created_at,
    businessId: expense.businessId,
    stock_id: expense.stock_id || null,
  };
}

// Loads an expense by id; throws 404 if it doesn't exist. (Hard delete, so no
// soft-delete filter is needed.)
async function getExpenseOrThrow(expenseId) {
  const { data, error } = await supabase
    .from("expenses")
    .select(EXPENSE_COLUMNS)
    .eq("id", expenseId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw httpError(404, "Expense not found");
  }
  return data;
}

// Lists a business's expenses, newest first, paginated and optionally filtered.
async function listExpenses(userId, businessId, filters) {
  await assertMembership(userId, businessId);

  const { page, limit, category, dateFrom, dateTo } = filters;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from("expenses")
    .select(EXPENSE_COLUMNS, { count: "exact" })
    .eq("businessId", businessId);

  if (category) query = query.eq("category", category);
  if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00.000Z`);
  if (dateTo) query = query.lt("created_at", startOfNextDay(dateTo));

  query = query.order("created_at", { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const expenses = data || [];
  const total = count || 0;
  const names = await getUserNamesByIds(expenses.map((e) => e.created_by));

  return {
    expenses: expenses.map((e) => buildExpenseResponse(e, names.get(e.created_by))),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

// Creates an expense. created_by comes from the JWT, businessId from the route.
async function createExpense(userId, businessId, details) {
  await assertAction(userId, businessId, ACTIONS.ADD_EXPENSE);

  const { data, error } = await supabase
    .from("expenses")
    .insert({
      title: details.title,
      category: details.category,
      amount: details.amount,
      remarks: details.remarks || null,
      created_by: userId,
      businessId,
    })
    .select(EXPENSE_COLUMNS)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const names = await getUserNamesByIds([userId]);
  return buildExpenseResponse(data, names.get(userId));
}

// Updates an expense's editable fields. Resolves the expense's business first,
// then checks the caller has the update_expense permission there.
async function updateExpense(userId, expenseId, updates) {
  const expense = await getExpenseOrThrow(expenseId);
  await assertAction(userId, expense.businessId, ACTIONS.UPDATE_EXPENSE);

  const { data, error } = await supabase
    .from("expenses")
    .update(updates)
    .eq("id", expenseId)
    .select(EXPENSE_COLUMNS)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  const changedFields = Object.keys(updates)
    .map((k) => `${k}: "${updates[k]}"`)
    .join(", ");
  recordLog(
    expense.businessId,
    userId,
    "UPDATE_EXPENSE",
    `Updated expense "${data.title}" — changed ${changedFields}`,
    { id: expense.id, title: expense.title, category: expense.category, amount: expense.amount, remarks: expense.remarks },
    { id: data.id, title: data.title, category: data.category, amount: data.amount, remarks: data.remarks }
  );

  const names = await getUserNamesByIds([data.created_by]);
  return buildExpenseResponse(data, names.get(data.created_by));
}

// Hard-deletes an expense (no side effects to reverse).
async function deleteExpense(userId, expenseId) {
  const expense = await getExpenseOrThrow(expenseId);
  await assertAction(userId, expense.businessId, ACTIONS.DELETE_EXPENSE);

  // Deletion is only allowed within 24 hours of creation.
  const ageMs = Date.now() - new Date(expense.created_at).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    throw httpError(403, "Expense can no longer be deleted after 24 hours");
  }

  const { error } = await supabase.from("expenses").delete().eq("id", expenseId);
  if (error) {
    throw new Error(error.message);
  }

  recordLog(
    expense.businessId,
    userId,
    "DELETE_EXPENSE",
    `Removed expense "${expense.title}" (category: ${expense.category}, amount: ₱${expense.amount})`,
    { id: expense.id, title: expense.title, category: expense.category, amount: expense.amount, remarks: expense.remarks },
    null
  );
}

module.exports = {
  VALID_CATEGORIES,
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
};
