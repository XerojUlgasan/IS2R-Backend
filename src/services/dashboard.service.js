const { supabase } = require("../lib/supabaseClient");
const { assertMembership } = require("./membership.service");
const materialService = require("./material.service");

// The today/period figures are computed in the business's local clock:
// Asia/Manila, UTC+8, no DST. "Local midnight" therefore maps to a UTC instant
// 8h earlier.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same reorder tiering as the inventory report so the two pages agree.
const REORDER_LEVEL = 100;
const STATUS_RANK = { OUT: 0, CRITICAL: 1, LOW: 2 };

// Preview caps.
const LOW_STOCK_LIMIT = 5;
const ACTIVITY_LIMIT = 3;
const RECENT_SALES_LIMIT = 10;

// UTC instant of the most recent Manila midnight at or before nowMs.
function startOfManilaDay(nowMs) {
  return (
    Math.floor((nowMs + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS
  );
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
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) -
    MANILA_OFFSET_MS
  );
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

// Revenue uses paid_at when present; legacy rows fall back to created_at.
function getPaidTimestamp(sale) {
  return sale.paid_at || sale.created_at;
}

// Revenue KPIs (today + both periods) plus today's trend vs the same window
// yesterday. Fetches one bounded slice of sales and buckets it in memory.
async function computeRevenue(businessId, now, weekStart, monthStart) {
  const startToday = startOfManilaDay(now);
  const startYesterday = startToday - DAY_MS;
  const fetchFrom = Math.min(startYesterday, weekStart, monthStart);

  const { data, error } = await supabase
    .from("sales")
    .select("total_amount, paid_at, created_at")
    .eq("businessId", businessId)
    .eq("status", "PAID")
    .is("deletedAt", null)
    .or(
      `paid_at.gte.${new Date(fetchFrom).toISOString()},created_at.gte.${new Date(fetchFrom).toISOString()}`,
    );

  if (error) {
    throw new Error(error.message);
  }

  let today = 0;
  let yesterday = 0;
  let weekly = 0;
  let monthly = 0;

  for (const sale of data || []) {
    const ms = new Date(getPaidTimestamp(sale)).getTime();
    const amount = sale.total_amount || 0;

    if (ms >= startToday && ms <= now) today += amount;
    // Same slice of yesterday: [yesterday midnight, now - 24h).
    if (ms >= startYesterday && ms < now - DAY_MS) yesterday += amount;
    if (ms >= weekStart && ms <= now) weekly += amount;
    if (ms >= monthStart && ms <= now) monthly += amount;
  }

  return {
    today: round2(today),
    yesterday,
    weekly: round2(weekly),
    monthly: round2(monthly),
  };
}

// Expense totals for both period windows (same windows as period revenue).
async function computePeriodExpenses(businessId, now, weekStart, monthStart) {
  const startToday = startOfManilaDay(now);
  const fetchFrom = Math.min(startToday, weekStart, monthStart);

  const { data, error } = await supabase
    .from("expenses")
    .select("amount, created_at, stock_id, stocks(quantity, mfg_price)")
    .eq("businessId", businessId)
    .gte("created_at", new Date(fetchFrom).toISOString());

  if (error) {
    throw new Error(error.message);
  }

  let today = 0;
  let weekly = 0;
  let monthly = 0;
  for (const e of data || []) {
    const ms = new Date(e.created_at).getTime();
    const amount = e.stock_id && e.stocks ? e.stocks.mfg_price : e.amount || 0;
    if (ms >= startToday && ms <= now) today += amount;
    if (ms >= weekStart && ms <= now) weekly += amount;
    if (ms >= monthStart && ms <= now) monthly += amount;
  }

  return {
    today: round2(today),
    weekly: round2(weekly),
    monthly: round2(monthly),
  };
}

// Inventory valuation, fully-consumed count, and the low-stock preview.
async function computeInventory(businessId, now) {
  const [materialsRes, stocksRes] = await Promise.all([
    supabase
      .from("materials")
      .select("id, name, deletedAt")
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
      (remainingByMaterial.get(stock.materialId) || 0) + remaining,
    );
    // mfg_price is the price for the batch's full quantity, so prorate it to
    // the remaining units rather than treating it as a per-unit price.
    if (remaining > 0 && stock.quantity > 0) {
      inventoryValue += stock.mfg_price * (remaining / stock.quantity);
    }
  }

  let fullyConsumedCount = 0;
  const lowStock = [];
  for (const material of materials) {
    const remaining = remainingByMaterial.get(material.id) || 0;
    if (remaining === 0) fullyConsumedCount += 1;

    const status = lowStockStatus(remaining);
    if (status) {
      lowStock.push({
        id: material.id,
        name: material.name,
        remaining,
        _status: status,
      });
    }
  }

  lowStock.sort(
    (a, b) =>
      STATUS_RANK[a._status] - STATUS_RANK[b._status] ||
      a.remaining - b.remaining,
  );

  return {
    inventoryValue: Math.round(inventoryValue),
    fullyConsumedCount,
    lowStock: lowStock
      .slice(0, LOW_STOCK_LIMIT)
      .map(({ _status, ...row }) => row),
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
    .select(
      "id, materialId, qty_used, total_amount, status, remarks, actorId, created_at",
    )
    .eq("businessId", businessId)
    .eq("status", "PAID")
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

// Fetches the caller's role and cut_by_percentage from business_members.
async function getMemberCut(userId, businessId) {
  const { data, error } = await supabase
    .from("business_members")
    .select("role, cut_by_percentage")
    .eq("userId", userId)
    .eq("businessId", businessId)
    .eq("status", "accepted")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

// Computes myCut for each period. Returns null for Staff or when cut is unset/zero.
function computeMyCut(member, revenue, expenses) {
  if (!member) return null;
  const role = (member.role || "").toLowerCase();
  if (role === "staff") return null;
  const cut = member.cut_by_percentage;
  if (!cut) return null;

  const factor = cut / 100;
  return {
    cutPercentage: cut,
    today: {
      raw: round2(revenue.today * factor),
      afterExpenses: round2((revenue.today - expenses.today) * factor),
    },
    weekly: {
      raw: round2(revenue.weekly * factor),
      afterExpenses: round2((revenue.weekly - expenses.weekly) * factor),
    },
    monthly: {
      raw: round2(revenue.monthly * factor),
      afterExpenses: round2((revenue.monthly - expenses.monthly) * factor),
    },
  };
}

// Builds the full dashboard summary for a business. Both the weekly and
// monthly period figures are always returned so the client can toggle between
// them without another request.
async function getDashboard(userId, businessId) {
  await assertMembership(userId, businessId);

  const now = Date.now();
  const weekStart = startOfManilaWeek(now);
  const monthStart = startOfManilaMonth(now);

  const [revenue, expenses, inventory, recentSales, member] = await Promise.all(
    [
      computeRevenue(businessId, now, weekStart, monthStart),
      computePeriodExpenses(businessId, now, weekStart, monthStart),
      computeInventory(businessId, now),
      computeRecentSales(businessId),
      getMemberCut(userId, businessId),
    ],
  );

  const owner =
    Boolean(member) && (member.role || "").toLowerCase() === "owner";
  const activityRows = await computeActivity(businessId, owner);

  const summary = {
    todaysRevenue: revenue.today,
    periods: {
      weekly: {
        revenue: revenue.weekly,
        expenses: expenses.weekly,
        net: round2(revenue.weekly - expenses.weekly),
      },
      monthly: {
        revenue: revenue.monthly,
        expenses: expenses.monthly,
        net: round2(revenue.monthly - expenses.monthly),
      },
    },
    inventoryValue: inventory.inventoryValue,
    fullyConsumedCount: inventory.fullyConsumedCount,
    lowStock: inventory.lowStock,
    activity: activityRows,
    recentSales,
    myCut: computeMyCut(member, revenue, expenses),
  };

  const trend = pctChange(revenue.today, revenue.yesterday);
  if (trend !== undefined) summary.todaysRevenueTrendPct = trend;

  return summary;
}

module.exports = { getDashboard };
