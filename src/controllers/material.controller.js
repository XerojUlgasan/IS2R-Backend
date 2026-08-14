const materialService = require("../services/material.service");

// Maps a thrown error to the right HTTP response.
function sendError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${label}] failed:`, err);
  return res.status(500).json({ error: "Something went wrong" });
}

// GET /api/businesses/:businessId/materials — list a business's materials.
async function listMaterials(req, res) {
  try {
    const materials = await materialService.listMaterials(
      req.user.id,
      req.params.businessId
    );
    return res.status(200).json({ materials });
  } catch (err) {
    return sendError(res, err, "listMaterials");
  }
}

// POST /api/businesses/:businessId/materials — create a material.
async function createMaterial(req, res) {
  const { name } = req.body || {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required and must be a non-empty string" });
  }

  try {
    const material = await materialService.createMaterial(
      req.user.id,
      req.params.businessId,
      { name: name.trim() }
    );
    return res.status(201).json({ material });
  } catch (err) {
    return sendError(res, err, "createMaterial");
  }
}

// PATCH /api/materials/:materialId — update editable fields.
async function updateMaterial(req, res) {
  const { name } = req.body || {};

  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    return res.status(400).json({ error: "name must be a non-empty string" });
  }

  if (name === undefined) {
    return res.status(400).json({ error: "No editable fields provided" });
  }

  try {
    const material = await materialService.updateMaterial(
      req.user.id,
      req.params.materialId,
      { name: name.trim() }
    );
    return res.status(200).json({ material });
  } catch (err) {
    return sendError(res, err, "updateMaterial");
  }
}

// DELETE /api/materials/:materialId — soft-delete a material.
async function deleteMaterial(req, res) {
  try {
    await materialService.deleteMaterial(req.user.id, req.params.materialId);
    return res.status(204).send();
  } catch (err) {
    return sendError(res, err, "deleteMaterial");
  }
}

// POST /api/materials/:materialId/stock — add a stock entry.
async function addStock(req, res) {
  const { quantity, mfg_price } = req.body || {};

  if (typeof quantity !== "number" || Number.isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "quantity is required and must be a number greater than 0" });
  }
  if (typeof mfg_price !== "number" || Number.isNaN(mfg_price)) {
    return res.status(400).json({ error: "mfg_price is required and must be a number" });
  }

  try {
    const material = await materialService.addStock(
      req.user.id,
      req.params.materialId,
      { quantity, mfg_price }
    );
    return res.status(200).json({ material });
  } catch (err) {
    return sendError(res, err, "addStock");
  }
}

// GET /api/businesses/:businessId/materials/search?q= — typeahead search.
async function searchMaterials(req, res) {
  try {
    const materials = await materialService.searchMaterials(
      req.user.id,
      req.params.businessId,
      req.query.q
    );
    return res.status(200).json({ materials });
  } catch (err) {
    return sendError(res, err, "searchMaterials");
  }
}

module.exports = {
  listMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  addStock,
  searchMaterials,
};
