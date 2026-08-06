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

module.exports = { assertMembership };
