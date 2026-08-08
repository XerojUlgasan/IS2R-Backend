const express = require("express");
const expenseController = require("../controllers/expense.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Every expense route requires a valid authenticated user.
router.use(requireAuth);

// Business-scoped: list and create live under the business.
router.get("/businesses/:businessId/expenses", expenseController.listExpenses);
router.post("/businesses/:businessId/expenses", expenseController.createExpense);

// Expense-scoped: authorization resolves the expense's business internally.
router.patch("/expenses/:expenseId", expenseController.updateExpense);
router.delete("/expenses/:expenseId", expenseController.deleteExpense);

module.exports = router;
