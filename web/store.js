// IndexedDB storage. Everything the app knows lives on this device.
const DB_NAME = "recipe-book";
const DB_VERSION = 1;
export const STORES = ["recipes", "shopping", "images", "meta"];

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["recipes", "shopping", "images"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const getAll = async (name) => done((await store(name)).getAll());
export const get = async (name, key) => done((await store(name)).get(key));
export const put = async (name, value) => done((await store(name, "readwrite")).put(value));
export const del = async (name, key) => done((await store(name, "readwrite")).delete(key));
export const clear = async (name) => done((await store(name, "readwrite")).clear());

export async function putMany(name, values) {
  const tx = (await open()).transaction(name, "readwrite");
  for (const v of values) tx.objectStore(name).put(v);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Small key/value settings: stores list, ingredient->store memory, API key, spend.
export async function getMeta(key, fallback) {
  const row = await get("meta", key);
  return row ? row.value : fallback;
}
export const setMeta = (key, value) => put("meta", { key, value });

// Ask the browser not to evict our data when the phone is low on space.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch {
    return false;
  }
}
