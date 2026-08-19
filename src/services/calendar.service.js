const { supabase } = require("../lib/supabaseClient");
const { assertMembership } = require("./membership.service");

// Asia/Manila UTC+8 — used for period boundaries.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// --- Helpers ---

// Returns { start, end } as ISO strings representing the Manila-local day.
function dayBounds(dateStr) {
  // dateStr = "2026-08-11"
  const [y, m, d] = dateStr.split("-").map(Number);
  const startUtc = Date.UTC(y, m - 1, d) - MANILA_OFFSET_MS;
  return {
    start: new Date(startUtc).toISOString(),
    end: new Date(startUtc + DAY_MS).toISOString(),
  };
}

// Returns { start, end } for a full Manila-local month.
function monthBounds(year, month) {
  // month is 1-based
  const startUtc = Date.UTC(year, month - 1, 1) - MANILA_OFFSET_MS;
  const endUtc = Date.UTC(year, month, 1) - MANILA_OFFSET_MS;
  return {
    start: new Date(startUtc).toISOString(),
    end: new Date(endUtc).toISOString(),
  };
}

// Rounds to one decimal place.
function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

// Revenue uses paid_at when present; legacy rows fall back to created_at.
function getPaidTimestamp(sale) {
  return sale.paid_at || sale.created_at;
}

// Compute percentage change; null only when both periods have zero sales
// (nothing meaningful to show). When previous is 0 but current > 0, that's
// a +100% gain. When current is 0 but previous > 0, that's -100%.
function changePct(current, previous) {
  if ((!current || current === 0) && (!previous || previous === 0)) return null;
  if (!previous || previous === 0) return 100;
  if (!current || current === 0) return -100;
  return round1(((current - previous) / previous) * 100);
}

// Days in a given month (1-based month).
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// =====================================================================
// 1. Calendar Overview
// =====================================================================

async function getCalendarOverview(userId, businessId, view, dateStr) {
  await assertMembership(userId, businessId);

  if (view === "month") {
    return getMonthOverview(businessId, dateStr);
  }
  return getYearOverview(businessId, dateStr);
}

