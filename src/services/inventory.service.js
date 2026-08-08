const { supabase } = require("../lib/supabaseClient");
const { assertMembership } = require("./membership.service");

const VALID_PERIODS = ["daily", "weekly", "monthly", "yearly"];

// No reorder level is stored in the schema, so we use a documented server-side
// default (units). remaining <= 0 → OUT; <= half → CRITICAL; <= level → LOW.
const REORDER_LEVEL = 100;

// A batch is only considered "aging" once it's been on the shelf this long.
const AGING_MIN_DAYS = 30;

// Table caps so the UI stays readable.
const TOP_CONSUMED_LIMIT = 10;
const AGING_LIMIT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Midnight UTC of the given date.
function startOfUTCDay(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// Formats a timestamp as YYYY-MM-DD (UTC).
function toYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Builds the contiguous time buckets for the movement chart, oldest → newest.
// Each bucket is { label, start, end } with [start, end) millisecond bounds.
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
      buckets.push({ label: MONTHS[new Date(start).getUTCMonth()], start, end });
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

// The rolling window used for "this period" figures (added, top consumed).
function periodWindowStart(period, now) {
  switch (period) {
    case "daily":
      return now - DAY_MS;
    case "monthly":
      return now - 30 * DAY_MS;
    case "yearly":
      return now - 365 * DAY_MS;
    case "weekly":
    default:
      return now - 7 * DAY_MS;
  }
}

// Remaining units on a stock batch (never negative).
function remainingOf(stock) {
  return Math.max(0, stock.quantity - (stock.quantity_sold || 0));
}

// Classifies a material's remaining units against the reorder level.
// Returns null when the material is adequately stocked.
function lowStockStatus(remaining) {
  if (remaining <= 0) return "OUT";
  if (remaining <= REORDER_LEVEL * 0.5) return "CRITICAL";
  if (remaining <= REORDER_LEVEL) return "LOW";
  return null;
}

// Urgency ordering for the low-stock watchlist.
const STATUS_RANK = { OUT: 0, CRITICAL: 1, LOW: 2 };

// Fetches all rows needed for the report in three scoped queries.
async function fetchReportData(businessId) {
  const [materialsRes, stocksRes, salesRes] = await Promise.all([
    supabase
      .from("materials")
      .select("id, name, type, unit, created_at, deletedAt")
      .eq("businessId", businessId),
    supabase
      .from("stocks")
      .select("id, materialId, quantity, quantity_sold, mfg_price, created_at")
      .eq("businessId", businessId)
      .is("deletedAt", null),
    supabase
      .from("sales")
      .select("materialId, qty_used, created_at")
      .eq("businessId", businessId)
      .is("deletedAt", null),
  ]);

  if (materialsRes.error) throw new Error(materialsRes.error.message);
  if (stocksRes.error) throw new Error(stocksRes.error.message);
  if (salesRes.error) throw new Error(salesRes.error.message);

  return {
    materials: materialsRes.data || [],
    stocks: stocksRes.data || [],
    sales: salesRes.data || [],
  };
}

// Computes the full report object from the raw rows.
function computeReport({ materials, stocks, sales }, period, now) {
  const buckets = buildBuckets(period, now);
  const windowStart = periodWindowStart(period, now);

  // Index materials (active only) and prepare per-material accumulators.
  const activeMaterials = materials.filter((m) => m.deletedAt === null);
  const materialById = new Map(materials.map((m) => [m.id, m]));

  const remainingByMaterial = new Map(); // materialId -> remaining units on hand
  const lastStockedByMaterial = new Map(); // materialId -> latest stock created_at (ms)

  // --- Stocks pass: inventory value, units on hand, status split, aging. ---
  let inventoryValue = 0;
  let unitsOnHand = 0;
  let availableBatches = 0;
  let totalBatches = 0;
  const agingRows = [];

  for (const stock of stocks) {
    const remaining = remainingOf(stock);
    const createdMs = new Date(stock.created_at).getTime();

    remainingByMaterial.set(
      stock.materialId,
      (remainingByMaterial.get(stock.materialId) || 0) + remaining
    );
    const prevLast = lastStockedByMaterial.get(stock.materialId) || 0;
    if (createdMs > prevLast) lastStockedByMaterial.set(stock.materialId, createdMs);

    unitsOnHand += remaining;
    totalBatches += 1;

    if (remaining > 0) {
      availableBatches += 1;
      inventoryValue += remaining * stock.mfg_price;

      const ageDays = Math.floor((now - createdMs) / DAY_MS);
      if (ageDays >= AGING_MIN_DAYS) {
        const material = materialById.get(stock.materialId);
        agingRows.push({
          batch: `STK-${String(stock.id).slice(0, 4).toUpperCase()}`,
          name: material ? material.name : null,
          ageDays,
          remaining,
          tiedUp: Math.round(remaining * stock.mfg_price),
          _createdMs: createdMs,
        });
      }
    }
  }

  // --- Movement buckets: stocked in (stocks) vs consumed (sales). ---
  const movement = buckets.map((b) => ({ label: b.label, stockedIn: 0, consumed: 0 }));
  const inBucket = (ms) => buckets.findIndex((b) => ms >= b.start && ms < b.end);

  for (const stock of stocks) {
    const idx = inBucket(new Date(stock.created_at).getTime());
    if (idx !== -1) movement[idx].stockedIn += stock.quantity;
  }

  // --- Sales pass: movement consumption + per-material consumption this period. ---
  const consumedByMaterial = new Map(); // materialId -> qty_used within the window
  for (const sale of sales) {
    const ms = new Date(sale.created_at).getTime();
    const idx = inBucket(ms);
    if (idx !== -1) movement[idx].consumed += sale.qty_used || 0;
    if (ms >= windowStart) {
      consumedByMaterial.set(
        sale.materialId,
        (consumedByMaterial.get(sale.materialId) || 0) + (sale.qty_used || 0)
      );
    }
  }

  // --- Low stock watchlist + counts (over active materials). ---
  const lowStock = [];
  let lowStockCount = 0;
  let criticalCount = 0;
  let outCount = 0;

  for (const material of activeMaterials) {
    const remaining = remainingByMaterial.get(material.id) || 0;
    const status = lowStockStatus(remaining);
    if (!status) continue;

    lowStockCount += 1;
    if (status === "CRITICAL") criticalCount += 1;
    if (status === "OUT") outCount += 1;

    const lastStocked = lastStockedByMaterial.get(material.id);
    lowStock.push({
      id: material.id,
      name: material.name,
      remaining,
      unit: material.unit,
      lastStocked: lastStocked ? toYmd(lastStocked) : null,
      status,
    });
  }
  lowStock.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.remaining - b.remaining);

  // --- Type distribution (remaining units by material type). ---
  const unitsByType = new Map();
  for (const material of activeMaterials) {
    const remaining = remainingByMaterial.get(material.id) || 0;
    const type = material.type || "OTHER";
    unitsByType.set(type, (unitsByType.get(type) || 0) + remaining);
  }
  const typeDistribution = [...unitsByType.entries()]
    .map(([type, units]) => ({
      type,
      units,
      pct: unitsOnHand > 0 ? Math.round((units / unitsOnHand) * 100) : 0,
    }))
    .sort((a, b) => b.units - a.units);

  // --- Top consumed this period. ---
  const topConsumed = [...consumedByMaterial.entries()]
    .filter(([, consumed]) => consumed > 0)
    .map(([materialId, consumed]) => {
      const material = materialById.get(materialId);
      const remaining = remainingByMaterial.get(materialId) || 0;
      const denom = consumed + remaining;
      return {
        id: materialId,
        name: material ? material.name : null,
        consumed,
        remaining,
        sellThrough: denom > 0 ? Math.round((consumed / denom) * 100) : 0,
      };
    })
    .sort((a, b) => b.consumed - a.consumed)
    .slice(0, TOP_CONSUMED_LIMIT);

  // --- Aging stock (oldest available batches first). ---
  agingRows.sort((a, b) => b.ageDays - a.ageDays);
  const aging = agingRows.slice(0, AGING_LIMIT).map(({ _createdMs, ...row }) => row);

  const materialsAddedThisPeriod = activeMaterials.filter(
    (m) => new Date(m.created_at).getTime() >= windowStart
  ).length;

  return {
    kpis: {
      inventoryValue: Math.round(inventoryValue),
      unitsOnHand,
      activeMaterials: activeMaterials.length,
      materialsAddedThisPeriod,
      lowStockCount,
      criticalCount,
      outCount,
    },
    movement,
    statusSplit: {
      availablePct: totalBatches > 0 ? Math.round((availableBatches / totalBatches) * 100) : 0,
    },
    typeDistribution,
    lowStock,
    topConsumed,
    aging,
  };
}

// Builds the inventory report for a business over the given period.
async function getInventoryReport(userId, businessId, period) {
  await assertMembership(userId, businessId);

  const data = await fetchReportData(businessId);
  return computeReport(data, period, Date.now());
}

module.exports = { VALID_PERIODS, REORDER_LEVEL, AGING_MIN_DAYS, getInventoryReport, computeReport };
