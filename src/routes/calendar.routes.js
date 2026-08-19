const express = require("express");
const calendarController = require("../controllers/calendar.controller");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// Overview: daily % change (month view) or monthly % change (year view).
router.get(
  "/businesses/:businessId/calendar",
  calendarController.getCalendarOverview,
);

// Detail: material-level breakdown for a clicked day or month.
router.get(
  "/businesses/:businessId/calendar/detail",
  calendarController.getCalendarDetail,
);

module.exports = router;
