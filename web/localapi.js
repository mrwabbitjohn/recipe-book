// The app's "backend", running entirely on the phone. It answers the same routes the old
// server did, so the UI code just calls api("/api/...") and doesn't care where data lives.
import * as db from "./store.js";

const newId = () => crypto.randomUUID();

export const normalizeName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---------- images ----------
// Photos are stored as blobs and referenced from recipes as "img:<id>".
// The UI only ever sees object URLs, so we keep a two-way map.
const urlByRef = new Map();
const refByUrl = new Map();

async function displayUrl(ref) {
  if (!ref || !ref.startsWith("img:")) return ref || null;
  if (urlByRef.has(ref)) return urlByRef.get(ref);
  const row = await db.get("images", ref.slice(4));
  if (!row) return null;
  const url = URL.createObjectURL(row.blob);
  urlByRef.set(ref, url);
  refByUrl.set(url, ref);
  return url;
}
const storedRef = (url) => (url && refByUrl.get(url)) || url || null;

async function saveImageBlob(blob) {
  const id = newId();
  await db.put("images", { id, blob });
  return `img:${id}`;
}

async function deleteImage(ref) {
  if (!ref?.startsWith("img:")) return;
  await db.del("images", ref.slice(4));
  const url = urlByRef.get(ref);
  if (url) {
    URL.revokeObjectURL(url);
    urlByRef.delete(ref);
    refByUrl.delete(url);
  }
}

// ---------- recipes ----------
const ingredientStores = () => db.getMeta("ingredientStores", {});
const storeFor = (map, name) => map[normalizeName(name)] || "";

function cleanRecipe(input, existing = {}) {
  const num = (v) => (v === null || v === "" || v === undefined || isNaN(Number(v)) ? null : Number(v));
  return {
    id: existing.id || newId(),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: String(input.title || "Untitled recipe").trim(),
    description: String(input.description || ""),
    image: input.image || null,
    source: input.source || null,
    servings: num(input.servings),
    prepMinutes: num(input.prepMinutes),
    cookMinutes: num(input.cookMinutes),
    totalMinutes: num(input.totalMinutes),
    tags: (input.tags || []).map(String).filter(Boolean),
    favorite: Boolean(input.favorite ?? existing.favorite),
    notes: String(input.notes || ""),
    ingredients: (input.ingredients || [])
      .filter((i) => i && String(i.name || "").trim())
      .map((i) => ({
        id: i.id || newId(),
        section: String(i.section || ""),
        quantity: num(i.quantity),
        unit: String(i.unit || ""),
        name: String(i.name).trim(),
        note: String(i.note || ""),
        aisle: String(i.aisle || "Other"),
        estimated: Boolean(i.estimated) && i.quantity != null, // amount guessed by the AI, shown with ≈
      })),
    steps: (input.steps || [])
      .filter((s) => s && String(s.text || "").trim())
      .map((s) => ({ text: String(s.text).trim(), timerMinutes: num(s.timerMinutes) })),
  };
}

export async function withStores(recipe) {
  const map = await ingredientStores();
  return { ...recipe, ingredients: recipe.ingredients.map((i) => ({ ...i, store: storeFor(map, i.name) })) };
}

// ---------- routes ----------
class HttpError extends Error {}

