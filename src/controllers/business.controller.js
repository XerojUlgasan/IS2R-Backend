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

module.exports = { listBusinesses, createBusiness };
