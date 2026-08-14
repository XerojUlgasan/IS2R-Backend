# IS2R Calendar Detail — Enhanced API Response Guide

## Overview

The frontend `exportCalendarExcel` utility now expects a richer `detail` object from
`GET /api/businesses/:businessId/calendar/detail`.  
This document describes every new field required and the exact query logic to produce it.

All queries must:
- Filter by `businessId` on every table that has it
- Respect soft deletes (`deletedAt IS NULL`) except where explicitly noted
- Use Manila UTC+8 period boundaries (already implemented via `dayBounds` / `monthBounds`)

---

## Current vs Required Response Shape

### Currently returned
```json
{
  "totalSalesAmount": 0,
  "totalSalesCount": 0,
  "totalStockAdded": 0,
  "totalConsumed": 0,
  "totalScrapQty": 0,
  "totalAbandonedQty": 0,
  "deletedSalesCount": 0,
  "deletedStocksCount": 0,
  "materials": [...]
}
```

### Required (new fields in **bold**)
```json
{
  "totalSalesAmount": 0,
  "totalSalesCount": 0,
  "totalStockAdded": 0,
  "totalConsumed": 0,
  "deletedSalesCount": 0,
  "deletedStocksCount": 0,

  "pendingSalesCount": 0,
  "scrapCount": 0,
  "abandonedCount": 0,
  "rejectedCount": 0,
  "totalExpenses": 0,
  "revenue": 0,
  "cogs": 0,
  "grossProfit": 0,
  "netProfitLoss": 0,

  "salesByMaterial": [...],
  "stockConsumption": [...],
  "generalExpenses": [...],
  "stockExpenses": [...]
}
```

---

## New Top-Level Fields

| Field | Type | Query Logic |
|---|---|---|
| `pendingSalesCount` | int | COUNT sales WHERE status = 'PENDING' AND deletedAt IS NULL in period |
| `scrapCount` | int | COUNT sales WHERE status = 'SCRAP' AND deletedAt IS NULL in period |
| `abandonedCount` | int | COUNT sales WHERE status = 'ABANDONED' AND deletedAt IS NULL in period |
| `rejectedCount` | int | COUNT sales WHERE status = 'REJECT' AND deletedAt IS NULL in period |
| `totalExpenses` | float | SUM expenses.amount WHERE businessId AND created_at in period |
| `revenue` | float | Same as `totalSalesAmount` (PAID sales only) — alias for clarity |
| `cogs` | float | SUM of `stocks.mfg_price` for each **distinct** stockId that appears in `stock_consumption_history` during the period. Do NOT multiply by quantity. |
| `grossProfit` | float | `revenue - cogs` |
| `netProfitLoss` | float | `grossProfit - totalExpenses` |

---

## `salesByMaterial` Array

One entry per material that had any sales activity in the period.

```json
{
  "materialId": "uuid",
  "name": "Material Name",
  "paid": 3,
  "pending": 1,
  "scrap": 0,
  "abandoned": 0,
  "reject": 0,
  "salesAmount": 1500.00,
  "deletedSales": 0
}
```

### Query logic
```
SELECT
  s.materialId,
  m.name,
  COUNT(*) FILTER (WHERE s.status = 'PAID'      AND s.deletedAt IS NULL) AS paid,
  COUNT(*) FILTER (WHERE s.status = 'PENDING'   AND s.deletedAt IS NULL) AS pending,
  COUNT(*) FILTER (WHERE s.status = 'SCRAP'     AND s.deletedAt IS NULL) AS scrap,
  COUNT(*) FILTER (WHERE s.status = 'ABANDONED' AND s.deletedAt IS NULL) AS abandoned,
  COUNT(*) FILTER (WHERE s.status = 'REJECT'    AND s.deletedAt IS NULL) AS reject,
  SUM(s.total_amount) FILTER (WHERE s.status = 'PAID' AND s.deletedAt IS NULL) AS salesAmount,
  COUNT(*) FILTER (WHERE s.deletedAt IS NOT NULL) AS deletedSales
FROM is2r.sales s
JOIN is2r.materials m ON m.id = s.materialId
WHERE s.businessId = :businessId
  AND s.created_at >= :periodStart
  AND s.created_at <  :periodEnd
GROUP BY s.materialId, m.name
ORDER BY m.name
```

> Note: deleted sales are counted by `deletedAt` falling in the period (existing behaviour).
> Keep the existing separate `deletedSalesRes` query for the top-level `deletedSalesCount`,
> or derive it as SUM of `deletedSales` across `salesByMaterial`.

---

## `stockConsumption` Array

One entry per material that had stock consumption activity in the period. No batch sub-rows.