const routes = [
  ["GET", /^\/api\/status$/, async () => ({ aiEnabled: Boolean(await db.getMeta("apiKey", "")) })],

  ["GET", /^\/api\/recipes$/, async () => {
    const list = await db.getAll("recipes");
    const out = await Promise.all(list.map(async ({ ingredients, steps, notes, ...r }) => ({
      ...r,
      image: await displayUrl(r.image),
      ingredientCount: ingredients.length,
      ingredientNames: ingredients.map((i) => i.name),
    })));
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }],

  ["GET", /^\/api\/recipes\/([\w-]+)$/, async (_, id) => {
    const recipe = await db.get("recipes", id);
    if (!recipe) throw new HttpError("Recipe not found");
    return withStores({ ...recipe, image: await displayUrl(recipe.image) });
  }],

  ["POST", /^\/api\/recipes$/, async (body) => {
    const recipe = cleanRecipe({ ...body, image: storedRef(body.image) });
    await db.put("recipes", recipe);
    return recipe;
  }],

  ["PUT", /^\/api\/recipes\/([\w-]+)$/, async (body, id) => {
    const existing = await db.get("recipes", id);
    if (!existing) throw new HttpError("Recipe not found");
    const image = "image" in body ? storedRef(body.image) : existing.image;
    if (existing.image !== image) await deleteImage(existing.image);
    const recipe = cleanRecipe({ ...existing, ...body, image }, existing);
    await db.put("recipes", recipe);
    return recipe;
  }],

  ["DELETE", /^\/api\/recipes\/([\w-]+)$/, async (_, id) => {
    const existing = await db.get("recipes", id);
    if (existing) await deleteImage(existing.image);
    await db.del("recipes", id);
    return null;
  }],

  // Takes { blob } and returns a displayable URL the editor can put in recipe.image.
  ["POST", /^\/api\/images$/, async (body) => {
    const ref = await saveImageBlob(body.blob);
    return { url: await displayUrl(ref) };
  }],

  ["GET", /^\/api\/stores$/, async () => ({
    stores: await db.getMeta("stores", ["Supermarket"]),
    ingredientStores: await ingredientStores(),
  })],

  ["PUT", /^\/api\/stores$/, async (body) => {
    const stores = [...new Set((body.stores || []).map((s) => String(s).trim()).filter(Boolean))];
    await db.setMeta("stores", stores);
    return { stores };
  }],

  // Remember where to buy an ingredient; also re-file it on the current shopping list.
  ["PUT", /^\/api\/ingredient-store$/, async (body) => {
    const key = normalizeName(body.name);
    const store = String(body.store || "").trim();
    if (!key) throw new HttpError("Missing ingredient name");
    const map = await ingredientStores();
    if (store) {
      map[key] = store;
      const stores = await db.getMeta("stores", ["Supermarket"]);
      if (!stores.includes(store)) await db.setMeta("stores", [...stores, store]);
    } else {
      delete map[key];
    }
    await db.setMeta("ingredientStores", map);
    const items = (await db.getAll("shopping")).filter((i) => normalizeName(i.name) === key && !i.checked);
    await db.putMany("shopping", items.map((i) => ({ ...i, store })));
    return { name: key, store };
  }],

  ["GET", /^\/api\/shopping$/, () => db.getAll("shopping").then((l) => l.sort((a, b) => a.addedAt.localeCompare(b.addedAt)))],

  ["POST", /^\/api\/shopping$/, async (body) => {
    const shopping = await db.getAll("shopping");
    const map = await ingredientStores();
    const changed = new Map();
    for (const i of (body.items || []).filter((x) => String(x.name || "").trim())) {
      const name = String(i.name).trim();
      const unit = String(i.unit || "");
      const quantity = i.quantity == null || i.quantity === "" ? null : Number(i.quantity);
      // Merge with an unchecked item of the same ingredient + unit so quantities add up.
      const match = shopping.find((x) => !x.checked && normalizeName(x.name) === normalizeName(name) && x.unit === unit);
      if (match) {
        if (match.quantity != null && quantity != null) match.quantity = Math.round((match.quantity + quantity) * 100) / 100;
        if (i.recipeTitle && !match.recipes.includes(i.recipeTitle)) match.recipes.push(i.recipeTitle);
        changed.set(match.id, match);
        continue;
      }
      const item = {
        id: newId(), name, quantity, unit,
        aisle: i.aisle || "Other",
        store: i.store ?? storeFor(map, name),
        recipes: i.recipeTitle ? [i.recipeTitle] : [],
        checked: false,
        addedAt: new Date().toISOString(),
      };
      shopping.push(item);
      changed.set(item.id, item);
    }
    await db.putMany("shopping", [...changed.values()]);
    return [...changed.values()];
  }],

  ["PATCH", /^\/api\/shopping\/([\w-]+)$/, async (body, id) => {
    const it = await db.get("shopping", id);
    if (!it) throw new HttpError("Item not found");
    for (const k of ["checked", "name", "quantity", "unit", "store"]) if (k in body) it[k] = body[k];
    await db.put("shopping", it);
    return it;
  }],

  ["DELETE", /^\/api\/shopping\/([\w-]+)$/, async (_, id) => {
    await db.del("shopping", id);
    return null;
  }],

  ["POST", /^\/api\/shopping\/clear$/, async (body) => {
    if (body.all === true) await db.clear("shopping");
    else for (const it of await db.getAll("shopping")) if (it.checked) await db.del("shopping", it.id);
    return db.getAll("shopping");
  }],
];

export async function api(path, { method = "GET", body = {} } = {}) {
  for (const [m, re, handler] of routes) {
    const match = m === method && path.match(re);
    if (match) return handler(body, ...match.slice(1));
  }
  throw new Error(`Unknown route ${method} ${path}`);
}

// ---------- backup ----------
const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function exportBackup() {
  const images = await db.getAll("images");
  const data = {
    app: "recipe-book",
    version: 1,
    exportedAt: new Date().toISOString(),
    recipes: await db.getAll("recipes"),
    shopping: await db.getAll("shopping"),
    stores: await db.getMeta("stores", ["Supermarket"]),
    ingredientStores: await ingredientStores(),
    images: await Promise.all(images.map(async ({ id, blob }) => ({ id, type: blob.type, data: await blobToBase64(blob) }))),
  };
  return new Blob([JSON.stringify(data)], { type: "application/json" });
}

// Merges a backup into what's on the phone (same recipe = backup wins). Never deletes anything.
export async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't a Recipe Book backup.");
  }
  if (data.app !== "recipe-book") throw new Error("That file isn't a Recipe Book backup.");
  const images = (data.images || []).map(({ id, type, data: b64 }) => ({
    id,
    blob: new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type }),
  }));
  await db.putMany("images", images);
  await db.putMany("recipes", data.recipes || []);
  await db.putMany("shopping", data.shopping || []);
  const stores = await db.getMeta("stores", ["Supermarket"]);
  await db.setMeta("stores", [...new Set([...stores, ...(data.stores || [])])]);
  await db.setMeta("ingredientStores", { ...(await ingredientStores()), ...(data.ingredientStores || {}) });
  return { recipes: (data.recipes || []).length };
}
