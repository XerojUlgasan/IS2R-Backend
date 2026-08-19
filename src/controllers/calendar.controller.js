const calendarService = require("../services/calendar.service");

function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// GET /api/businesses/:businessId/calendar?view=month|year&date=YYYY-MM-DD
async function getCalendarOverview(req, res) {
  const { view, date } = req.query;

  if (!view || !["month", "year"].includes(view)) {
    return res.status(400).json({ error: 'view must be "month" or "year"' });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be a valid ISO date (YYYY-MM-DD)" });
  }

  try {
    const result = await calendarService.getCalendarOverview(
      req.user.id,
      req.params.businessId,
      view,
      date
    );
    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, "getCalendarOverview");
  }
}

// GET /api/businesses/:businessId/calendar/detail?type=day|month&date=YYYY-MM-DD|YYYY-MM
// GET /api/businesses/:businessId/calendar/detail?from=YYYY-MM-DD&to=YYYY-MM-DD
async function getCalendarDetail(req, res) {
  const { type, date, from, to } = req.query;

  try {
    let result;
    
    if (from && to) {
      // Custom date range query
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: "from and to must be valid ISO dates (YYYY-MM-DD)" });
      }
      
      if (new Date(from) > new Date(to)) {
        return res.status(400).json({ error: "fromDate must be before or equal to toDate" });
      }
      
      result = await calendarService.getCalendarDetailRange(
        req.user.id,
        req.params.businessId,
        from,
        to
      );
    } else if (type && date) {
      // Existing single date query (backward compatibility)
      if (!type || !["day", "month"].includes(type)) {
        return res.status(400).json({ error: 'type must be "day" or "month"' });
      }

      // Validate date format based on type.
      if (type === "day" && (!/^\d{4}-\d{2}-\d{2}$/.test(date))) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD for type=day" });
      }
      if (type === "month" && (!/^\d{4}-\d{2}$/.test(date))) {
        return res.status(400).json({ error: "date must be YYYY-MM for type=month" });
      }

      result = await calendarService.getCalendarDetail(
        req.user.id,
        req.params.businessId,
        type,
        date
      );
    } else {
      return res.status(400).json({ 
        error: 'Either (type and date) or (from and to) parameters required' 
      });
    }
    
    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, "getCalendarDetail");
  }
}

module.exports = { getCalendarOverview, getCalendarDetail };
