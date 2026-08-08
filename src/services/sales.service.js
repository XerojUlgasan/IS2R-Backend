const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");
const { assertMembership, assertAction, ACTIONS } = require("./membership.service");
const materialService = require("./material.service");

const VALID_STATUSES = ["PENDING", "PAID"];

const SALE_COLUMNS =
  "id, materialId, businessId, qty_used, total_amount, status, remarks, actorId, created_at";

// Shapes a sale row for the API. created_by_name is the raw actor uuid for now.
function buildSaleResponse(sale, materialName) {
  return {
    id: sale.id,
    materialId: sale.materialId,
    material_name: materialName || null,
    qty_used: sale.qty_used,
    total_amount: sale.total_amount,
    status: sale.status,
    remarks: sale.remarks,
    created_by_name: sale.actorId || null,
    created_at: sale.created_at,
  };
}

// Returns the ISO timestamp for midnight UTC of the day after the given YYYY-MM-DD.
function startOfNextDay(dateStr) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

// Loads a non-deleted sale by id; throws 404 if it doesn't exist.
async function getSaleOrThrow(saleId) {
  const { data, error } = await supabase
    .from("sales")
    .select(SALE_COLUMNS)
    .eq("id", saleId)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw httpError(404, "Sale not found");
  }
  return data;
}

// Lists a business's sales, newest first, paginated and optionally filtered.
async function listSales(userId, businessId, filters) {
  await assertMembership(userId, businessId);

  const { page, limit, status, materialId, dateFrom, dateTo } = filters;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  // Inner join on materials + filtering out soft-deleted materials excludes
  // their sales entirely, so the paginated count stays accurate.
  let query = supabase
    .from("sales")
    .select(`${SALE_COLUMNS}, materials!inner(name, deletedAt)`, { count: "exact" })
    .eq("businessId", businessId)
    .is("deletedAt", null)
    .is("materials.deletedAt", null);

  if (status) query = query.eq("status", status);
  if (materialId) query = query.eq("materialId", materialId);
  if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00.000Z`);
  if (dateTo) query = query.lt("created_at", startOfNextDay(dateTo));

  query = query.order("created_at", { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const sales = data || [];
  const total = count || 0;

  return {
    sales: sales.map((s) => buildSaleResponse(s, s.materials ? s.materials.name : null)),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

// Maps a Postgres exception raised by the RPCs to an HTTP error.
function mapRpcError(error) {
  const message = error.message || "";
  if (message.includes("INSUFFICIENT_STOCK")) {
    return httpError(400, "Insufficient stock to record this sale");
  }
  if (message.includes("MATERIAL_WRONG_BUSINESS")) {
    return httpError(400, "materialId does not belong to this business");
  }
  if (message.includes("MATERIAL_NOT_FOUND")) {
    return httpError(404, "Material not found");
  }
  if (message.includes("SALE_NOT_FOUND")) {
    return httpError(404, "Sale not found");
  }
  return new Error(message);
}

// Records a sale atomically via the create_sale RPC (locks stock, consumes FIFO, inserts).
async function createSale(userId, businessId, details) {
  await assertAction(userId, businessId, ACTIONS.CREATE_SALES);

  const { data, error } = await supabase.rpc("create_sale", {
    p_business_id: businessId,
    p_material_id: details.materialId,
    p_qty_used: details.qty_used,
    p_total_amount: details.total_amount,
    p_status: details.status,
    p_remarks: details.remarks || null,
    p_actor_id: userId,
  });

  if (error) {
    throw mapRpcError(error);
  }

  const names = await materialService.getMaterialNamesByIds([data.materialId]);
  return buildSaleResponse(data, names.get(data.materialId));
}

// Updates a sale's editable fields (status/remarks). Never touches stock.
async function updateSale(userId, saleId, updates) {
  const sale = await getSaleOrThrow(saleId);
  await assertAction(userId, sale.businessId, ACTIONS.UPDATE_SALES);

  const { error } = await supabase.from("sales").update(updates).eq("id", saleId);
  if (error) {
    throw new Error(error.message);
  }

  const names = await materialService.getMaterialNamesByIds([sale.materialId]);
  return buildSaleResponse({ ...sale, ...updates }, names.get(sale.materialId));
}

// Soft-deletes a sale and restores its stock atomically via the delete_sale RPC.
async function deleteSale(userId, saleId) {
  const sale = await getSaleOrThrow(saleId);
  await assertAction(userId, sale.businessId, ACTIONS.DELETE_SALES);

  const { error } = await supabase.rpc("delete_sale", { p_sale_id: saleId });
  if (error) {
    throw mapRpcError(error);
  }
}

module.exports = {
  VALID_STATUSES,
  listSales,
  createSale,
  updateSale,
  deleteSale,
};
