const { supabase } = require("../lib/supabaseClient");
const { assertMembership } = require("./membership.service");
const materialService = require("./material.service");

// The today/period figures are computed in the business's local clock:
// Asia/Manila, UTC+8, no DST. "Local midnight" therefore maps to a UTC instant
// 8h earlier.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The period-revenue card toggle.
const VALID_PERIODS = ["weekly", "monthly"];

// Same reorder tiering as the inventory report so the two pages agree.
const REORDER_LEVEL = 100;
const STATUS_RANK = { OUT: 0, CRITICAL: 1, LOW: 2 };

// Preview caps.
const LOW_STOCK_LIMIT = 5;
const ACTIVITY_LIMIT = 3;
const RECENT_SALES_LIMIT = 10;

// UTC instant of the most recent Manila midnight at or before nowMs.
function startOfManilaDay(nowMs) {
  return Math.floor((nowMs + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
}

// UTC instant of Monday 00:00 (Manila) of the current week.
function startOfManilaWeek(nowMs) {
  const startToday = startOfManilaDay(nowMs);
  const manilaDow = new Date(startToday + MANILA_OFFSET_MS).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (manilaDow + 6) % 7;
  return startToday - daysSinceMonday * DAY_MS;
}

// UTC instant of the first day of the current Manila month at 00:00 local.
function startOfManilaMonth(nowMs) {
  const shifted = new Date(nowMs + MANILA_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - MANILA_OFFSET_MS;
}

// Start (UTC instant) of the selected period window.
function periodStartOf(period, nowMs) {
  return period === "weekly" ? startOfManilaWeek(nowMs) : startOfManilaMonth(nowMs);
}

// Signed whole-percent change; undefined when there's no prior base to compare.
function pctChange(current, previous) {
  if (!(previous > 0)) return undefined;
  return Math.round(((current - previous) / previous) * 100);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Remaining units on a batch, never negative.
function remainingOf(stock) {
  return Math.max(0, stock.quantity - (stock.quantity_sold || 0));
}

// Classifies remaining units; null when adequately stocked.
function lowStockStatus(remaining) {
  if (remaining <= 0) return "OUT";
  if (remaining <= REORDER_LEVEL * 0.5) return "CRITICAL";
  if (remaining <= REORDER_LEVEL) return "LOW";
  return null;
}

// Builds a Map of userId -> fullname (is2r.users).
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

// Revenue KPIs (today + selected period) plus today's trend vs the same window
// yesterday. Fetches one bounded slice of sales and buckets it in memory.
async function computeRevenue(businessId, now, periodStart) {
  const startToday = startOfManilaDay(now);
  const startYesterday = startToday - DAY_MS;
  const fetchFrom = Math.min(startYesterday, periodStart);

  const { data, error } = await supabase
    .from("sales")
    .select("total_amount, created_at")
    .eq("businessId", businessId)
    .is("deletedAt", null)
    .gte("created_at", new Date(fetchFrom).toISOString());

  if (error) {
    throw new Error(error.message);
  }

  let today = 0;
  let yesterday = 0;
  let period = 0;

  for (const sale of data || []) {
    const ms = new Date(sale.created_at).getTime();
    const amount = sale.total_amount || 0;

    if (ms >= startToday && ms <= now) today += amount;
    // Same slice of yesterday: [yesterday midnight, now - 24h).
    if (ms >= startYesterday && ms < now - DAY_MS) yesterday += amount;
    if (ms >= periodStart && ms <= now) period += amount;
  }

  return { today: round2(today), yesterday, period: round2(period) };
}

// Sum of the selected period's expenses (same window as period revenue).
async function computePeriodExpenses(businessId, periodStart) {
  const { data, error } = await supabase
    .from("expenses")
    .select("amount, created_at")
    .eq("businessId", businessId)
    .gte("created_at", new Date(periodStart).toISOString());

  if (error) {
    throw new Error(error.message);
  }

  let total = 0;
  for (const e of data || []) total += e.amount || 0;
  return round2(total);
}

// Inventory valuation, fully-consumed count, and the low-stock preview.
async function computeInventory(businessId, now) {
  const [materialsRes, stocksRes] = await Promise.all([
    supabase
      .from("materials")
      .select("id, name, unit, deletedAt")
      .eq("businessId", businessId)
      .is("deletedAt", null),
    supabase
      .from("stocks")
      .select("materialId, quantity, quantity_sold, mfg_price")
      .eq("businessId", businessId)
      .is("deletedAt", null),
  ]);

  if (materialsRes.error) throw new Error(materialsRes.error.message);
  if (stocksRes.error) throw new Error(stocksRes.error.message);

  const materials = materialsRes.data || [];
  const stocks = stocksRes.data || [];

  let inventoryValue = 0;
  const remainingByMaterial = new Map();
  for (const stock of stocks) {
    const remaining = remainingOf(stock);
    remainingByMaterial.set(
      stock.materialId,
      (remainingByMaterial.get(stock.materialId) || 0) + remaining
    );
    if (remaining > 0) inventoryValue += remaining * stock.mfg_price;
  }

  let fullyConsumedCount = 0;
  const lowStock = [];
  for (const material of materials) {
    const remaining = remainingByMaterial.get(material.id) || 0;
    if (remaining === 0) fullyConsumedCount += 1;

    const status = lowStockStatus(remaining);
    if (status) {
      lowStock.push({ id: material.id, name: material.name, unit: material.unit, remaining, _status: status });
    }
  }

  lowStock.sort(
    (a, b) => STATUS_RANK[a._status] - STATUS_RANK[b._status] || a.remaining - b.remaining
  );

  return {
    inventoryValue: Math.round(inventoryValue),
    fullyConsumedCount,
    lowStock: lowStock.slice(0, LOW_STOCK_LIMIT).map(({ _status, ...row }) => row),
  };
}

// Recent audit-log events — owner only (audit logs are otherwise owner-scoped).
async function computeActivity(businessId, isOwner) {
  if (!isOwner) return [];

  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, action, description, created_at")
    .eq("businessId", businessId)
    .order("created_at", { ascending: false })
    .limit(ACTIVITY_LIMIT);

  if (error) {
    throw new Error(error.message);
  }
  return (data || []).map((l) => ({
    id: l.id,
    action: l.action,
    description: l.description,
    created_at: l.created_at,
  }));
}

// Latest sales rows (same shape as Sales History), newest first, capped.
async function computeRecentSales(businessId) {
  const { data, error } = await supabase
    .from("sales")
    .select("id, materialId, qty_used, total_amount, status, remarks, actorId, created_at")
    .eq("businessId", businessId)
    .is("deletedAt", null)
    .order("created_at", { ascending: false })
    .limit(RECENT_SALES_LIMIT);

  if (error) {
    throw new Error(error.message);
  }

  const rows = data || [];
  const [materialNames, userNames] = await Promise.all([
    materialService.getMaterialNamesByIds(rows.map((r) => r.materialId)),
    getUserNamesByIds(rows.map((r) => r.actorId)),
  ]);

  return rows.map((r) => ({
    id: r.id,
    material_name: materialNames.get(r.materialId) || null,
    qty_used: r.qty_used,
    total_amount: r.total_amount,
    status: r.status,
    remarks: r.remarks,
    created_by_name: r.actorId ? userNames.get(r.actorId) || null : null,
    created_at: r.created_at,
  }));
}

// Resolves whether the caller owns the business (gates the activity preview).
async function isBusinessOwner(userId, businessId) {
  const { data, error } = await supabase
    .from("business")
    .select("ownerId")
    .eq("id", businessId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return Boolean(data) && data.ownerId === userId;
}

// Builds the full dashboard summary for a business over the selected period.
async function getDashboard(userId, businessId, period) {
  await assertMembership(userId, businessId);

  const now = Date.now();
  const periodStart = periodStartOf(period, now);
  const owner = await isBusinessOwner(userId, businessId);

  const [revenue, periodExpenses, inventory, activity, recentSales] = await Promise.all([
    computeRevenue(businessId, now, periodStart),
    computePeriodExpenses(businessId, periodStart),
    computeInventory(businessId, now),
    computeActivity(businessId, owner),
    computeRecentSales(businessId),
  ]);

  const summary = {
    todaysRevenue: revenue.today,
    periodRevenue: revenue.period,
    periodExpenses,
    periodNet: round2(revenue.period - periodExpenses),
    inventoryValue: inventory.inventoryValue,
    fullyConsumedCount: inventory.fullyConsumedCount,
    lowStock: inventory.lowStock,
    activity,
    recentSales,
  };

  const trend = pctChange(revenue.today, revenue.yesterday);
  if (trend !== undefined) summary.todaysRevenueTrendPct = trend;

  return summary;
}

module.exports = { VALID_PERIODS, getDashboard };
