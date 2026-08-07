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
    throw httpError(403, "Only the business owner can manage members");
  }
}

module.exports = { assertMembership, assertOwner };
