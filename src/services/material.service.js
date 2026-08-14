const { supabase } = require("../lib/supabaseClient");
const { httpError } = require("../lib/httpError");
const {
  assertMembership,
  assertAction,
  ACTIONS,
} = require("./membership.service");
const { recordLog } = require("./audit.service");

// Loads a non-deleted material by id; throws 404 if it doesn't exist.
async function getMaterialOrThrow(materialId) {
  const { data, error } = await supabase
    .from("materials")
    .select("id, name, businessId, created_at")
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
    0,
  );

  const latest = stockRows
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  return {
    id: material.id,
    name: material.name,
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
    .select("id, name, businessId, created_at")
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
    buildMaterialResponse(material, stocksByMaterial.get(material.id) || []),
  );
}

// Creates a new material in a business. New materials start with no stock.
async function createMaterial(userId, businessId, details) {
  await assertAction(userId, businessId, ACTIONS.ADD_MATERIAL);

  const { data, error } = await supabase
    .from("materials")
    .insert({
      name: details.name,
      businessId,
    })
    .select("id, name, businessId, created_at")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  recordLog(
    businessId,
    userId,
    "ADD_MATERIAL",
    `Added material "${data.name}"`,
  );
  return buildMaterialResponse(data, []);
}

// Updates a material's editable fields (name only). Never touches stock.
async function updateMaterial(userId, materialId, updates) {
  const material = await getMaterialOrThrow(materialId);
  await assertAction(userId, material.businessId, ACTIONS.UPDATE_MATERIAL);

  const { error } = await supabase
    .from("materials")
    .update({ name: updates.name })
    .eq("id", materialId);

  if (error) {
    throw new Error(error.message);
  }

  const merged = { ...material, ...updates };
  recordLog(
    material.businessId,
    userId,
    "EDIT_MATERIAL",
    `Renamed material to "${updates.name}" (was "${material.name}")`,
    { id: material.id, name: material.name },
    { id: material.id, name: updates.name }
  );

  const stocks = await getStocksForMaterials([materialId]);
  return buildMaterialResponse(merged, stocks);
}

// Soft-deletes a material by stamping deletedAt.
async function deleteMaterial(userId, materialId) {
  const material = await getMaterialOrThrow(materialId);
  await assertAction(userId, material.businessId, ACTIONS.DELETE_MATERIAL);

  const { error } = await supabase
    .from("materials")
    .update({ deletedAt: new Date().toISOString() })
    .eq("id", materialId);

  if (error) {
    throw new Error(error.message);
  }

  recordLog(
    material.businessId,
    userId,
    "DELETE_MATERIAL",
    `Removed material "${material.name}" from inventory`,
    { id: material.id, name: material.name },
    null
  );
}

// Adds a new stock entry for a material and returns the updated material.
async function addStock(userId, materialId, details) {
  const material = await getMaterialOrThrow(materialId);
  await assertAction(userId, material.businessId, ACTIONS.ADD_STOCKS);

  const { data: stockData, error } = await supabase
    .from("stocks")
    .insert({
      materialId,
      businessId: material.businessId,
      quantity: details.quantity,
      mfg_price: details.mfg_price,
      status: "available",
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  // Automatically record the stock purchase as a MATERIALS expense.
  // amount is stored as 0 here; the real cost is always derived at read time
  // from the linked stock's mfg_price (quantity × mfg_price).
  const { error: expenseError } = await supabase.from("expenses").insert({
    title: `Stock: ${material.name}`,
    category: "MATERIALS",
    amount: 0,
    remarks: `Added ₱${details.mfg_price} from "${material.name}"`,
    created_by: userId,
    businessId: material.businessId,
    stock_id: stockData.id,
  });

  if (expenseError) {
    throw new Error(expenseError.message);
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
    .select("id, name")
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
  listMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  addStock,
  searchMaterials,
  getMaterialOrThrow,
  getMaterialNamesByIds,
};
