const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");

// Confirms the user is an accepted member of the business; throws 403 otherwise.
async function assertMembership(userId, businessId) {
  const { data, error } = await supabase
    .from("business_members")
    .select("id")
    .eq("userId", userId)
    .eq("businessId", businessId)
    .eq("status", "accepted")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw httpError(403, "You are not a member of this business");
  }
}

// The member_actions boolean columns, keyed by a stable action name.
const ACTIONS = {
  ADD_MATERIAL: "add_material",
  UPDATE_MATERIAL: "update_material",
  DELETE_MATERIAL: "delete_material",
  ADD_STOCKS: "add_stocks",
  UPDATE_STOCKS: "update_stocks",
  DELETE_STOCKS: "delete_stocks",
  CREATE_SALES: "create_sales",
  UPDATE_SALES: "update_sales",
  DELETE_SALES: "delete_sales",
  ADD_EXPENSE: "add_expense",
  UPDATE_EXPENSE: "update_expense",
  DELETE_EXPENSE: "delete_expense",
};

// Confirms the user is an accepted member of the business AND has the given
// member_actions permission. The business owner implicitly has every action.
// Throws 403 if not a member or the permission is not granted.
async function assertAction(userId, businessId, action) {
  const { data: member, error } = await supabase
    .from("business_members")
    .select("id, role, status")
    .eq("userId", userId)
    .eq("businessId", businessId)
    .eq("status", "accepted")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!member) {
    throw httpError(403, "You are not a member of this business");
  }

  // The owner can perform every action regardless of member_actions.
  if ((member.role || "").toLowerCase() === "owner") {
    return;
  }

  const { data: actions, error: actionsError } = await supabase
    .from("member_actions")
    .select(action)
    .eq("memberId", member.id)
    .maybeSingle();

  if (actionsError) {
    throw new Error(actionsError.message);
  }
  if (!actions || actions[action] !== true) {
    throw httpError(403, "You do not have permission to perform this action");
  }
}

// Confirms the user owns the business; throws 403 otherwise (404 if no such business).
async function assertOwner(userId, businessId) {
  const { data, error } = await supabase
    .from("business")
    .select("ownerId")
    .eq("id", businessId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw httpError(404, "Business not found");
  }
  if (data.ownerId !== userId) {
    throw httpError(403, "Only the business owner can perform this action");
  }
}

module.exports = { assertMembership, assertOwner, assertAction, ACTIONS };
