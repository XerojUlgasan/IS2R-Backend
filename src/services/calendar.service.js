const { supabase } = require("../lib/supabaseClient");
const { assertMembership } = require("./membership.service");

// =====================================================================
// 1. Calendar Overview
// =====================================================================

async function getCalendarOverview(userId, businessId, view, dateStr) {
  await assertMembership(userId, businessId);

  const { data, error } = await supabase.rpc("get_calendar_overview", {
    p_business_id: businessId,
    p_view: view,
    p_date_str: dateStr,
  });

  if (error) throw new Error(error.message);
  return data;
}

// =====================================================================
// 2. Calendar Detail
// =====================================================================

async function getCalendarDetail(userId, businessId, type, dateStr) {
  await assertMembership(userId, businessId);

  const { data, error } = await supabase.rpc("get_calendar_detail", {
    p_business_id: businessId,
    p_type: type,
    p_date_str: dateStr,
  });

  if (error) throw new Error(error.message);
  return data;
}

// =====================================================================
// 3. Calendar Detail Range (Custom Date Range)
// =====================================================================

async function getCalendarDetailRange(userId, businessId, fromDate, toDate) {
  await assertMembership(userId, businessId);

  const { data, error } = await supabase.rpc("get_calendar_detail_range", {
    p_business_id: businessId,
    p_from_date: fromDate,
    p_to_date: toDate,
  });

  if (error) throw new Error(error.message);
  return data;
}

module.exports = { getCalendarOverview, getCalendarDetail, getCalendarDetailRange };
