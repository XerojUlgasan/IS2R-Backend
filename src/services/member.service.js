const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");
const { assertOwner } = require("./membership.service");
const { recordLog } = require("./audit.service");

// UI permission key -> member_actions boolean column.
const PERMISSION_TO_COLUMN = {
  "material.create": "add_material",
  "material.update": "update_material",
  "material.delete": "delete_material",
  "stock.create": "add_stocks",
  "stock.update": "update_stocks",
  "stock.delete": "delete_stocks",
  "sale.create": "create_sales",
  "sale.update": "update_sales",
  "sale.delete": "delete_sales",
  "expense.create": "add_expense",
  "expense.update": "update_expense",
  "expense.delete": "delete_expense",
};

// member.* keys are accepted (the UI still sends them) but not stored or returned:
// managing members is owner-only, so there are no columns for them.
const IGNORED_PERMISSIONS = ["member.add", "member.configure", "member.delete"];

const STORABLE_PERMISSIONS = Object.keys(PERMISSION_TO_COLUMN);
const VALID_PERMISSIONS = [...STORABLE_PERMISSIONS, ...IGNORED_PERMISSIONS];
const INVITE_ROLES = ["Staff", "Shareholder"];

const MEMBER_COLUMNS = "id, userId, email, role, status, acceptedAt, created_at, cut_by_percentage";

// Normalizes a stored role to the UI's title-case form.
function normalizeRole(role) {
  switch ((role || "").toLowerCase()) {
    case "owner":
      return "Owner";
    case "staff":
      return "Staff";
    case "shareholder":
      return "Shareholder";
    default:
      return role || null;
  }
}

// Converts a member_actions row into the UI's permission-key array.
function actionsToPermissions(actions) {
  if (!actions) return [];
  return STORABLE_PERMISSIONS.filter((key) => actions[PERMISSION_TO_COLUMN[key]] === true);
}

// Converts a permission-key array into a full member_actions boolean object.
function permissionsToColumns(permissions) {
  const columns = {};
  for (const key of STORABLE_PERMISSIONS) {
    columns[PERMISSION_TO_COLUMN[key]] = permissions.includes(key);
  }
  return columns;
}

// Shapes a member row for the API, resolving name/email and permissions.
function buildMemberResponse(member, actions, user) {
  return {
    id: member.id,
    userId: member.userId,
    name: user && user.fullname ? user.fullname : member.userId,
    email: member.email || (user ? user.email : null),
    role: normalizeRole(member.role),
    status: member.status,
    acceptedAt: member.acceptedAt,
    permissions: actionsToPermissions(actions),
    cut_by_percentage: member.cut_by_percentage ?? null,
    avatar_url: null,
  };
}

// Confirms the caller may view members: accepted member, and not Staff.
async function assertCanViewMembers(userId, businessId) {
  const { data, error } = await supabase
    .from("business_members")
    .select("role")
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
  if ((data.role || "").toLowerCase() === "staff") {
    throw httpError(403, "Staff are not allowed to view members");
  }
}

// Loads a member that belongs to the given business; throws 404 otherwise.
async function getMemberInBusinessOrThrow(businessId, memberId) {
  const { data, error } = await supabase
    .from("business_members")
    .select(MEMBER_COLUMNS)
    .eq("id", memberId)
    .eq("businessId", businessId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw httpError(404, "Member not found in this business");
  }
  return data;
}

// Builds a Map of userId -> { fullname, email } for the given user ids.
async function getUsersByIds(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from("users")
    .select("userId, fullname, email")
    .in("userId", ids);

  if (error) {
    throw new Error(error.message);
  }
  return new Map((data || []).map((u) => [u.userId, u]));
}

// Loads the single member_actions row for a member.
async function getActionsForMember(memberId) {
  const { data, error } = await supabase
    .from("member_actions")
    .select("*")
    .eq("memberId", memberId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  return data;
}

// Returns all members of a business with their resolved identity and permissions.
async function listMembers(userId, businessId) {
  await assertCanViewMembers(userId, businessId);

  const { data: members, error } = await supabase
    .from("business_members")
    .select(MEMBER_COLUMNS)
    .eq("businessId", businessId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }
  if (!members || members.length === 0) {
    return [];
  }

  const { data: actionRows, error: actionsError } = await supabase
    .from("member_actions")
    .select("*")
    .eq("businessId", businessId);

  if (actionsError) {
    throw new Error(actionsError.message);
  }

  const actionsByMember = new Map((actionRows || []).map((a) => [a.memberId, a]));
  const users = await getUsersByIds(members.map((m) => m.userId));

  return members.map((m) =>
    buildMemberResponse(m, actionsByMember.get(m.id), users.get(m.userId))
  );
}

// Invites an existing user by email as a pending member with the given permissions.
async function inviteMember(userId, businessId, details) {
  await assertOwner(userId, businessId);

  // The invitee must already have an account.
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("userId, fullname, email")
    .eq("email", details.email)
    .maybeSingle();

  if (userError) {
    throw new Error(userError.message);
  }
  if (!user) {
    throw httpError(400, "No account exists for this email");
  }

  // Reject duplicates within the same business.
  const { data: existing, error: existingError } = await supabase
    .from("business_members")
    .select("id")
    .eq("businessId", businessId)
    .eq("userId", user.userId)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }
  if (existing) {
    throw httpError(409, "This user is already a member of the business");
  }

  const { data: member, error: memberError } = await supabase
    .from("business_members")
    .insert({
      userId: user.userId,
      businessId,
      email: details.email,
      role: details.role,
      status: "pending",
      invitedAt: new Date().toISOString(),
      acceptedAt: null,
    })
    .select(MEMBER_COLUMNS)
    .single();

  if (memberError) {
    throw new Error(memberError.message);
  }

  const { data: actions, error: actionsError } = await supabase
    .from("member_actions")
    .insert({
      memberId: member.id,
      businessId,
      ...permissionsToColumns(details.permissions),
    })
    .select("*")
    .single();

  if (actionsError) {
    await supabase.from("business_members").delete().eq("id", member.id);
    throw new Error(actionsError.message);
  }

  recordLog(businessId, userId, "INVITE_MEMBER", `Invited ${details.email} as ${details.role}`);
  return buildMemberResponse(member, actions, user);
}