// Month view: one entry per day with changePct vs previous day.
async function getMonthOverview(businessId, dateStr) {
  const [year, month] = dateStr.split("-").map(Number);
  const numDays = daysInMonth(year, month);

  // We also need the last day of the previous month to compute changePct for day 1.
  const prevMonthDate = new Date(year, month - 2, 1); // month-2 because Date months are 0-based
  const prevYear = prevMonthDate.getFullYear();
  const prevMonth = prevMonthDate.getMonth() + 1; // back to 1-based
  const lastDayPrevMonth = daysInMonth(prevYear, prevMonth);

  // Fetch from last day of prev month through end of current month.
  const prevDayStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(lastDayPrevMonth).padStart(2, "0")}`;
  const fetchStart = dayBounds(prevDayStr).start;
  const { end: fetchEnd } = monthBounds(year, month);

  const { data, error } = await supabase
    .from("sales")
    .select("total_amount, paid_at, created_at")
    .eq("businessId", businessId)
    .eq("status", "PAID")
    .is("deletedAt", null)
    .or(`paid_at.gte.${fetchStart},created_at.gte.${fetchStart}`);

  if (error) throw new Error(error.message);

  // Bucket totals by Manila-local day key "YYYY-MM-DD".
  const dailyTotals = new Map();
  for (const sale of data || []) {
    const ms = new Date(getPaidTimestamp(sale)).getTime();
    if (
      ms < new Date(fetchStart).getTime() ||
      ms >= new Date(fetchEnd).getTime()
    )
      continue;
    // Shift to Manila local then extract the date.
    const local = new Date(ms + MANILA_OFFSET_MS);
    const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
    dailyTotals.set(
      key,
      (dailyTotals.get(key) || 0) + (sale.total_amount || 0),
    );
  }

  // Build entries for each day of the requested month.
  const entries = [];
  // Previous day total (last day of prev month) is the baseline for day 1.
  let prevTotal = dailyTotals.get(prevDayStr) || 0;

  for (let d = 1; d <= numDays; d++) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const totalSales = dailyTotals.get(key) || 0;
    entries.push({
      key: d,
      changePct: changePct(totalSales, prevTotal),
      totalSales: Math.round(totalSales * 100) / 100,
    });
    prevTotal = totalSales;
  }

  return { entries };
}

// Year view: one entry per month with changePct vs previous month.
async function getYearOverview(businessId, dateStr) {
  const year = Number(dateStr.split("-")[0]);

  // Need December of previous year for changePct of January.
  const fetchStart = monthBounds(year - 1, 12).start;
  const fetchEnd = monthBounds(year, 12).end;

  const { data, error } = await supabase
    .from("sales")
    .select("total_amount, paid_at, created_at")
    .eq("businessId", businessId)
    .eq("status", "PAID")
    .is("deletedAt", null)
    .or(`paid_at.gte.${fetchStart},created_at.gte.${fetchStart}`);

  if (error) throw new Error(error.message);

  // Bucket by Manila-local "YYYY-MM".
  const monthlyTotals = new Map();
  for (const sale of data || []) {
    const ms = new Date(getPaidTimestamp(sale)).getTime();
    if (
      ms < new Date(fetchStart).getTime() ||
      ms >= new Date(fetchEnd).getTime()
    )
      continue;
    const local = new Date(ms + MANILA_OFFSET_MS);
    const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
    monthlyTotals.set(
      key,
      (monthlyTotals.get(key) || 0) + (sale.total_amount || 0),
    );
  }

  const entries = [];
  let prevTotal = monthlyTotals.get(`${year - 1}-12`) || 0;

  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    const totalSales = monthlyTotals.get(key) || 0;
    entries.push({
      key: m,
      changePct: changePct(totalSales, prevTotal),
      totalSales: Math.round(totalSales * 100) / 100,
    });
    prevTotal = totalSales;
  }

  return { entries };
}

// =====================================================================
// 2. Calendar Detail
// =====================================================================

async function getCalendarDetail(userId, businessId, type, dateStr) {
  await assertMembership(userId, businessId);

  // Determine period boundaries.
  let periodStart, periodEnd;
  if (type === "day") {
    const bounds = dayBounds(dateStr);
    periodStart = bounds.start;
    periodEnd = bounds.end;
  } else {
    // type === "month", dateStr like "2026-08"
    const [year, month] = dateStr.split("-").map(Number);
    const bounds = monthBounds(year, month);
    periodStart = bounds.start;
    periodEnd = bounds.end;
  }

  const isWithinPeriod = (value) => {
    if (!value) return false;
    const ms = new Date(value).getTime();
    return (
      ms >= new Date(periodStart).getTime() &&
      ms < new Date(periodEnd).getTime()
    );
  };

  // Run all queries in parallel.
  const [
    salesRes,
    paidSalesRes,
    stocksRes,
    consumptionRes,
    materialsRes,
    expensesRes,
  ] = await Promise.all([
    // Sales created in the period.
    supabase
      .from("sales")
      .select(
        "id, materialId, qty_used, total_amount, status, remarks, created_at, paid_at",
      )
      .eq("businessId", businessId)
      .is("deletedAt", null)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
    // Paid sales whose paid_at falls in the period, even if they were created earlier.
    supabase
      .from("sales")
      .select(
        "id, materialId, qty_used, total_amount, status, remarks, created_at, paid_at",
      )
      .eq("businessId", businessId)
      .eq("status", "PAID")
      .is("deletedAt", null)
      .or(`paid_at.gte.${periodStart},created_at.gte.${periodStart}`),
    // Stocks added in the period.
    supabase
      .from("stocks")
      .select("id, materialId, quantity, quantity_sold, mfg_price, created_at")
      .eq("businessId", businessId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
    // Consumption history within period
    supabase
      .from("stock_consumption_history")
      .select("stockId, quantity_deducted, remaining_stock, created_at")
      .gte("created_at", periodStart)
      .eq("business_id", businessId)
      .lt("created_at", periodEnd),
    // All active materials for this business (for name/unit lookup)
    supabase
      .from("materials")
      .select("id, name")
      .eq("businessId", businessId)
      .is("deletedAt", null),
    // Expenses in the period for the expense section.
    supabase
      .from("expenses")
      .select("id, title, category, amount, remarks, stock_id, created_at")
      .eq("businessId", businessId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
  ]);

  if (salesRes.error) throw new Error(salesRes.error.message);
  if (paidSalesRes.error) throw new Error(paidSalesRes.error.message);
  if (stocksRes.error) throw new Error(stocksRes.error.message);
  if (consumptionRes.error) throw new Error(consumptionRes.error.message);
  if (materialsRes.error) throw new Error(materialsRes.error.message);
  if (expensesRes.error) throw new Error(expensesRes.error.message);

  const sales = salesRes.data || [];
  const paidSales = paidSalesRes.data || [];
  const stocks = stocksRes.data || [];
  const consumptions = consumptionRes.data || [];
  const materials = materialsRes.data || [];
  const expenses = expensesRes.data || [];

  // Keep every stock lookup in one initialized map. Consumption and expense
  // records may refer to stocks created outside the requested calendar period.
  const stockById = new Map(stocks.map((stock) => [stock.id, stock]));

  const missingStockIds = [
    ...consumptions.map((c) => c.stockId),
    ...expenses.filter((e) => e.stock_id).map((e) => e.stock_id),
  ].filter((stockId) => stockId && !stockById.has(stockId));

  if (missingStockIds.length > 0) {
    const uniqueIds = [...new Set(missingStockIds)];
    const { data: extraStocks, error: extraErr } = await supabase
      .from("stocks")
      .select("id, materialId, quantity, quantity_sold, mfg_price, created_at")
      .in("id", uniqueIds);
    if (extraErr) throw new Error(extraErr.message);
    for (const s of extraStocks || []) stockById.set(s.id, s);
  }

  const materialMap = new Map(materials.map((m) => [m.id, m]));
  const salesByMaterialAcc = new Map();
  const stockConsumptionByMaterial = new Map();
  const stockConsumptionById = new Map();
  const expenseRows = [];
  const relevantSales = new Map();

  for (const sale of sales) {
    if (sale.status === "PAID") {
      if (isWithinPeriod(sale.paid_at)) {
        relevantSales.set(sale.id, sale);
      }
      continue;
    }
    relevantSales.set(sale.id, sale);
  }

  for (const sale of paidSales) {
    if (!isWithinPeriod(getPaidTimestamp(sale))) continue;
    if (!relevantSales.has(sale.id)) {
      relevantSales.set(sale.id, sale);
    }
  }

  function getSalesBucket(materialId) {
    if (!salesByMaterialAcc.has(materialId)) {
      salesByMaterialAcc.set(materialId, {
        materialId,
        name: materialMap.get(materialId)
          ? materialMap.get(materialId).name
          : null,
        paid: 0,
        pending: 0,
        qtyConsumed: 0,
        salesAmount: 0,
      });
    }
    return salesByMaterialAcc.get(materialId);
  }

  function getStockConsumptionBucket(materialId) {
    if (!stockConsumptionByMaterial.has(materialId)) {
      const material = materialMap.get(materialId);
      stockConsumptionByMaterial.set(materialId, {
        materialId,
        name: material ? material.name : null,
        totalConsumed: 0,
        stockAdded: 0,
        remainingStock: 0,
        scrapQty: 0,
        abandonedQty: 0,
        rejectQty: 0,
        soldQty: 0,
        batches: [],
      });
    }
    return stockConsumptionByMaterial.get(materialId);
  }

  let totalRevenue = 0;
  let totalSalesCount = 0;
  let pendingSalesCount = 0;

  for (const sale of relevantSales.values()) {
    const bucket = getSalesBucket(sale.materialId);
    totalSalesCount += 1;

    if (sale.status === "PAID") {
      const amount = sale.total_amount || 0;
      bucket.paid += 1;
      bucket.qtyConsumed += sale.qty_used || 0;
      bucket.salesAmount += amount;
      totalRevenue += amount;
      getStockConsumptionBucket(sale.materialId).soldQty += sale.qty_used || 0;
    } else if (sale.status === "PENDING") {
      bucket.pending += 1;
      pendingSalesCount += 1;
    } else if (sale.status === "SCRAP") {
      getStockConsumptionBucket(sale.materialId).scrapQty += sale.qty_used || 0;
    } else if (sale.status === "ABANDONED") {
      getStockConsumptionBucket(sale.materialId).abandonedQty +=
        sale.qty_used || 0;
    } else if (sale.status === "REJECT") {
      getStockConsumptionBucket(sale.materialId).rejectQty +=
        sale.qty_used || 0;
    }
  }

  for (const stock of stocks) {
    const bucket = getStockConsumptionBucket(stock.materialId);
    bucket.stockAdded += stock.quantity || 0;
  }

  // Consumption
  for (const c of consumptions) {
    const stock = stockById.get(c.stockId);
    const materialId = stock ? stock.materialId : null;
    if (!materialId) continue;
    const stockEntry = stockConsumptionById.get(c.stockId) || {
      stockId: c.stockId,
      totalDeducted: 0,
      latestRemaining: 0,
      latestCreatedAt: null,
    };
    stockEntry.totalDeducted += c.quantity_deducted || 0;
    if (
      !stockEntry.latestCreatedAt ||
      new Date(c.created_at).getTime() >=
        new Date(stockEntry.latestCreatedAt).getTime()
    ) {
      stockEntry.latestCreatedAt = c.created_at;
      stockEntry.latestRemaining = c.remaining_stock || 0;
    }
    stockConsumptionById.set(c.stockId, stockEntry);
  }

  for (const expense of expenses) {
    const stock = expense.stock_id ? stockById.get(expense.stock_id) : null;
    const linkedMaterial =
      stock && materialMap.get(stock.materialId)
        ? materialMap.get(stock.materialId).name
        : null;
    const amount = stock ? stock.mfg_price || 0 : expense.amount || 0;
    expenseRows.push({
      title: expense.title,
      category: expense.category || "OTHER",
      amount: round2(amount),
      remarks: expense.remarks || null,
      linkedMaterial,
    });
  }

  for (const [, entry] of stockConsumptionById.entries()) {
    const stock = stockById.get(entry.stockId);
    if (!stock) continue;
    const material = materialMap.get(stock.materialId);
    const bucket = getStockConsumptionBucket(stock.materialId);
    bucket.totalConsumed += entry.totalDeducted;
    bucket.remainingStock += entry.latestRemaining || 0;
    if (!bucket.name && material) bucket.name = material.name;
  }

  const salesByMaterial = [...salesByMaterialAcc.values()]
    .map((bucket) => ({
      materialId: bucket.materialId,
      name: bucket.name,
      paid: bucket.paid,
      pending: bucket.pending,
      qtyConsumed: Math.round(bucket.qtyConsumed * 100) / 100,
      salesAmount: round2(bucket.salesAmount),
    }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const stockConsumption = [...stockConsumptionByMaterial.values()]
    .map((bucket) => ({
      materialId: bucket.materialId,
      name: bucket.name,
      totalConsumed: round2(bucket.totalConsumed),
      soldQty: round2(bucket.soldQty),
      scrapQty: round2(bucket.scrapQty),
      abandonedQty: round2(bucket.abandonedQty),
      rejectQty: round2(bucket.rejectQty),
      stockAdded: round2(bucket.stockAdded),
      remainingStock: round2(bucket.remainingStock),
    }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const expensesList = expenseRows.sort((a, b) => {
    const titleCompare = (a.title || "").localeCompare(b.title || "");
    if (titleCompare !== 0) return titleCompare;
    return (a.category || "").localeCompare(b.category || "");
  });

  const revenue = round2(totalRevenue);
  const expensesTotal = round2(
    expensesList.reduce((sum, expense) => sum + (expense.amount || 0), 0),
  );

  return {
    totalRevenue: revenue,
    totalSalesCount,
    pendingSalesCount,
    totalExpenses: expensesTotal,
    profitLossSummary: {
      revenue,
      totalExpenses: expensesTotal,
    },
    salesByMaterial,
    stockConsumption,
    expenses: expensesList,
  };
}

module.exports = { getCalendarOverview, getCalendarDetail };
