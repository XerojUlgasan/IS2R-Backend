const { supabase } = require("../lib/supabaseClient");
const { assertMembership } = require("./membership.service");

const VALID_STATUSES = ["AVAILABLE", "CONSUMED"];

// Frontend sends uppercase; the stocks.status column stores lowercase.
const STATUS_TO_COLUMN = { AVAILABLE: "available", CONSUMED: "consumed" };

const STOCK_COLUMNS =
  "id, materialId, quantity, quantity_sold, mfg_price, status, created_at";

// Shapes a stock row for the API, deriving status from remaining quantity.
function buildStockResponse(stock) {
  const remaining = stock.quantity - (stock.quantity_sold || 0);
  return {
    id: stock.id,
    materialId: stock.materialId,
    material_name: stock.materials ? stock.materials.name : null,
    quantity: stock.quantity,
    quantity_sold: stock.quantity_sold,
    mfg_price: stock.mfg_price,
    status: remaining > 0 ? "AVAILABLE" : "CONSUMED",
    created_at: stock.created_at,
  };
}

// Returns the ISO timestamp for midnight UTC of the day after the given YYYY-MM-DD.
function startOfNextDay(dateStr) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

// Lists a business's stock batches, newest first, paginated and optionally filtered.
async function listStocks(userId, businessId, filters) {
  await assertMembership(userId, businessId);

  const { page, limit, status, materialId, dateFrom, dateTo } = filters;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  // Inner join + filtering out soft-deleted materials excludes their stock
  // batches entirely, keeping the paginated count accurate.
  let query = supabase
    .from("stocks")
    .select(`${STOCK_COLUMNS}, materials!inner(name, deletedAt)`, { count: "exact" })
    .eq("businessId", businessId)
    .is("deletedAt", null)
    .is("materials.deletedAt", null);

  if (status) query = query.eq("status", STATUS_TO_COLUMN[status]);
  if (materialId) query = query.eq("materialId", materialId);
  if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00.000Z`);
  if (dateTo) query = query.lt("created_at", startOfNextDay(dateTo));

  query = query.order("created_at", { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const stocks = data || [];
  const total = count || 0;

  return {
    stocks: stocks.map(buildStockResponse),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = { VALID_STATUSES, listStocks };
