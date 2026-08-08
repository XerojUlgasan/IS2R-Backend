const businessService = require("../services/business.service");

// GET /api/businesses — returns the authenticated user's businesses.
async function listBusinesses(req, res) {
  const userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const businesses = await businessService.getBusinessesForUser(userId);
    return res.status(200).json({ businesses });
  } catch (err) {
    console.error("[listBusinesses] failed:", err);
    return res.status(500).json({ error: "Failed to load businesses" });
  }
}

// POST /api/businesses — creates a new business owned by the authenticated user.
async function createBusiness(req, res) {
  const userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { name, description, contact_number, address } = req.body || {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required and must be a non-empty string" });
  }

  try {
    const business = await businessService.createBusiness(userId, {
      name: name.trim(),
      description,
      contact_number,
      address,
    });
    return res.status(201).json({ business });
  } catch (err) {
    console.error("[createBusiness] failed:", err);
    return res.status(500).json({ error: "Failed to create business" });
  }
}

// POST /api/businesses/:businessId/accept — the authenticated user accepts a
// pending invite to the business; their granted actions are synced to app_metadata.
async function acceptInvite(req, res) {
  const userId = req.user && req.user.id;
  if (!userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const membership = await businessService.acceptInvite(userId, req.params.businessId);
    return res.status(200).json({ membership });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("[acceptInvite] failed:", err);
    return res.status(500).json({ error: "Failed to accept invitation" });
  }
}

// Maps a thrown error to the right HTTP response.
function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// The optional, nullable settings fields.
const NULLABLE_SETTINGS = ["description", "contact_number", "address", "logo_img_loc"];

// GET /api/businesses/:businessId/settings — read settings (owner only).
async function getSettings(req, res) {
  try {
    const settings = await businessService.getSettings(req.user.id, req.params.businessId);
    return res.status(200).json({ settings });
  } catch (err) {
    return sendError(res, err, "getSettings");
  }
}

// PATCH /api/businesses/:businessId/settings — update settings (owner only).
async function updateSettings(req, res) {
  const body = req.body || {};
  const updates = {};

  // name, when present, must be a non-empty string.
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return res.status(400).json({ error: "name must be a non-empty string" });
    }
    updates.name = body.name.trim();
  }

  // The rest are optional strings and may be explicitly null to clear them.
  for (const field of NULLABLE_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      const value = body[field];
      if (value !== null && typeof value !== "string") {
        return res.status(400).json({ error: `${field} must be a string or null` });
      }
      updates[field] = value === "" ? null : value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No settings fields provided" });
  }

  try {
    const settings = await businessService.updateSettings(
      req.user.id,
      req.params.businessId,
      updates
    );
    return res.status(200).json({ settings });
  } catch (err) {
    return sendError(res, err, "updateSettings");
  }
}

// POST /api/businesses/:businessId/settings/logo — upload a logo (owner only).
async function uploadLogo(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "logo file is required" });
  }

  try {
    const logo_img_loc = await businessService.uploadLogo(
      req.user.id,
      req.params.businessId,
      req.file
    );
    return res.status(200).json({ logo_img_loc });
  } catch (err) {
    return sendError(res, err, "uploadLogo");
  }
}

module.exports = {
  listBusinesses,
  createBusiness,
  acceptInvite,
  getSettings,
  updateSettings,
  uploadLogo,
};
