const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");
const { assertMembership } = require("./membership.service");
const materialService = require("./material.service");

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

// Loads a stock batch by id (soft-deleted batches still count so their history
// stays viewable). Throws 404 if it doesn't exist or belongs to another business.
async function getStockForBusinessOrThrow(stockId, businessId) {
  const { data, error } = await supabase
    .from("stocks")
    .select("id, businessId, materialId")
    .eq("id", stockId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data || data.businessId !== businessId) {
    throw httpError(404, "Stock not found");
  }
  return data;
}

// Builds a Map of userId -> fullname for the given actor ids.
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

// Shapes a consumption-history row for the API. status is an array: the sale's
// actual status, plus "DELETED" when the underlying sale was soft-deleted.
function buildHistoryResponse(row, materialName, userNames) {
  const sale = row.sales || {};
  const status = [];
  if (sale.status) status.push(sale.status);
  if (sale.deletedAt) status.push("DELETED");

  return {
    id: row.id,
    material_name: materialName || null,
    created_by_name: sale.actorId ? userNames.get(sale.actorId) || null : null,
    deducted: row.quantity_deducted,
    remaining: row.remaining_stock,
    status,
    created_at: row.created_at,
  };
}

// Lists a single stock batch's consumption events, newest first, paginated.
// Includes deleted-sale events (flagged "DELETED"). Tie-breaks on id so the
// frontend's infinite scroll never duplicates or skips rows across pages.
async function getStockHistory(userId, businessId, stockId, filters) {
  await assertMembership(userId, businessId);
  const stock = await getStockForBusinessOrThrow(stockId, businessId);

  const { page, limit } = filters;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from("stock_consumption_history")
    .select(
      "id, quantity_deducted, remaining_stock, created_at, sales!inner(status, deletedAt, actorId)",
      { count: "exact" }
    )
    .eq("stockId", stockId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (error) {
    throw new Error(error.message);
  }

  const rows = data || [];
  const total = count || 0;

  const materialNames = await materialService.getMaterialNamesByIds([stock.materialId]);
  const materialName = materialNames.get(stock.materialId);
  const userNames = await getUserNamesByIds(rows.map((r) => (r.sales ? r.sales.actorId : null)));

  return {
    history: rows.map((r) => buildHistoryResponse(r, materialName, userNames)),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = { VALID_STATUSES, listStocks, getStockHistory };