// Replaces a member's permission set (owner only, staff target only).
async function updatePermissions(userId, businessId, memberId, permissions) {
  await assertOwner(userId, businessId);
  const member = await getMemberInBusinessOrThrow(businessId, memberId);

  if ((member.role || "").toLowerCase() !== "staff") {
    throw httpError(400, "Permissions can only be updated for Staff members");
  }

  const previousActions = await getActionsForMember(memberId);
  const previousPermissions = actionsToPermissions(previousActions);

  const { data: actions, error } = await supabase
    .from("member_actions")
    .update({ ...permissionsToColumns(permissions), updateAt: new Date().toISOString() })
    .eq("memberId", memberId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  recordLog(
    businessId,
    userId,
    "CONFIGURE_MEMBER",
    `Updated permissions for ${member.email || member.userId}`,
    { memberId: member.id, email: member.email || member.userId, permissions: previousPermissions },
    { memberId: member.id, email: member.email || member.userId, permissions }
  );

  const users = await getUsersByIds([member.userId]);
  return buildMemberResponse(member, actions, users.get(member.userId));
}

// Updates the cut_by_percentage for a shareholder member (owner only).
async function updateShareholderCut(userId, businessId, memberId, percentage) {
  await assertOwner(userId, businessId);
  const member = await getMemberInBusinessOrThrow(businessId, memberId);

  if (!(["shareholder", "owner"].includes((member.role || "").toLowerCase()))) {
    throw httpError(400, "cut_by_percentage can only be set for Shareholder or Owner members");
  }
  if (typeof percentage !== "number" || percentage < 0 || percentage > 100) {
    throw httpError(400, "percentage must be a number between 0 and 100");
  }

  // Sum existing cuts for all other accepted members (shareholders + owner), excluding this member.
  const { data: others, error: othersError } = await supabase
    .from("business_members")
    .select("cut_by_percentage")
    .eq("businessId", businessId)
    .eq("status", "accepted")
    .neq("id", memberId)
    .not("cut_by_percentage", "is", null);

  if (othersError) throw new Error(othersError.message);

  const usedPercentage = (others || []).reduce((sum, m) => sum + (m.cut_by_percentage || 0), 0);
  const remaining = 100 - usedPercentage;

  if (percentage > remaining) {
    throw httpError(
      400,
      `Only ${remaining.toFixed(2)}% is available; cannot assign ${percentage}%`
    );
  }

  const { error } = await supabase
    .from("business_members")
    .update({ cut_by_percentage: percentage })
    .eq("id", memberId);

  if (error) throw new Error(error.message);

  const users = await getUsersByIds([member.userId]);
  const actions = await getActionsForMember(memberId);
  return buildMemberResponse(
    { ...member, cut_by_percentage: percentage },
    actions,
    users.get(member.userId)
  );
}

// Permanently removes a member (owner only). The owner cannot be removed.
async function removeMember(userId, businessId, memberId) {
  await assertOwner(userId, businessId);
  const member = await getMemberInBusinessOrThrow(businessId, memberId);

  if (normalizeRole(member.role) === "Owner") {
    throw httpError(400, "The business owner cannot be removed");
  }

  const previousActions = await getActionsForMember(memberId);
  const previousPermissions = actionsToPermissions(previousActions);

  // member_actions first: its FK to business_members has no cascade.
  const { error: actionsError } = await supabase
    .from("member_actions")
    .delete()
    .eq("memberId", memberId);

  if (actionsError) {
    throw new Error(actionsError.message);
  }

  const { error: memberError } = await supabase
    .from("business_members")
    .delete()
    .eq("id", memberId);

  if (memberError) {
    throw new Error(memberError.message);
  }

  recordLog(
    businessId,
    userId,
    "REMOVE_MEMBER",
    `Removed member ${member.email || member.userId}`,
    { memberId: member.id, email: member.email || member.userId, role: normalizeRole(member.role), permissions: previousPermissions },
    null
  );
}

module.exports = {
  VALID_PERMISSIONS,
  INVITE_ROLES,
  normalizeRole,
  listMembers,
  inviteMember,
  updatePermissions,
  removeMember,
  updateShareholderCut,
};
