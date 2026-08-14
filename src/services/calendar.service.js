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
    .select("total_amount, created_at")
    .eq("businessId", businessId)
    .eq("status", "PAID")
    .is("deletedAt", null)
    .gte("created_at", fetchStart)
    .lt("created_at", fetchEnd);

  if (error) throw new Error(error.message);

  // Bucket totals by Manila-local day key "YYYY-MM-DD".
  const dailyTotals = new Map();
  for (const sale of data || []) {
    const ms = new Date(sale.created_at).getTime();
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
    .select("total_amount, created_at")
    .eq("businessId", businessId)
    .eq("status", "PAID")
    .is("deletedAt", null)
    .gte("created_at", fetchStart)
    .lt("created_at", fetchEnd);

  if (error) throw new Error(error.message);

  // Bucket by Manila-local "YYYY-MM".
  const monthlyTotals = new Map();
  for (const sale of data || []) {
    const ms = new Date(sale.created_at).getTime();
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

  // Run all queries in parallel.
  const [
    salesRes,
    deletedSalesRes,
    stocksRes,
    deletedStocksRes,
    consumptionRes,
    materialsRes,
    expensesRes,
  ] = await Promise.all([
    // Non-deleted sales in period (only PAID count toward salesAmount)
    supabase
      .from("sales")
      .select("id, materialId, qty_used, total_amount, status, created_at")
      .eq("businessId", businessId)
      .is("deletedAt", null)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
    // Deleted sales (deletedAt within period)
    supabase
      .from("sales")
      .select("id, materialId, deletedAt")
      .eq("businessId", businessId)
      .not("deletedAt", "is", null)
      .gte("deletedAt", periodStart)
      .lt("deletedAt", periodEnd),
    // Non-deleted stocks added in period
    supabase
      .from("stocks")
      .select(
        "id, materialId, quantity, quantity_sold, mfg_price, status, created_at, deletedAt",
      )
      .eq("businessId", businessId)
      .is("deletedAt", null)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
    // Deleted stocks (deletedAt within period)
    supabase
      .from("stocks")
      .select("id, materialId, deletedAt")
      .eq("businessId", businessId)
      .not("deletedAt", "is", null)
      .gte("deletedAt", periodStart)
      .lt("deletedAt", periodEnd),
    // Consumption history within period
    supabase
      .from("stock_consumption_history")
      .select("stockId, quantity_deducted, remaining_stock, created_at")
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
    // All active materials for this business (for name/unit lookup)
    supabase
      .from("materials")
      .select("id, name")
      .eq("businessId", businessId)
      .is("deletedAt", null),
    // Expenses in the period for profit and loss reporting.
    supabase
      .from("expenses")
      .select("id, category, amount, remarks, stock_id, created_at")
      .eq("businessId", businessId)
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
  ]);

  if (salesRes.error) throw new Error(salesRes.error.message);
  if (deletedSalesRes.error) throw new Error(deletedSalesRes.error.message);
  if (stocksRes.error) throw new Error(stocksRes.error.message);
  if (deletedStocksRes.error) throw new Error(deletedStocksRes.error.message);
  if (consumptionRes.error) throw new Error(consumptionRes.error.message);
  if (materialsRes.error) throw new Error(materialsRes.error.message);
  if (expensesRes.error) throw new Error(expensesRes.error.message);

  const sales = salesRes.data || [];
  const deletedSales = deletedSalesRes.data || [];
  const stocks = stocksRes.data || [];
  const deletedStocks = deletedStocksRes.data || [];
  const consumptions = consumptionRes.data || [];
  const materials = materialsRes.data || [];
  const expenses = expensesRes.data || [];

  // Build a stockId -> materialId map for consumption lookup.
  // We need stocks from the whole business, not just the period, since
  // consumption history references stocks created at any time.
  // However we already have stocks created this period; for older stocks
  // referenced in consumption history we need an extra lookup.
  const stockById = new Map();
  for (const s of stocks) stockById.set(s.id, s);

  // Gather any stockIds referenced by consumption or expenses that we don't have yet.
  const missingStockIds = [
    ...consumptions.map((c) => c.stockId),
    ...expenses.filter((e) => e.stock_id).map((e) => e.stock_id),
  ].filter((stockId) => stockId && !stockById.has(stockId));

  if (missingStockIds.length > 0) {
    const uniqueIds = [...new Set(missingStockIds)];
    const { data: extraStocks, error: extraErr } = await supabase
      .from("stocks")
      .select(
        "id, materialId, quantity, quantity_sold, mfg_price, status, created_at, deletedAt",
      )
      .in("id", uniqueIds);
    if (extraErr) throw new Error(extraErr.message);
    for (const s of extraStocks || []) stockById.set(s.id, s);
  }

  // Material lookup map.
  const materialMap = new Map(materials.map((m) => [m.id, m]));

  // Per-material accumulators.
  const acc = new Map(); // materialId -> { salesCount, salesAmount, scrapCount, abandonedCount, stockAdded, consumed, deletedSales, deletedStocks }

  const salesByMaterialAcc = new Map();
  const stockConsumptionByMaterial = new Map();
  const stockConsumptionById = new Map();
  const consumedStockIds = new Set();
  const expenseByCategory = new Map();
  const stockExpenseRows = [];

  function getSalesBucket(materialId) {
    if (!salesByMaterialAcc.has(materialId)) {
      salesByMaterialAcc.set(materialId, {
        materialId,
        paid: 0,
        pending: 0,
        scrap: 0,
        abandoned: 0,
        reject: 0,
        salesAmount: 0,
        deletedSales: 0,
        qtyConsumed: 0,
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
        batchesConsumed: 0,
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

  function getAcc(materialId) {
    if (!acc.has(materialId)) {
      acc.set(materialId, {
        salesCount: 0,
        salesAmount: 0,
        scrapQty: 0,
        abandonedQty: 0,
        stockAdded: 0,
        consumed: 0,
        deletedSales: 0,
        deletedStocks: 0,
      });
    }
    return acc.get(materialId);
  }

  // Sales
  for (const sale of sales) {
    const a = getAcc(sale.materialId);
    a.salesCount += 1;
    if (sale.status === "PAID") getSalesBucket(sale.materialId).qtyConsumed += sale.qty_used || 0;
    // Only PAID sales contribute to revenue amounts.
    if (sale.status === "PAID") {
      a.salesAmount += sale.total_amount || 0;
      getSalesBucket(sale.materialId).paid += 1;
      getStockConsumptionBucket(sale.materialId).soldQty += sale.qty_used || 0;
    } else if (sale.status === "SCRAP") {
      a.scrapQty += sale.qty_used || 0;
      getSalesBucket(sale.materialId).scrap += 1;
      getStockConsumptionBucket(sale.materialId).scrapQty += sale.qty_used || 0;
    } else if (sale.status === "ABANDONED") {
      a.abandonedQty += sale.qty_used || 0;
      getSalesBucket(sale.materialId).abandoned += 1;
      getStockConsumptionBucket(sale.materialId).abandonedQty += sale.qty_used || 0;
    } else if (sale.status === "PENDING") {
      getSalesBucket(sale.materialId).pending += 1;
    } else if (sale.status === "REJECT") {
      getSalesBucket(sale.materialId).reject += 1;
      getStockConsumptionBucket(sale.materialId).rejectQty += sale.qty_used || 0;
    }
    if (sale.status === "PAID") {
      getSalesBucket(sale.materialId).salesAmount += sale.total_amount || 0;
    }
  }

  // Deleted sales
  for (const sale of deletedSales) {
    const a = getAcc(sale.materialId);
    a.deletedSales += 1;
    getSalesBucket(sale.materialId).deletedSales += 1;
  }

  // Stocks added
  for (const stock of stocks) {
    const a = getAcc(stock.materialId);
    a.stockAdded += stock.quantity || 0;
  }

  // Deleted stocks
  for (const stock of deletedStocks) {
    const a = getAcc(stock.materialId);
    a.deletedStocks += 1;
  }

  // Consumption
  for (const c of consumptions) {
    const stock = stockById.get(c.stockId);
    const materialId = stock ? stock.materialId : null;
    if (!materialId) continue;
    const a = getAcc(materialId);
    a.consumed += c.quantity_deducted || 0;

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
    consumedStockIds.add(c.stockId);
  }

  // Expenses and stock expense detail.
  let totalExpenses = 0;
  for (const expense of expenses) {
    const category = expense.category || "OTHER";
    const amount =
      expense.stock_id && stockById.get(expense.stock_id)
        ? stockById.get(expense.stock_id).mfg_price || 0
        : expense.amount || 0;
    totalExpenses += amount;

    if (expense.stock_id) {
      const stock = stockById.get(expense.stock_id);
      stockExpenseRows.push({
        expenseId: expense.id,
        materialName:
          stock && materialMap.get(stock.materialId)
            ? materialMap.get(stock.materialId).name
            : null,
        batchId: expense.stock_id,
        category,
        amount: round2(amount),
        remarks: expense.remarks || null,
        created_at: expense.created_at,
      });
      continue;
    }

    if (!expenseByCategory.has(category)) {
      expenseByCategory.set(category, {
        category,
        count: 0,
        totalAmount: 0,
        remarks: [],
      });
    }
    const bucket = expenseByCategory.get(category);
    bucket.count += 1;
    bucket.totalAmount += amount;
    if (expense.remarks) bucket.remarks.push(expense.remarks);
  }

  // Consumption batches by material and cogs tracking.
  let cogs = 0;
  const uniqueConsumedStockIds = [...consumedStockIds];
  for (const stockId of uniqueConsumedStockIds) {
    const stock = stockById.get(stockId);
    if (!stock) continue;
    cogs += stock.mfg_price || 0;
  }

  for (const [, entry] of stockConsumptionById.entries()) {
    const stock = stockById.get(entry.stockId);
    if (!stock || (stock.deletedAt !== null && stock.deletedAt !== undefined))
      continue;
    const material = materialMap.get(stock.materialId);
    const bucket = getStockConsumptionBucket(stock.materialId);
    bucket.totalConsumed += entry.totalDeducted;
    bucket.batchesConsumed += 1;
    bucket.remainingStock += entry.latestRemaining || 0;
    bucket.batches.push({
      batchId: stock.id,
      mfgPrice: round2(stock.mfg_price || 0),
      qtyAdded: round2(stock.quantity || 0),
      qtyDeducted: round2(entry.totalDeducted),
      remainingStock: round2(entry.latestRemaining || 0),
      status: "ACTIVE",
    });
    if (!bucket.name && material) bucket.name = material.name;
  }

  // Build response.
  let totalSalesAmount = 0;
  let totalSalesCount = 0;
  let totalStockAdded = 0;
  let totalConsumed = 0;
  let totalScrapQty = 0;
  let totalAbandonedQty = 0;
  let deletedSalesCount = 0;
  let deletedStocksCount = 0;
  let pendingSalesCount = 0;
  let scrapCount = 0;
  let abandonedCount = 0;
  let rejectedCount = 0;

  const materialsArr = [];
  for (const [materialId, a] of acc.entries()) {
    // Only include materials with any activity.
    if (
      a.salesCount === 0 &&
      a.stockAdded === 0 &&
      a.consumed === 0 &&
      a.deletedSales === 0 &&
      a.deletedStocks === 0
    )
      continue;

    const mat = materialMap.get(materialId);
    materialsArr.push({
      id: materialId,
      name: mat ? mat.name : null,
      stockAdded: round2(a.stockAdded),
      consumed: round2(a.consumed),
      salesCount: a.salesCount,
      salesAmount: round2(a.salesAmount),
      scrapQty: round2(a.scrapQty),
      abandonedQty: round2(a.abandonedQty),
      deletedSales: a.deletedSales,
      deletedStocks: a.deletedStocks,
    });

    totalSalesAmount += a.salesAmount;
    totalSalesCount += a.salesCount;
    totalStockAdded += a.stockAdded;
    totalConsumed += a.consumed;
    totalScrapQty += a.scrapQty;
    totalAbandonedQty += a.abandonedQty;
    deletedSalesCount += a.deletedSales;
    deletedStocksCount += a.deletedStocks;
  }

  const salesByMaterial = [];
  for (const [materialId, bucket] of salesByMaterialAcc.entries()) {
    const mat = materialMap.get(materialId);
    salesByMaterial.push({
      materialId,
      name: mat ? mat.name : null,
      paid: bucket.paid,
      pending: bucket.pending,
      scrap: bucket.scrap,
      abandoned: bucket.abandoned,
      reject: bucket.reject,
      salesAmount: round2(bucket.salesAmount),
      deletedSales: bucket.deletedSales,
      qtyConsumed: Math.round(bucket.qtyConsumed * 100) / 100,
    });

    pendingSalesCount += bucket.pending;
    scrapCount += bucket.scrap;
    abandonedCount += bucket.abandoned;
    rejectedCount += bucket.reject;
  }
  salesByMaterial.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  // Sort materials alphabetically for stable ordering.
  materialsArr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const stockConsumption = [...stockConsumptionByMaterial.values()].map(
    (entry) => ({
      materialId: entry.materialId,
      name: entry.name,
      totalConsumed: round2(entry.totalConsumed),
      batchesConsumed: entry.batchesConsumed,
      stockAdded: round2(
        stocks
          .filter((stock) => stock.materialId === entry.materialId)
          .reduce((sum, stock) => sum + (stock.quantity || 0), 0),
      ),
      remainingStock: round2(entry.remainingStock),
      scrapQty: round2(entry.scrapQty),
      abandonedQty: round2(entry.abandonedQty),
      rejectQty: round2(entry.rejectQty),
      soldQty: round2(entry.soldQty),
      batches: entry.batches.sort((a, b) =>
        (a.batchId || "").localeCompare(b.batchId || ""),
      ),
    }),
  );
  stockConsumption.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const generalExpenses = [...expenseByCategory.values()]
    .map((bucket) => ({
      category: bucket.category,
      count: bucket.count,
      totalAmount: round2(bucket.totalAmount),
      remarks: bucket.remarks.join(" | "),
    }))
    .sort((a, b) => (a.category || "").localeCompare(b.category || ""));

  stockExpenseRows.sort((a, b) => {
    const nameCompare = (a.materialName || "").localeCompare(
      b.materialName || "",
    );
    if (nameCompare !== 0) return nameCompare;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  const stockExpenses = stockExpenseRows.map(({ created_at, ...row }) => row);

  const revenue = round2(totalSalesAmount);
  const cogsTotal = round2(cogs);
  const grossProfit = round2(revenue - cogsTotal);
  const netProfitLoss = round2(grossProfit - totalExpenses);

  return {
    totalSalesAmount: revenue,
    totalSalesCount,
    totalStockAdded: round2(totalStockAdded),
    totalConsumed: round2(totalConsumed),
    totalScrapQty: round2(totalScrapQty),
    totalAbandonedQty: round2(totalAbandonedQty),
    deletedSalesCount,
    deletedStocksCount,
    pendingSalesCount,
    scrapCount,
    abandonedCount,
    rejectedCount,
    totalExpenses: round2(totalExpenses),
    revenue,
    cogs: cogsTotal,
    grossProfit,
    netProfitLoss,
    salesByMaterial,
    stockConsumption,
    generalExpenses,
    stockExpenses,
    materials: materialsArr,
  };
}

module.exports = { getCalendarOverview, getCalendarDetail };