```json
{
  "materialId": "uuid",
  "name": "Material Name",
  "totalConsumed": 12.5,
  "batchesConsumed": 2,
  "stockAdded": 50.0,
  "remainingStock": 37.5,
  "scrapQty": 1.0,
  "rejectedQty": 0.5
}
```

`scrapQty` = SUM of `sales.qty_used` WHERE `status = 'SCRAP'` AND `deletedAt IS NULL` for that material in the period.  
`rejectedQty` = SUM of `sales.qty_used` WHERE `status = 'REJECT'` AND `deletedAt IS NULL` for that material in the period.

### Query logic

**Step 1 — consumption in period**
```
SELECT
  sch.stockId,
  SUM(sch.quantity_deducted) AS totalDeducted,
  MAX(sch.remaining_stock)   AS latestRemaining   -- most recent remaining per batch
FROM is2r.stock_consumption_history sch
WHERE sch.created_at >= :periodStart
  AND sch.created_at <  :periodEnd
GROUP BY sch.stockId
```

**Step 2 — join stocks + materials**
```
SELECT
  st.id          AS batchId,
  st.materialId,
  m.name,
  st.mfg_price   AS mfgPrice,
  st.quantity    AS qtyAdded,
  st.status
FROM is2r.stocks st
JOIN is2r.materials m ON m.id = st.materialId
WHERE st.id IN (:consumedStockIds)
  AND st.deletedAt IS NULL
```

**Step 3 — stock added in period (for `stockAdded` column)**
```
SELECT materialId, SUM(quantity) AS stockAdded
FROM is2r.stocks
WHERE businessId = :businessId
  AND deletedAt IS NULL
  AND created_at >= :periodStart
  AND created_at <  :periodEnd
GROUP BY materialId
```

**Step 4 — assemble per material**
- `totalConsumed`   = SUM of `totalDeducted` across all batches for that material
- `batchesConsumed` = COUNT DISTINCT stockId consumed for that material
- `stockAdded`      = from Step 3 (0 if no new stock this period)
- `remainingStock`  = SUM of `latestRemaining` across all batches for that material
- `batches`         = array of batch rows with `qtyDeducted` and `remainingStock` from Step 1

---

## `generalExpenses` and `stockExpenses` Arrays

Both arrays are consumed by the frontend and merged into a single flat expenses table.
Each entry must include a `title` field (the expense title from `expenses.title`).
Stock-linked expenses must include `materialName` (via `stock_id → stocks.materialId → materials.name`).
Do NOT include `batchId` in the response — it is not displayed.

### `generalExpenses` — expenses WHERE `stock_id IS NULL`
```json
{ "title": "Electric bill", "category": "UTILITIES", "amount": 400.00, "remarks": "July" }
```

### `stockExpenses` — expenses WHERE `stock_id IS NOT NULL`
```json
{ "title": "Restock fee", "category": "MATERIALS", "amount": 500.00, "remarks": null, "materialName": "Tarpaulin" }
```

---

## COGS Calculation

```
SELECT SUM(DISTINCT st.mfg_price)
FROM is2r.stock_consumption_history sch
JOIN is2r.stocks st ON st.id = sch.stockId
WHERE sch.created_at >= :periodStart
  AND sch.created_at <  :periodEnd
  AND st.businessId = :businessId
```

> **Important:** `SUM(DISTINCT mfg_price)` sums the price once per unique stock batch,
> regardless of how many times that batch was consumed. This matches the spec.
> If two batches happen to share the same `mfg_price`, use `SUM` over distinct `stockId`s
> in application code to avoid accidental deduplication by value.

Recommended approach in JS:
```js
const uniqueStockIds = [...new Set(consumptions.map(c => c.stockId))];
const cogs = uniqueStockIds.reduce((sum, id) => sum + (stockPriceMap.get(id) ?? 0), 0);
```

---

## Implementation Checklist

- [ ] Add `pendingSalesCount`, `scrapCount`, `abandonedCount`, `rejectedCount` to top-level (derive from existing `sales` query, just add status buckets)
- [ ] Add `totalExpenses` query (new — expenses table not currently queried)
- [ ] Add `salesByMaterial` array (replace/supplement existing `materials` array)
- [ ] Add `stockConsumption` array with nested `batches` (extend existing consumption logic)
- [ ] Add `generalExpenses` query
- [ ] Add `stockExpenses` query
- [ ] Compute `cogs`, `grossProfit`, `netProfitLoss`, `revenue` and add to response
- [ ] Keep existing `materials` array in response for backward compatibility with the UI summary panel (or remove once UI is updated)

---

## Backward Compatibility

The existing `materials` array and all current top-level fields (`totalSalesAmount`,
`totalSalesCount`, `totalStockAdded`, `totalConsumed`, `deletedSalesCount`,
`deletedStocksCount`) must remain in the response unchanged so the calendar UI
summary panel continues to work without modification.
