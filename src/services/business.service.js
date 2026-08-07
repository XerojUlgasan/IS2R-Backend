const { supabase } = require("../lib/supabaseClient");

// Returns every business the given user is an accepted member of,
// merged with that business's settings and the user's role.
async function getBusinessesForUser(userId) {
  // 1. Find the user's memberships.
  const { data: memberships, error: membershipError } = await supabase
    .from("business_members")
    .select("businessId, role, acceptedAt, created_at")
    .eq("userId", userId)
    .eq("status", "accepted");

  if (membershipError) {
    console.error("[getBusinessesForUser] membership query error:", membershipError);
    throw new Error(membershipError.message);
  }

  if (!memberships || memberships.length === 0) {
    return [];
  }

  // 2. Load settings for just those businesses.
  const businessIds = memberships.map((member) => member.businessId);
  const { data: settings, error: settingsError } = await supabase
    .from("business_settings")
    .select("businessid, name, logo_img_loc")
    .in("businessid", businessIds);

  if (settingsError) {
    console.error("[getBusinessesForUser] settings query error:", settingsError);
    throw new Error(settingsError.message);
  }

  const settingsByBusinessId = new Map(
    (settings || []).map((setting) => [setting.businessid, setting])
  );

  // 3. Shape the response the API contract expects.
  return memberships.map((member) => {
    const setting = settingsByBusinessId.get(member.businessId);
    return {
      id: member.businessId,
      name: setting ? setting.name : null,
      logo_img_loc: setting ? setting.logo_img_loc : null,
      role: member.role,
      joinedAt: member.acceptedAt || member.created_at,
    };
  });
}

// Creates a business, its settings row, and an OWNER membership for the creator.
async function createBusiness(userId, details) {
  // 1. Create the business owned by the creator.
  const { data: business, error: businessError } = await supabase
    .from("business")
    .insert({ ownerId: userId })
    .select("id")
    .single();

  if (businessError) {
    throw new Error(businessError.message);
  }

  const businessId = business.id;

  // 2. Create the matching settings row.
  const { error: settingsError } = await supabase
    .from("business_settings")
    .insert({
      businessid: businessId,
      name: details.name,
      description: details.description || null,
      contact_number: details.contact_number || null,
      address: details.address || null,
    });

  if (settingsError) {
    await deleteBusiness(businessId);
    throw new Error(settingsError.message);
  }

  // 3. Link the creator as an accepted OWNER.
  const { data: member, error: memberError } = await supabase
    .from("business_members")
    .insert({
      userId,
      businessId,
      role: "OWNER",
      status: "accepted",
      acceptedAt: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (memberError) {
    await deleteBusiness(businessId);
    throw new Error(memberError.message);
  }

  // 4. Grant the owner every permission via a member_actions row.
  const { error: actionsError } = await supabase
    .from("member_actions")
    .insert({ memberId: member.id, businessId: business.id, ...OWNER_ACTIONS });

  if (actionsError) {
    await deleteBusiness(businessId);
    throw new Error(actionsError.message);
  }

  return {
    id: businessId,
    name: details.name,
    role: "OWNER",
  };
}

// Every member_action permission granted — the owner can do everything.
const OWNER_ACTIONS = {
  add_material: true,
  update_material: true,
  delete_material: true,
  add_stocks: true,
  update_stocks: true,
  delete_stocks: true,
  create_sales: true,
  update_sales: true,
  delete_sales: true,
};

// Removes a business row (used to clean up after a failed multi-step create).
// member_actions must go first: its FK to business_members has no cascade.
async function deleteBusiness(businessId) {
  await supabase.from("member_actions").delete().eq("businessId", businessId);
  await supabase.from("business_settings").delete().eq("businessid", businessId);
  await supabase.from("business_members").delete().eq("businessId", businessId);
  await supabase.from("business").delete().eq("id", businessId);
}

module.exports = { getBusinessesForUser, createBusiness };
