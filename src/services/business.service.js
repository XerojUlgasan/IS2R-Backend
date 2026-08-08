const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");
const { recordLog } = require("./audit.service");
const { assertOwner } = require("./membership.service");

// Supabase Storage bucket that holds business logos (public).
const LOGO_BUCKET = process.env.SUPABASE_LOGO_BUCKET || "business-logos";
// Accepted logo mime types and the max upload size (2MB).
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

// Returns every business the given user is an accepted member of,
// merged with that business's settings and the user's role.
async function getBusinessesForUser(userId) {
  // 1. Find the user's memberships.
  const { data: memberships, error: membershipError } = await supabase
    .from("business_members")
    .select("id, businessId, role, acceptedAt, created_at, status")
    .eq("userId", userId)

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

  // 3. Load the granted actions for each of the user's memberships.
  const memberIds = memberships.map((member) => member.id);
  const { data: actionRows, error: actionsError } = await supabase
    .from("member_actions")
    .select("*")
    .in("memberId", memberIds);

  if (actionsError) {
    console.error("[getBusinessesForUser] actions query error:", actionsError);
    throw new Error(actionsError.message);
  }

  const actionsByMemberId = new Map(
    (actionRows || []).map((row) => [row.memberId, row])
  );

  // 4. Shape the response the API contract expects.
  return memberships.map((member) => {
    const setting = settingsByBusinessId.get(member.businessId);
    return {
      id: member.businessId,
      name: setting ? setting.name : null,
      logo_img_loc: setting ? setting.logo_img_loc : null,
      role: member.role,
      joinedAt: member.acceptedAt || member.created_at,
      status: member.status,
      actions: allowedActionsFrom(actionsByMemberId.get(member.id)),
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

// The member_actions boolean columns that represent grantable permissions.
const ACTION_COLUMNS = [
  "add_material",
  "update_material",
  "delete_material",
  "add_stocks",
  "update_stocks",
  "delete_stocks",
  "create_sales",
  "update_sales",
  "delete_sales",
  "add_expense",
  "update_expense",
  "delete_expense",
];

// Reduces a member_actions row to the list of columns set to true.
function allowedActionsFrom(actions) {
  if (!actions) return [];
  return ACTION_COLUMNS.filter((column) => actions[column] === true);
}

// Merges this business's granted actions into the user's app_metadata, keyed by
// businessId so memberships in different businesses never overwrite each other.
// Uses the Supabase admin API (service key) to read then write the user.
async function syncActionsToAppMetadata(userId, businessId, role, allowedActions) {
  const { data: userData, error: getError } = await supabase.auth.admin.getUserById(userId);
  if (getError || !userData || !userData.user) {
    throw new Error(getError ? getError.message : "Auth user not found");
  }

  const existingMetadata = userData.user.app_metadata || {};
  const existingBusinesses = existingMetadata.businesses || {};

  const nextMetadata = {
    ...existingMetadata,
    businesses: {
      ...existingBusinesses,
      [businessId]: { role, actions: allowedActions },
    },
  };

  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: nextMetadata,
  });
  if (updateError) {
    throw new Error(updateError.message);
  }
}

// Accepts a pending invite for the authenticated user on the target business.
// 1. Confirms the user has a pending membership on that business.
// 2. Flips the membership to accepted.
async function acceptInvite(userId, businessId) {
  // 1. The caller must have a pending membership for this business.
  const { data: member, error: memberError } = await supabase
    .from("business_members")
    .select("id, role, status")
    .eq("userId", userId)
    .eq("businessId", businessId)
    .maybeSingle();

  if (memberError) {
    throw new Error(memberError.message);
  }
  if (!member) {
    throw httpError(404, "You have no invitation for this business");
  }
  if (member.status !== "pending") {
    throw httpError(409, "This invitation is not pending");
  }

  // 2. Flip the membership to accepted.
  const { error: updateError } = await supabase
    .from("business_members")
    .update({ status: "accepted", acceptedAt: new Date().toISOString() })
    .eq("id", member.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  recordLog(businessId, userId, "ACCEPT_INVITE", `Accepted invitation as ${member.role}`);

  return {
    businessId,
    role: member.role,
    status: "accepted",
    actions: allowedActions,
  };
}

// The client-facing settings fields (businessid/created_at are never exposed).
const SETTINGS_FIELDS = ["name", "description", "contact_number", "address", "logo_img_loc"];

// Shapes a business_settings row (or defaults) into the API's Settings object.
function buildSettingsResponse(row) {
  return {
    name: row ? row.name : null,
    description: row ? row.description : null,
    contact_number: row ? row.contact_number : null,
    address: row ? row.address : null,
    logo_img_loc: row ? row.logo_img_loc : null,
  };
}

// Returns a business's settings. Owner only. If no row exists yet, returns a
// populated default object rather than 404.
async function getSettings(userId, businessId) {
  await assertOwner(userId, businessId);

  const { data, error } = await supabase
    .from("business_settings")
    .select("name, description, contact_number, address, logo_img_loc")
    .eq("businessid", businessId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return buildSettingsResponse(data);
}

// Upserts a business's settings. Owner only. Only provided keys are written;
// missing keys are left unchanged.
async function updateSettings(userId, businessId, updates) {
  await assertOwner(userId, businessId);

  // Build the patch from the recognized fields that were actually provided.
  const patch = { businessid: businessId };
  for (const field of SETTINGS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      patch[field] = updates[field];
    }
  }

  const { data, error } = await supabase
    .from("business_settings")
    .upsert(patch, { onConflict: "businessid" })
    .select("name, description, contact_number, address, logo_img_loc")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  recordLog(businessId, userId, "UPDATE_SETTINGS", "Updated business settings");
  return buildSettingsResponse(data);
}

// Ensures the logo storage bucket exists (public). Ignores "already exists".
async function ensureLogoBucket() {
  const { data, error } = await supabase.storage.getBucket(LOGO_BUCKET);
  if (data && !error) {
    return;
  }
  const { error: createError } = await supabase.storage.createBucket(LOGO_BUCKET, {
    public: true,
    fileSizeLimit: LOGO_MAX_BYTES,
  });
  // A concurrent request may have created it first — that's fine.
  if (createError && !/exist/i.test(createError.message || "")) {
    throw new Error(createError.message);
  }
}

// Uploads a business logo to storage and persists its public URL on the
// settings row. Owner only. Returns the public URL.
async function uploadLogo(userId, businessId, file) {
  await assertOwner(userId, businessId);

  const ext = LOGO_MIME_EXT[file.mimetype];
  if (!ext) {
    throw httpError(400, "Logo must be an image (png, jpg, webp, gif, or svg)");
  }
  if (file.size > LOGO_MAX_BYTES) {
    throw httpError(400, "Logo must be 2MB or smaller");
  }

  await ensureLogoBucket();

  const objectPath = `businesses/${businessId}/logo.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const { data: publicData } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(objectPath);
  // Cache-bust so an overwritten logo refreshes in the browser.
  const logoUrl = `${publicData.publicUrl}?v=${Date.now()}`;

  // Persist immediately so the logo survives even without a follow-up PATCH.
  const { error: settingsError } = await supabase
    .from("business_settings")
    .upsert({ businessid: businessId, logo_img_loc: logoUrl }, { onConflict: "businessid" });

  if (settingsError) {
    throw new Error(settingsError.message);
  }

  recordLog(businessId, userId, "UPDATE_SETTINGS", "Updated business logo");
  return logoUrl;
}

module.exports = {
  getBusinessesForUser,
  createBusiness,
  acceptInvite,
  getSettings,
  updateSettings,
  uploadLogo,
  LOGO_MAX_BYTES,
  LOGO_MIME_EXT,
};
