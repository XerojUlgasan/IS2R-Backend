const memberService = require("../services/member.service");

// Maps a thrown error to the right HTTP response.
function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// Basic email shape check (server is the source of truth).
function isEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// Validates a permissions array against the known keys; returns an error message or null.
function validatePermissions(permissions) {
  if (!Array.isArray(permissions)) {
    return "permissions must be an array";
  }
  const unknown = permissions.filter((p) => !memberService.VALID_PERMISSIONS.includes(p));
  if (unknown.length > 0) {
    return `Unknown permission keys: ${unknown.join(", ")}`;
  }
  return null;
}

// Resolves the invite role case-insensitively to Staff/Shareholder, or null if invalid.
function resolveInviteRole(role) {
  if (typeof role !== "string") return null;
  return memberService.INVITE_ROLES.find((r) => r.toLowerCase() === role.toLowerCase()) || null;
}

// GET /api/businesses/:businessId/members — list members.
async function listMembers(req, res) {
  try {
    const members = await memberService.listMembers(req.user.id, req.params.businessId);
    return res.status(200).json({ members });
  } catch (err) {
    return sendError(res, err, "listMembers");
  }
}

// POST /api/businesses/:businessId/members/invite — invite an existing user.
async function inviteMember(req, res) {
  const { email, role, permissions } = req.body || {};

  if (!isEmail(email)) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  const resolvedRole = resolveInviteRole(role);
  if (!resolvedRole) {
    return res.status(400).json({ error: "role must be Staff or Shareholder" });
  }
  const perms = permissions === undefined ? [] : permissions;
  const permError = validatePermissions(perms);
  if (permError) {
    return res.status(400).json({ error: permError });
  }

  try {
    const member = await memberService.inviteMember(req.user.id, req.params.businessId, {
      email: email.trim(),
      role: resolvedRole,
      permissions: perms,
    });
    return res.status(201).json({ member });
  } catch (err) {
    return sendError(res, err, "inviteMember");
  }
}

// PATCH /api/businesses/:businessId/members/:memberId/permissions — replace permissions.
async function updatePermissions(req, res) {
  const { permissions } = req.body || {};

  const permError = validatePermissions(permissions);
  if (permError) {
    return res.status(400).json({ error: permError });
  }

  try {
    const member = await memberService.updatePermissions(
      req.user.id,
      req.params.businessId,
      req.params.memberId,
      permissions
    );
    return res.status(200).json({ member });
  } catch (err) {
    return sendError(res, err, "updatePermissions");
  }
}

// DELETE /api/businesses/:businessId/members/:memberId — remove a member.
async function removeMember(req, res) {
  try {
    await memberService.removeMember(req.user.id, req.params.businessId, req.params.memberId);
    return res.status(204).send();
  } catch (err) {
    return sendError(res, err, "removeMember");
  }
}

module.exports = { listMembers, inviteMember, updatePermissions, removeMember };
