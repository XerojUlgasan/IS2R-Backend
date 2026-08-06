const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");
const { assertMembership } = require("./membership.service");

const VALID_TYPES = ["PCS", "SIZE"];

// Loads a non-deleted material by id; throws 404 if it doesn't exist.
async function getMaterialOrThrow(materialId) {
  const { data, error } = await supabase
    .from("materials")
    .select("id, name, type, unit, businessId, created_at")
    .eq("id", materialId)
    .is("deletedAt", null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw httpError(404, "Material not found");
  }
  return data;
}

// Fetches non-deleted stock rows for a set of material ids.
async function getStocksForMaterials(materialIds) {
  if (materialIds.length === 0) {
    return [];
  }
  const { data, error } = await supabase
    .from("stocks")
    .select("materialId, quantity, quantity_sold, mfg_price, created_at")
    .in("materialId", materialIds)
    .is("deletedAt", null);

  if (error) {
    throw new Error(error.message);
  }
  return data || [];
}

// Builds the API-facing material object by deriving stock-based fields.
// Available quantity is total stocked minus what sales have consumed.
function buildMaterialResponse(material, stockRows) {
  const quantity = stockRows.reduce(
    (sum, row) => sum + (row.quantity - (row.quantity_sold || 0)),
    0
  );

  const latest = stockRows
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  return {
    id: material.id,
    name: material.name,
    type: material.type,
    unit: material.unit,
    quantity,
    mfg_price: latest ? latest.mfg_price : null,
    status: quantity > 0 ? "AVAILABLE" : "CONSUMED",
    last_stocked_at: latest ? latest.created_at : null,
  };
}

// Returns every non-deleted material for a business with derived stock fields.
async function listMaterials(userId, businessId) {
  await assertMembership(userId, businessId);

  const { data: materials, error } = await supabase
    .from("materials")
    .select("id, name, type, unit, businessId, created_at")
    .eq("businessId", businessId)
    .is("deletedAt", null);

  if (error) {
    throw new Error(error.message);
  }
  if (!materials || materials.length === 0) {
    return [];
  }

  const stocks = await getStocksForMaterials(materials.map((m) => m.id));
  const stocksByMaterial = new Map();
  for (const row of stocks) {
    const list = stocksByMaterial.get(row.materialId) || [];
    list.push(row);
    stocksByMaterial.set(row.materialId, list);
  }

  return materials.map((material) =>
    buildMaterialResponse(material, stocksByMaterial.get(material.id) || [])
  );
}

// Creates a new material in a business. New materials start with no stock.
async function createMaterial(userId, businessId, details) {
  await assertMembership(userId, businessId);

  const { data, error } = await supabase
    .from("materials")
    .insert({
      name: details.name,
      type: details.type,
      unit: details.unit || null,
      businessId,
    })
    .select("id, name, type, unit, businessId, created_at")
    .single();

  if (error) {
    throw new Error(error.message);
  }
  return buildMaterialResponse(data, []);
}

// Updates a material's editable fields (name/type/unit). Never touches stock.
async function updateMaterial(userId, materialId, updates) {
  const material = await getMaterialOrThrow(materialId);
  await assertMembership(userId, material.businessId);

  const { error } = await supabase
    .from("materials")
    .update({
      name: updates.name,
      type: updates.type,
      unit: updates.unit,
    })
    .eq("id", materialId);

  if (error) {
    throw new Error(error.message);
  }

  const stocks = await getStocksForMaterials([materialId]);
  return buildMaterialResponse({ ...material, ...updates }, stocks);
}

// Soft-deletes a material by stamping deletedAt.
async function deleteMaterial(userId, materialId) {
  const material = await getMaterialOrThrow(materialId);
  await assertMembership(userId, material.businessId);

  const { error } = await supabase
    .from("materials")
    .update({ deletedAt: new Date().toISOString() })
    .eq("id", materialId);

  if (error) {
    throw new Error(error.message);
  }
}

// Adds a new stock entry for a material and returns the updated material.
async function addStock(userId, materialId, details) {
  const material = await getMaterialOrThrow(materialId);
  await assertMembership(userId, material.businessId);

  const { error } = await supabase.from("stocks").insert({
    materialId,
    businessId: material.businessId,
    quantity: details.quantity,
    mfg_price: details.mfg_price,
    status: "available",
  });

  if (error) {
    throw new Error(error.message);
  }

  const stocks = await getStocksForMaterials([materialId]);
  return buildMaterialResponse(material, stocks);
}

// Typeahead search: case-insensitive partial match on material name.
async function searchMaterials(userId, businessId, query) {
  await assertMembership(userId, businessId);

  const term = (query || "").trim();
  if (term === "") {
    return [];
  }

  const { data, error } = await supabase
    .from("materials")
    .select("id, name, type, unit")
    .eq("businessId", businessId)
    .is("deletedAt", null)
    .ilike("name", `%${term}%`)
    .order("name", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(error.message);
  }
  return data || [];
}

// Returns a Map of materialId -> name (includes soft-deleted so sales history stays readable).
async function getMaterialNamesByIds(materialIds) {
  if (materialIds.length === 0) {
    return new Map();
  }
  const { data, error } = await supabase
    .from("materials")
    .select("id, name")
    .in("id", materialIds);

  if (error) {
    throw new Error(error.message);
  }
  return new Map((data || []).map((m) => [m.id, m.name]));
}

module.exports = {
  VALID_TYPES,
  listMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  addStock,
  searchMaterials,
  getMaterialOrThrow,
  getMaterialNamesByIds,
};
