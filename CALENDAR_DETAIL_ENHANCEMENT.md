# IS2R Calendar Detail

## Goal

`GET /api/businesses/:businessId/calendar/detail` now returns a simple report:

```json
{
  "totalRevenue": 0,
  "totalSalesCount": 0,
  "pendingSalesCount": 0,
  "totalExpenses": 0,
  "profitLossSummary": {
    "revenue": 0,
    "totalExpenses": 0
  },
  "salesByMaterial": [],
  "stockConsumption": [],
  "expenses": []
}
```

## Rules

- Revenue uses `sales.paid_at` for paid sales.
- Pending sales still use the sale record in the selected period.
- Do not compute COGS, gross profit, or net profit/loss.
- Keep the sections easy to read and flat.

## `salesByMaterial`

One row per material with sales activity in the period.

```json
{
  "materialId": "uuid",
  "name": "Material Name",
  "paid": 2,
  "pending": 1,
  "qtyConsumed": 20,
  "salesAmount": 3000
}
```

## `stockConsumption`

One row per material with stock consumption activity.

```json
{
  "materialId": "uuid",
  "name": "Material Name",
  "totalConsumed": 40,
  "soldQty": 20,
  "scrapQty": 0,
  "abandonedQty": 0,
  "rejectQty": 0,
  "stockAdded": 0,
  "remainingStock": 90
}
```

## `expenses`

Flat list of expenses in the period.

```json
{
  "title": "Electric bill",
  "category": "UTILITIES",
  "amount": 400,
  "remarks": "July",
  "linkedMaterial": null
}
```

If the expense is linked to a stock batch, `linkedMaterial` is the material name.
