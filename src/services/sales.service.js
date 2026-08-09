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

// ---------------------------------------------------------------------------
// Sales Reports (analytics)
// ---------------------------------------------------------------------------

const VALID_PERIODS = ["daily", "weekly", "monthly", "yearly"];

// Cap on the "Top Performing Materials" table.
const TOP_SEGMENTS_LIMIT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const REPORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Midnight UTC of the given timestamp.
function startOfUTCDay(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// Builds the contiguous timeline buckets, oldest → newest. Spans mirror the
// inventory report so the two analytics pages stay consistent. Each bucket is
// { label, start, end } with [start, end) millisecond bounds.
function buildBuckets(period, now) {
  const buckets = [];

  if (period === "daily") {
    // Last 7 days, one bucket per day.
    for (let i = 6; i >= 0; i--) {
      const start = startOfUTCDay(now - i * DAY_MS);
      buckets.push({ label: WEEKDAYS[new Date(start).getUTCDay()], start, end: start + DAY_MS });
    }
  } else if (period === "monthly") {
    // Last 12 calendar months.
    const y = new Date(now).getUTCFullYear();
    const m = new Date(now).getUTCMonth();
    for (let i = 11; i >= 0; i--) {
      const start = Date.UTC(y, m - i, 1);
      const end = Date.UTC(y, m - i + 1, 1);
      buckets.push({ label: REPORT_MONTHS[new Date(start).getUTCMonth()], start, end });
    }
  } else if (period === "yearly") {
    // Last 5 calendar years.
    const y = new Date(now).getUTCFullYear();
    for (let i = 4; i >= 0; i--) {
      buckets.push({ label: String(y - i), start: Date.UTC(y - i, 0, 1), end: Date.UTC(y - i + 1, 0, 1) });
    }
  } else {
    // weekly (default): last 8 rolling 7-day windows.
    const endOfToday = startOfUTCDay(now) + DAY_MS;
    for (let i = 7; i >= 0; i--) {
      const end = endOfToday - i * 7 * DAY_MS;
      buckets.push({ label: `W${8 - i}`, start: end - 7 * DAY_MS, end });
    }
  }

  return buckets;
}

// Signed % change, one decimal. Returns undefined when there's no prior base
// to compare against (so the caller can omit the field).
function pctChange(current, previous) {
  if (!(previous > 0)) return undefined;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// Fetches everything the report needs: non-deleted sales from the previous
// window onward (covers current + previous for trends), and the current-window
// consumption rows joined to their batch mfg_price for COGS.
async function fetchReportData(businessId, prevStart, currentStart) {
  const [salesRes, consumptionRes] = await Promise.all([
    supabase
      .from("sales")
      .select("materialId, qty_used, total_amount, created_at")
      .eq("businessId", businessId)
      .is("deletedAt", null)
      .gte("created_at", new Date(prevStart).toISOString()),
    supabase
      .from("stock_consumption_history")
      .select("quantity_deducted, sales!inner(businessId, created_at, deletedAt), stocks!inner(mfg_price)")
      .eq("sales.businessId", businessId)
      .is("sales.deletedAt", null)
      .gte("sales.created_at", new Date(currentStart).toISOString()),
  ]);

  if (salesRes.error) throw new Error(salesRes.error.message);
  if (consumptionRes.error) throw new Error(consumptionRes.error.message);

  return {
    sales: salesRes.data || [],
    consumption: consumptionRes.data || [],
  };
}

// Computes the report object from raw rows. Pure/synchronous for testability.
// Names are looked up by the caller and passed in as a materialId -> name Map.
function computeReport({ sales, consumption }, period, now, materialNames) {
  const buckets = buildBuckets(period, now);
  const currentStart = buckets[0].start;
  const currentEnd = buckets[buckets.length - 1].end;
  const span = currentEnd - currentStart;
  const prevStart = currentStart - span;

  const inBucket = (ms) => buckets.findIndex((b) => ms >= b.start && ms < b.end);

  const timeline = buckets.map((b) => ({ label: b.label, revenue: 0 }));

  let totalRevenue = 0;
  let prevRevenue = 0;
  let currentSaleCount = 0;

  // Per-material accumulators for the current and previous windows.
  const curByMaterial = new Map(); // id -> { volume, revenue }
  const prevRevByMaterial = new Map(); // id -> revenue

  for (const sale of sales) {
    const ms = new Date(sale.created_at).getTime();
    const amount = sale.total_amount || 0;
    const qty = sale.qty_used || 0;

    if (ms >= currentStart && ms < currentEnd) {
      totalRevenue += amount;
      currentSaleCount += 1;

      const idx = inBucket(ms);
      if (idx !== -1) timeline[idx].revenue += amount;

      const agg = curByMaterial.get(sale.materialId) || { volume: 0, revenue: 0 };
      agg.volume += qty;
      agg.revenue += amount;
      curByMaterial.set(sale.materialId, agg);
    } else if (ms >= prevStart && ms < currentStart) {
      prevRevenue += amount;
      prevRevByMaterial.set(
        sale.materialId,
        (prevRevByMaterial.get(sale.materialId) || 0) + amount
      );
    }
  }

  // COGS over the current window = Σ (units drawn from a batch × its mfg_price).
  let cogs = 0;
  for (const row of consumption) {
    const price = row.stocks ? row.stocks.mfg_price || 0 : 0;
    cogs += (row.quantity_deducted || 0) * price;
  }
  const estimatedProfit = totalRevenue - cogs;

  // --- KPIs (optional fields omitted rather than sent null). ---
  const kpis = { totalRevenue: Math.round(totalRevenue) };
  const revenueTrendPct = pctChange(totalRevenue, prevRevenue);
  if (revenueTrendPct !== undefined) kpis.revenueTrendPct = revenueTrendPct;
  kpis.estimatedProfit = Math.round(estimatedProfit);
  if (totalRevenue > 0) {
    kpis.profitMarginPct = Math.round((estimatedProfit / totalRevenue) * 1000) / 10;
  }

  // --- Segments: top materials by current-window revenue. ---
  const segments = [...curByMaterial.entries()]
    .map(([id, agg]) => {
      const seg = {
        id,
        name: materialNames.get(id) || null,
        volume: Math.round(agg.volume),
        revenue: Math.round(agg.revenue),
      };
      const growthPct = pctChange(agg.revenue, prevRevByMaterial.get(id) || 0);
      if (growthPct !== undefined) seg.growthPct = growthPct;
      return seg;
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, TOP_SEGMENTS_LIMIT);

  // No sales in the window → empty timeline + segments per the frontend contract.
  return {
    kpis,
    timeline: currentSaleCount > 0 ? timeline : [],
    segments,
  };
}

// Builds the sales report for a business over the given period.
async function getSalesReport(userId, businessId, period) {
  await assertMembership(userId, businessId);

  const now = Date.now();
  const buckets = buildBuckets(period, now);
  const currentStart = buckets[0].start;
  const currentEnd = buckets[buckets.length - 1].end;
  const prevStart = currentStart - (currentEnd - currentStart);

  const data = await fetchReportData(businessId, prevStart, currentStart);

  // Resolve names for every material that appears in the current window.
  const currentMaterialIds = [
    ...new Set(
      data.sales
        .filter((s) => {
          const ms = new Date(s.created_at).getTime();
          return ms >= currentStart && ms < currentEnd;
        })
        .map((s) => s.materialId)
    ),
  ];
  const materialNames = await materialService.getMaterialNamesByIds(currentMaterialIds);

  return computeReport(data, period, now, materialNames);
}

module.exports = {
  VALID_STATUSES,
  VALID_PERIODS,
  listSales,
  createSale,
  updateSale,
  deleteSale,
  getSalesReport,
  computeReport,
};
