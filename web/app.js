// Recipe Book front end: a small hash-routed single-page app with no build step.
// Everything runs on the phone: data in IndexedDB, AI calls straight to Claude with your own key.
import { api, withStores, exportBackup, importBackup } from "./localapi.js";
import { getMeta, setMeta, requestPersistence } from "./store.js";
import { MODELS, extractFromUrl, extractFromImages, extractFromText, extractFromVideo, testKey, askAboutRecipe, providerLabel, photoQueries, pickPhoto } from "./ai.js";
import { findPhotos, downloadPhoto, previewsFor, queriesFromTitle } from "./photos.js";
import { testGeminiKey } from "./gemini.js";
import { parseRecipeText, parseQty } from "./parse.js";

const app = document.getElementById("app");
const state = {
  stores: [],
  draft: null, // recipe produced by an import, waiting for review
  undo: null, // { id, before, summary } after applying a Claude-suggested change
  lastImport: null, // { kind, payload, tier, cost, model } so "Try harder" can re-run it
  timers: new Map(), // "recipeId:stepIndex" -> { end, minutes, done }
  cook: new Map(), // recipeId -> { servings, doneSteps:Set, have:Set }
};

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

const FRACTIONS = [[0.125, "⅛"], [0.25, "¼"], [0.333, "⅓"], [0.5, "½"], [0.667, "⅔"], [0.75, "¾"]];
function formatQty(q) {
  if (q == null) return "";
  const whole = Math.floor(q);
  const frac = q - whole;
  if (frac < 0.06) return String(whole || (q > 0 ? Math.round(q * 100) / 100 : 0));
  if (frac > 0.94) return String(whole + 1);
  for (const [v, sym] of FRACTIONS) if (Math.abs(frac - v) < 0.04) return whole ? `${whole} ${sym}` : sym;
  return String(Math.round(q * 100) / 100);
}

function formatMinutes(m) {
  if (!m) return "";
  if (m < 1) return `${Math.max(5, Math.round((m * 60) / 5) * 5)} sec`;
  const h = Math.floor(m / 60);
  const min = Math.floor(m % 60);
  const sec = Math.round(((m * 60) % 60) / 5) * 5;
  if (h) return `${h} hr${min ? ` ${min} min` : ""}`;
  return sec && sec < 60 ? `${min} min ${sec} sec` : `${Math.round(m)} min`;
}

// A stable colour per recipe for cards without a photo.
const hueFor = (text) => [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

const totalTime = (r) => r.totalMinutes || (r.prepMinutes || 0) + (r.cookMinutes || 0) || null;

const icon = {
  search: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2Zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 5h2v2H3V5Zm4 0h14v2H7V5Zm-4 6h2v2H3v-2Zm4 0h14v2H7v-2Zm-4 6h2v2H3v-2Zm4 0h14v2H7v-2Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>',
  cart: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM5.2 4H21l-2 9H7.4l.4 2H19v2H6.2L3.6 4H1V2h3.4l.8 2Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>',
  star: (on) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>`,
  gear: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="m10.2 2h3.6l.5 2.6c.6.2 1.1.5 1.6.9l2.5-.9 1.8 3.1-2 1.7a6.6 6.6 0 0 1 0 1.8l2 1.7-1.8 3.1-2.5-.9c-.5.4-1 .7-1.6.9l-.5 2.6h-3.6l-.5-2.6c-.6-.2-1.1-.5-1.6-.9l-2.5.9-1.8-3.1 2-1.7a6.6 6.6 0 0 1 0-1.8l-2-1.7 1.8-3.1 2.5.9c.5-.4 1-.7 1.6-.9l.5-2.6ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M15.4 5 8.4 12l7 7-1.4 1.4L5.6 12 14 3.6 15.4 5Z"/></svg>',
};

function storeSelect(current, attrs = "") {
  const opts = state.stores.map((s) => `<option ${s === current ? "selected" : ""}>${esc(s)}</option>`).join("");
  return `<select ${attrs} aria-label="Where to buy">
    <option value="" ${!current ? "selected" : ""}>Where to buy?</option>${opts}
    <option value="__new">+ New store…</option></select>`;
}

// Handles the "+ New store…" option; returns the chosen store or null if cancelled.
function resolveStoreChoice(select, previous) {
  if (select.value !== "__new") return select.value;
  const name = prompt("Store name (e.g. Costco, Trader Joe's, Farmers market)")?.trim();
  if (!name) {
    select.value = previous || "";
    return null;
  }
  if (!state.stores.includes(name)) state.stores.push(name);
  return name;
}

async function refreshShoppingBadge() {
  try {
    const items = await api("/api/shopping");
    const n = items.filter((i) => !i.checked).length;
    const badge = document.getElementById("shopping-count");
    badge.textContent = n;
    badge.hidden = n === 0;
  } catch {}
}

// Resize a photo client-side so uploads stay small and fast.
function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(img.src);
      canvas.toBlob(
        (blob) => resolve({ mediaType: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl, blob }),
        "image/jpeg",
        0.85,
      );
    };
    img.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- router ----------
const routes = [
  [/^#?\/?$/, viewList],
  [/^#\/recipe\/([\w-]+)$/, viewRecipe],
  [/^#\/import(?:\?(.*))?$/, viewImport],
  [/^#\/settings$/, viewSettings],
  [/^#\/new$/, () => {
    state.draft = null;
    state.lastImport = null;
    return viewEditor(null);
  }],
  [/^#\/review$/, () => viewEditor(null)],
  [/^#\/edit\/([\w-]+)$/, viewEditor],
  [/^#\/shopping$/, viewShopping],
];

let wakeLock = null;
async function router() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  document.body.style.overflow = "";
  const hash = location.hash || "#/";
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      window.scrollTo(0, 0);
      try {
        await view(m[1]);
      } catch (err) {
        app.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(err.message)}</p><a class="btn" href="#/">Back to recipes</a></div>`;
      }
      return;
    }
  }
  location.hash = "#/";
}

// ---------- list ----------
async function viewList() {
  document.title = "Recipe Book";
  const recipes = await api("/api/recipes");
  let query = "";
  let activeTag = null;

  const tags = [...new Set(recipes.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b));

  app.innerHTML = `
    <div class="list-head">
      <div class="search">${icon.search}<input class="input" id="q" type="search" placeholder="Search recipes or ingredients" autocomplete="off"></div>
      <a class="btn desktop-only" href="#/new">New recipe</a>
      <a class="btn primary desktop-only" href="#/import">${icon.plus} Import</a>
    </div>
    ${recipes.length ? `<div class="tags" id="tags">
      <button class="chip" data-tag="__fav">★ Favorites</button>
      ${tags.map((t) => `<button class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}
    </div>` : ""}
    <div id="grid"></div>
    <a class="btn primary fab" href="#/import">${icon.plus} Import recipe</a>`;

  const grid = app.querySelector("#grid");
  function render() {
    const q = query.toLowerCase();
    const shown = recipes.filter((r) => {
      if (activeTag === "__fav" && !r.favorite) return false;
      if (activeTag && activeTag !== "__fav" && !r.tags.includes(activeTag)) return false;
      if (!q) return true;
      return [r.title, r.description, ...r.tags, ...r.ingredientNames].join(" ").toLowerCase().includes(q);
    });
    if (!recipes.length) {
      grid.innerHTML = `<div class="empty">
        <h2>No recipes yet</h2>
        <p>Import one from a website link, a photo of a cookbook or recipe card, or pasted text.</p>
        <div class="row" style="justify-content:center"><a class="btn primary" href="#/import">${icon.plus} Import your first recipe</a><a class="btn" href="#/new">Type one in</a></div>
      </div>`;
      return;
    }
    if (!shown.length) {
      grid.innerHTML = `<div class="empty"><p>Nothing matches “${esc(query || activeTag)}”.</p></div>`;
      return;
    }
    grid.innerHTML = `<div class="grid">${shown.map((r) => {
      const t = totalTime(r);
      return `<a class="card rcard" href="#/recipe/${r.id}">
        ${r.image
          ? `<div class="thumb"><img src="${esc(r.image)}" alt="" loading="lazy"></div>`
          : `<div class="thumb noimg" style="--hue:${hueFor(r.title)}"><span class="ph">${esc(r.title[0] || "?")}</span></div>`}
        <div class="body">
          <h3>${r.favorite ? '<span class="fav">★</span> ' : ""}${esc(r.title)}</h3>
          <div class="meta">${t ? `<span>${formatMinutes(t)}</span>` : ""}<span>${r.ingredientCount} ingredients</span>${r.servings ? `<span>Serves ${r.servings}</span>` : ""}</div>
        </div></a>`;
    }).join("")}</div>`;
  }
  render();

  app.querySelector("#q").addEventListener("input", (e) => {
    query = e.target.value.trim();
    render();
  });
  app.querySelector("#tags")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tag]");
    if (!chip) return;
    activeTag = activeTag === chip.dataset.tag ? null : chip.dataset.tag;
    app.querySelectorAll("#tags .chip").forEach((c) => c.classList.toggle("active", c.dataset.tag === activeTag));
    render();
  });
}

// ---------- recipe view ----------
async function viewRecipe(id) {
  const recipe = await api(`/api/recipes/${id}`);
  document.title = recipe.title;
  if (!state.cook.has(id)) state.cook.set(id, { servings: recipe.servings, doneSteps: new Set(), have: new Set() });
  const cook = state.cook.get(id);
  navigator.wakeLock?.request("screen").then((l) => (wakeLock = l)).catch(() => {});

  const t = totalTime(recipe);
  const sourceLink = recipe.source && /^https?:/.test(recipe.source)
    ? `<a href="${esc(recipe.source)}" target="_blank" rel="noopener">${esc(new URL(recipe.source).hostname.replace(/^www\./, ""))}</a>`
    : esc(recipe.source || "");

  app.innerHTML = `
    <div class="rtoolbar">
      <a class="btn ghost small" href="#/" aria-label="All recipes">${icon.back}<span class="desktop-only">Recipes</span></a>
      <span class="spacer"></span>
      <button class="iconbtn" id="fav" title="Favorite" style="color:var(--accent)">${icon.star(recipe.favorite)}</button>
      <a class="btn small" href="#/edit/${id}">Edit</a>
      <button class="btn primary small ing-toggle" id="open-ing">${icon.list} Ingredients <span>(${recipe.ingredients.length})</span></button>
    </div>
    ${state.undo?.id === id ? `<div class="notice row" id="undo-bar"><span style="flex:1">Recipe updated: ${esc(state.undo.summary)}</span><button class="btn small" id="undo">Undo</button></div>` : ""}
    <div class="rhead ${recipe.image ? "has-img" : ""}">
      <div>
        <h1>${esc(recipe.title)}</h1>
        ${recipe.description ? `<p class="muted" style="margin:0">${esc(recipe.description)}</p>` : ""}
        <div class="stats">
          ${recipe.prepMinutes ? `<div class="stat"><b>Prep</b>${formatMinutes(recipe.prepMinutes)}</div>` : ""}
          ${recipe.cookMinutes ? `<div class="stat"><b>Cook</b>${formatMinutes(recipe.cookMinutes)}</div>` : ""}
          ${t ? `<div class="stat"><b>Total</b>${formatMinutes(t)}</div>` : ""}
          ${recipe.servings ? `<div class="stat"><b>Serves</b>${recipe.servings}</div>` : ""}
        </div>
        ${recipe.tags.length ? `<div class="row">${recipe.tags.map((tg) => `<span class="chip">${esc(tg)}</span>`).join("")}</div>` : ""}
        ${recipe.source ? `<p class="source">From ${sourceLink}</p>` : ""}
        ${recipe.image ? "" : `<button class="btn small" id="change-photo">📷 Find a photo</button>`}
      </div>
      ${recipe.image ? `<div>
        <div class="hero"><img src="${esc(recipe.image)}" alt=""></div>
        <div class="photo-meta"><span>${esc(recipe.imageCredit || "")}</span><button class="linkbtn" id="change-photo">Change photo</button></div>
      </div>` : ""}
    </div>

    <h2>Steps</h2>
    <ol class="steps" id="steps">
      ${recipe.steps.map((s, i) => `
        <li class="step ${cook.doneSteps.has(i) ? "done" : ""}" data-i="${i}">
          <span class="num">${i + 1}</span>
          <div>
            <p>${esc(s.text)}</p>
            ${s.timerMinutes ? `<div class="tools"><button class="timer" data-timer="${i}" data-min="${s.timerMinutes}"></button></div>` : ""}
          </div>
        </li>`).join("")}
    </ol>
    ${recipe.steps.length ? `<p class="muted" style="font-size:14px">Tap a step to mark it done.</p>` : `<p class="muted">No steps yet. <a href="#/edit/${id}">Add some</a>.</p>`}
    ${recipe.notes ? `<h2>Notes</h2><div class="notes">${esc(recipe.notes)}</div>` : ""}

    <aside class="drawer" id="drawer" aria-label="Ingredients"></aside>
    <div class="drawer-backdrop" id="backdrop"></div>
    <button class="btn primary fab fab-ask" id="ask">💬 Ask AI</button>
    <div class="drawer-backdrop" id="ask-backdrop"></div>
    <div class="drawer-backdrop" id="photo-backdrop"></div>
    <section class="sheet" id="photo-sheet" aria-label="Choose a photo">
      <div class="drawer-head"><h2>Choose a photo</h2><button class="iconbtn" id="close-photo" aria-label="Close">${icon.close}</button></div>
      <div class="sheet-body" id="photo-body"></div>
    </section>
    <section class="sheet" id="ask-sheet" aria-label="Ask AI about this recipe">
      <div class="drawer-head"><h2>Ask about this recipe</h2><button class="iconbtn" id="close-ask" aria-label="Close">${icon.close}</button></div>
      <div class="sheet-body" id="ask-body"></div>
    </section>`;

  // steps & timers
  app.querySelector("#steps").addEventListener("click", (e) => {
    const timerBtn = e.target.closest("[data-timer]");
    if (timerBtn) {
      toggleTimer(`${id}:${timerBtn.dataset.timer}`, Number(timerBtn.dataset.min));
      return;
    }
    const li = e.target.closest(".step");
    if (!li) return;
    const i = Number(li.dataset.i);
    cook.doneSteps.has(i) ? cook.doneSteps.delete(i) : cook.doneSteps.add(i);
    li.classList.toggle("done");
  });
  renderTimers();

  app.querySelector("#fav").addEventListener("click", async () => {
    recipe.favorite = !recipe.favorite;
    await api(`/api/recipes/${id}`, { method: "PUT", body: { favorite: recipe.favorite } });
    app.querySelector("#fav").innerHTML = icon.star(recipe.favorite);
  });

  // ingredient drawer
  const drawer = app.querySelector("#drawer");
  const backdrop = app.querySelector("#backdrop");
  const open = () => {
    drawer.classList.add("open");
    backdrop.classList.add("open");
    document.body.style.overflow = "hidden";
  };
  const close = () => {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
    document.body.style.overflow = "";
  };
  app.querySelector("#open-ing").addEventListener("click", open);
  backdrop.addEventListener("click", close);

  const scale = () => (recipe.servings && cook.servings ? cook.servings / recipe.servings : 1);
  const scaled = (q) => (q == null ? null : q * scale());

  function renderDrawer() {
    let lastSection = null;
    const rows = recipe.ingredients.map((ing) => {
      const head = ing.section && ing.section !== lastSection ? `<div class="ing-section">${esc(ing.section)}</div>` : "";
      lastSection = ing.section;
      const qty = [ing.estimated ? "≈" : "", formatQty(scaled(ing.quantity)), ing.unit].filter(Boolean).join(" ");
      return `${head}<div class="ing ${cook.have.has(ing.id) ? "have" : ""}" data-id="${ing.id}">
        <input type="checkbox" data-have ${cook.have.has(ing.id) ? "checked" : ""} aria-label="I have this">
        <div>
          <div class="txt">${qty ? `<span class="qty">${esc(qty)}</span> ` : ""}${esc(ing.name)}${ing.note ? ` <span class="note">${esc(ing.note)}</span>` : ""}</div>
          <div class="store-pick">${storeSelect(ing.store, "data-store")}</div>
        </div>
        <div class="ing-actions">
          <button class="iconbtn" data-swap title="Ask about a substitute" aria-label="Ask about a substitute for ${esc(ing.name)}">⇄</button>
          <button class="iconbtn" data-add title="Add to shopping list" aria-label="Add ${esc(ing.name)} to shopping list">${icon.cart}</button>
        </div>
      </div>`;
    }).join("");
    const need = recipe.ingredients.filter((i) => !cook.have.has(i.id)).length;
    drawer.innerHTML = `
      <div class="drawer-head"><h2>Ingredients</h2><button class="iconbtn" id="close-ing" aria-label="Close">${icon.close}</button></div>
      <div class="drawer-body">
        ${recipe.servings ? `<div class="servings"><span class="muted">Servings</span><span class="spacer"></span>
          <button class="btn small" data-serv="-1" aria-label="Fewer servings">−</button>
          <span class="val">${cook.servings}</span>
          <button class="btn small" data-serv="1" aria-label="More servings">+</button></div>` : ""}
        <p class="muted" style="font-size:13px;margin:0 0 4px">Tick what you already have — the rest can go on your shopping list.${recipe.ingredients.some((i) => i.estimated) ? " <b>≈</b> means the AI estimated the amount because the source didn't give one." : ""}</p>
        ${rows || '<p class="muted">No ingredients listed.</p>'}
      </div>
      <div class="drawer-foot"><button class="btn primary" style="width:100%" id="add-all" ${need ? "" : "disabled"}>${icon.cart} Add ${need} item${need === 1 ? "" : "s"} to shopping list</button></div>`;
  }
  renderDrawer();

  const toShoppingItem = (ing) => ({
    name: ing.name,
    quantity: scaled(ing.quantity) == null ? null : Math.round(scaled(ing.quantity) * 100) / 100,
    unit: ing.unit,
    aisle: ing.aisle,
    store: ing.store,
    recipeTitle: recipe.title,
  });

  drawer.addEventListener("click", async (e) => {
    if (e.target.closest("#close-ing")) return close();
    const serv = e.target.closest("[data-serv]");
    if (serv) {
      cook.servings = Math.max(1, cook.servings + Number(serv.dataset.serv));
      return renderDrawer();
    }
    if (e.target.closest("#add-all")) {
      const items = recipe.ingredients.filter((i) => !cook.have.has(i.id)).map(toShoppingItem);
      await api("/api/shopping", { method: "POST", body: { items } });
      toast(`Added ${items.length} item${items.length === 1 ? "" : "s"} to your shopping list`);
      refreshShoppingBadge();
      return;
    }
    const row = e.target.closest(".ing");
    if (!row) return;
    const ing = recipe.ingredients.find((i) => i.id === row.dataset.id);
    if (e.target.closest("[data-swap]")) {
      close();
      const amount = [formatQty(ing.quantity), ing.unit].filter(Boolean).join(" ");
      return openAsk(`Instead of ${amount ? `${amount} ` : ""}${ing.name}, can I use `);
    }
    if (e.target.closest("[data-add]")) {
      await api("/api/shopping", { method: "POST", body: { items: [toShoppingItem(ing)] } });
      toast(`Added ${ing.name}`);
      refreshShoppingBadge();
    }
  });
  drawer.addEventListener("change", async (e) => {
    const row = e.target.closest(".ing");
    if (!row) return;
    const ing = recipe.ingredients.find((i) => i.id === row.dataset.id);
    if (e.target.matches("[data-have]")) {
      e.target.checked ? cook.have.add(ing.id) : cook.have.delete(ing.id);
      renderDrawer();
    } else if (e.target.matches("[data-store]")) {
      const store = resolveStoreChoice(e.target, ing.store);
      if (store === null) return;
      await api("/api/ingredient-store", { method: "PUT", body: { name: ing.name, store } });
      // Same ingredient name may appear twice in a recipe; keep them in sync.
      recipe.ingredients.forEach((i) => { if (i.name.toLowerCase() === ing.name.toLowerCase()) i.store = store; });
      renderDrawer();
      if (store) toast(`Remembered: buy ${ing.name} at ${store}`);
    }
  });

  // ---------- ask Claude (substitutions and other questions) ----------
  const sheet = app.querySelector("#ask-sheet");
  const askBody = app.querySelector("#ask-body");
  const askBackdrop = app.querySelector("#ask-backdrop");
  let lastQuestion = "";

  function closeAsk() {
    sheet.classList.remove("open");
    askBackdrop.classList.remove("open");
    document.body.style.overflow = "";
  }

  async function openAsk(prefill = "") {
    sheet.classList.add("open");
    askBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
    const cfg = await aiConfig();
    const who = isFree(cfg) ? "Gemini" : "Claude";
    askBody.innerHTML = cfg.ready
      ? `<form id="ask-form">
          <textarea class="input" name="q" rows="3" placeholder="e.g. Can I use jarred minced garlic instead of cloves?">${esc(prefill)}</textarea>
          <button class="btn primary" style="width:100%;margin-top:10px">Ask</button>
          <p class="muted" style="font-size:13px;text-align:center;margin:8px 0 0">${who} answers, and suggests exact edits if a swap works. Nothing changes until you tap Apply. ${isFree(cfg) ? "Free." : "About 0.1¢."}</p>
        </form>`
      : `<p>This needs a free Gemini key (or a Claude key). <a href="#/settings">Add one in Settings</a>.</p>`;
    const ta = askBody.querySelector("textarea");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  const ingLine = (i) => [formatQty(i.quantity), i.unit, i.name].filter(Boolean).join(" ") + (i.note ? ` (${i.note})` : "");

  function describeChanges(res) {
    const rows = [];
    for (const c of res.ingredientChanges) {
      const old = recipe.ingredients[c.number - 1];
      if (c.action === "replace" && old) rows.push(`<div class="chg"><span class="old">${esc(ingLine(old))}</span><span class="new">→ ${esc(ingLine(c))}</span></div>`);
      else if (c.action === "remove" && old) rows.push(`<div class="chg"><span class="old">Remove: ${esc(ingLine(old))}</span></div>`);
      else if (c.action === "add") rows.push(`<div class="chg"><span class="new">Add: ${esc(ingLine(c))}</span></div>`);
    }
    for (const c of res.stepChanges) {
      if (recipe.steps[c.number - 1]) rows.push(`<div class="chg"><span class="muted">Step ${c.number}</span><span class="new">${esc(c.text)}</span></div>`);
    }
    if (res.noteToAdd) rows.push(`<div class="chg"><span class="muted">Add to notes</span><span class="new">${esc(res.noteToAdd)}</span></div>`);
    return rows;
  }

  // Turns Claude's proposed edits into a new ingredients/steps/notes set.
  function applyChanges(res) {
    const ingredients = recipe.ingredients.map(({ store, ...i }) => ({ ...i }));
    const removals = [];
    for (const c of res.ingredientChanges) {
      const n = c.number - 1;
      const fresh = { quantity: c.quantity, unit: c.unit, name: c.name, note: c.note, aisle: c.aisle, estimated: false };
      if (c.action === "replace" && ingredients[n]) ingredients[n] = { ...ingredients[n], ...fresh };
      else if (c.action === "remove" && ingredients[n]) removals.push(n);
      else if (c.action === "add") ingredients.push({ section: ingredients.at(-1)?.section || "", ...fresh });
    }
    removals.sort((a, b) => b - a).forEach((n) => ingredients.splice(n, 1));
    const steps = recipe.steps.map((st) => ({ ...st }));
    for (const c of res.stepChanges) {
      if (steps[c.number - 1]) steps[c.number - 1] = { text: c.text, timerMinutes: c.timerMinutes };
    }
    const notes = res.noteToAdd ? [recipe.notes, res.noteToAdd].filter(Boolean).join("\n\n") : recipe.notes;
    return { ingredients, steps, notes };
  }

  function showAnswer(res) {
    const rows = describeChanges(res);
    askBody.innerHTML = `
      <p class="muted" style="font-size:13px;margin:0 0 4px">You asked: ${esc(lastQuestion)}</p>
      <p style="margin:0 0 12px">${esc(res.answer)}</p>
      ${rows.length ? `<div class="card chg-list"><div class="muted" style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:8px 12px 0">Suggested changes</div>${rows.join("")}</div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" style="flex:1" id="apply">Apply to recipe</button>
          <button class="btn" id="ask-again">Ask something else</button>
        </div>`
      : `<button class="btn" style="width:100%" id="ask-again">Ask something else</button>`}
      <p class="muted" style="font-size:12px;text-align:center;margin:10px 0 0">${esc(res.model)} · ${res.cost === 0 ? "free" : `about ${formatCost(res.cost)}`}</p>`;
    askBody.querySelector("#ask-again").addEventListener("click", () => openAsk());
    askBody.querySelector("#apply")?.addEventListener("click", async () => {
      const before = {
        ingredients: recipe.ingredients.map(({ store, ...i }) => i),
        steps: recipe.steps,
        notes: recipe.notes,
      };
      const firstChange = res.ingredientChanges[0];
      const summary = firstChange?.action === "replace" ? `now uses ${firstChange.name}` : "changes applied";
      await api(`/api/recipes/${id}`, { method: "PUT", body: applyChanges(res) });
      state.undo = { id, before, summary };
      closeAsk();
      viewRecipe(id);
    });
  }

  askBody.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get("q").trim();
    if (!q) return;
    lastQuestion = q;
    askBody.innerHTML = `<div class="working"><div class="spinner"></div><strong>Thinking…</strong></div>`;
    try {
      const res = await askAboutRecipe(await aiConfig(), recipe, q);
      await addSpend(res.cost);
      showAnswer(res);
    } catch (err) {
      askBody.innerHTML = `<div class="error">${esc(err.message)}</div><button class="btn" style="width:100%" id="ask-again">Try again</button>`;
      askBody.querySelector("#ask-again").addEventListener("click", () => openAsk(q));
    }
  });

  app.querySelector("#ask").addEventListener("click", () => openAsk());
  app.querySelector("#close-ask").addEventListener("click", closeAsk);
  askBackdrop.addEventListener("click", closeAsk);

  // ---------- photo picker ----------
  const photoSheet = app.querySelector("#photo-sheet");
  const photoBody = app.querySelector("#photo-body");
  const photoBackdrop = app.querySelector("#photo-backdrop");
  const closePhoto = () => {
    photoSheet.classList.remove("open");
    photoBackdrop.classList.remove("open");
    document.body.style.overflow = "";
  };
  async function setPhoto(blob, credit) {
    const { url } = await api("/api/images", { method: "POST", body: { blob } });
    await api(`/api/recipes/${id}`, { method: "PUT", body: { image: url, imageCredit: credit, photoSearched: true } });
    closePhoto();
    viewRecipe(id);
  }
  async function openPhotoPicker() {
    photoSheet.classList.add("open");
    photoBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
    photoBody.innerHTML = `<div class="working"><div class="spinner"></div><strong>Finding photos…</strong></div>`;
    let candidates = [];
    try {
      const cfg = await aiConfig();
      let queries = queriesFromTitle(recipe.title);
      if (cfg.geminiKey || cfg.claudeKey) {
        try {
          const res = await photoQueries(cfg, recipe);
          if (res.cost) await addSpend(res.cost);
          if (res.queries.length) queries = res.queries;
        } catch {}
      }
      candidates = await findPhotos(queries, { limit: 12 });
    } catch {}
    photoBody.innerHTML = `
      ${candidates.length
        ? `<p class="muted" style="margin:0 0 8px;font-size:13px">Free, openly licensed photos. Tap one to use it.</p>
           <div class="photo-grid">${candidates.map((c, n) => `<button class="pick" data-n="${n}" title="${esc(c.title)}"><img src="${esc(c.thumb)}" alt="${esc(c.title)}" loading="lazy"></button>`).join("")}</div>`
        : `<p>No photos found${navigator.onLine ? "" : " (you're offline)"}. You can use your own instead.</p>`}
      <div class="row" style="margin-top:12px">
        <label class="btn" style="flex:1">Use my own photo<input type="file" id="own-photo" accept="image/*" hidden></label>
        ${recipe.image ? `<button class="btn ghost danger" id="rm-photo">Remove photo</button>` : ""}
      </div>`;
    photoBody.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", async () => {
      const c = candidates[Number(b.dataset.n)];
      photoBody.querySelectorAll(".pick").forEach((x) => (x.disabled = true));
      b.classList.add("loading");
      try {
        await setPhoto(await downloadPhoto(c), c.credit);
      } catch (err) {
        toast(err.message);
        photoBody.querySelectorAll(".pick").forEach((x) => (x.disabled = false));
        b.classList.remove("loading");
      }
    }));
    photoBody.querySelector("#own-photo").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (file) await setPhoto((await resizeImage(file, 1400)).blob, "");
    });
    photoBody.querySelector("#rm-photo")?.addEventListener("click", async () => {
      await api(`/api/recipes/${id}`, { method: "PUT", body: { image: null, photoSearched: true } });
      closePhoto();
      viewRecipe(id);
    });
  }
  app.querySelector("#change-photo").addEventListener("click", openPhotoPicker);
  app.querySelector("#close-photo").addEventListener("click", closePhoto);
  photoBackdrop.addEventListener("click", closePhoto);

  app.querySelector("#undo")?.addEventListener("click", async () => {
    await api(`/api/recipes/${id}`, { method: "PUT", body: state.undo.before });
    state.undo = null;
    toast("Change undone");
    viewRecipe(id);
  });
}

// ---------- step timers ----------
let audioCtx;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    for (let k = 0; k < 3; k++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      o.connect(g).connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + k * 0.4;
      g.gain.setValueAtTime(0.3, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
      o.start(t0);
      o.stop(t0 + 0.3);
    }
  } catch {}
  navigator.vibrate?.([300, 150, 300, 150, 300]);
}

function toggleTimer(key, minutes) {
  audioCtx ??= new AudioContext(); // unlock audio on a user gesture
  const t = state.timers.get(key);
  if (t && !t.done && confirm("Stop this timer?")) state.timers.delete(key);
  else if (t?.done) state.timers.delete(key);
  else if (!t) state.timers.set(key, { end: Date.now() + minutes * 60000, minutes, done: false });
  renderTimers();
}

function renderTimers() {
  document.querySelectorAll("[data-timer]").forEach((btn) => {
    const key = `${location.hash.split("/")[2]}:${btn.dataset.timer}`;
    const t = state.timers.get(key);
    btn.classList.remove("running", "finished");
    if (!t) {
      btn.textContent = `⏱ Start ${formatMinutes(Number(btn.dataset.min))} timer`;
    } else if (t.done) {
      btn.classList.add("finished");
      btn.textContent = "⏰ Time's up! Tap to dismiss";
    } else {
      const left = Math.max(0, Math.ceil((t.end - Date.now()) / 1000));
      const h = Math.floor(left / 3600);
      const m = Math.floor((left % 3600) / 60);
      const s = String(left % 60).padStart(2, "0");
      btn.classList.add("running");
      btn.textContent = `⏱ ${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${s} left`;
    }
  });
}

setInterval(() => {
  for (const t of state.timers.values()) {
    if (!t.done && Date.now() >= t.end) {
      t.done = true;
      beep();
      toast("⏰ A timer finished");
    }
  }
  renderTimers();
}, 1000);

// ---------- AI provider ----------
// Gemini is the free default; Claude is the paid option. Claude keys live under "apiKey" (the original name).
async function aiConfig() {
  const geminiKey = await getMeta("geminiKey", "");
  const claudeKey = await getMeta("apiKey", "");
  const provider = await getMeta("aiProvider", claudeKey && !geminiKey ? "claude" : "gemini");
  return { provider, geminiKey, claudeKey, ready: Boolean(provider === "gemini" ? geminiKey : claudeKey) };
}

const isFree = (cfg) => cfg.provider === "gemini";

// ---------- import ----------
function formatCost(dollars) {
  if (dollars == null) return "";
  if (dollars === 0) return "free";
  const cents = dollars * 100;
  if (cents < 0.05) return "under 0.1¢";
  if (cents < 1) return `${cents.toFixed(1)}¢`;
  if (cents < 100) return `${Math.round(cents)}¢`;
  return `$${dollars.toFixed(2)}`;
}

async function addSpend(cost) {
  const spend = await getMeta("spend", { total: 0, count: 0 });
  await setMeta("spend", { total: spend.total + cost, count: spend.count + 1 });
}

// YouTube (including Shorts) video id from a link, or null.
function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i);
  return m ? m[1] : null;
}
const isSocialVideoLink = (url) => /(?:tiktok\.com|instagram\.com\/(?:reel|p)\/|facebook\.com\/(?:reel|watch)|fb\.watch)/i.test(url);

const SOCIAL_VIDEO_HELP = "TikTok, Instagram and Facebook don't let apps read their videos. Instead: in the app, tap Share → Save video (or Download), then share the saved video from your gallery to Recipe Book. Screenshots of the ingredients work too.";

// Runs an AI import and stores the result as a draft for the review screen.
async function runAI(kind, payload, tier = "cheap") {
  const cfg = await aiConfig();
  const extractor = { url: extractFromUrl, photo: extractFromImages, text: extractFromText, video: extractFromVideo }[kind];
  const { recipe, cost, model } = await extractor(cfg, tier, payload);
  await addSpend(cost);
  const { imageUrl, ...rest } = recipe;
  const ytId = kind === "video" && payload.link ? youtubeId(payload.link) : null;
  state.draft = await withStores({
    ...rest,
    image: ytId
      ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`
      : kind === "url" && /^https?:\/\//.test(imageUrl) ? imageUrl : null,
    source: kind === "url" ? payload
      : kind === "video" ? payload.link || "Video import"
      : kind === "photo" ? "Photo import" : "Pasted text",
  });
  // Video always runs on Gemini, whichever provider is selected.
  state.lastImport = { kind, payload, tier, cost, model, provider: kind === "video" ? "gemini" : cfg.provider };
}

async function runFreeParse(text) {
  state.draft = await withStores(parseRecipeText(text));
  state.lastImport = { kind: "free", payload: text, tier: null, cost: 0, model: "Quick parse" };
}

// Content shared to the app from Android's share menu, parked by the service worker.
async function takeSharedPayload() {
  if (!("caches" in window) || !(await caches.has("share-inbox"))) return null;
  const cache = await caches.open("share-inbox");
  const metaRes = await cache.match("meta");
  if (!metaRes) return null;
  const meta = await metaRes.json();
  const files = [];
  for (let i = 0; i < meta.fileCount; i++) {
    const r = await cache.match(`file-${i}`);
    if (r) {
      const type = r.headers.get("content-type") || "image/jpeg";
      files.push(new File([await r.blob()], `shared-${i}.${type.split("/")[1] || "bin"}`, { type }));
    }
  }
  await caches.delete("share-inbox");
  return { ...meta, files };
}

async function viewImport(query = "") {
  document.title = "Import recipe";
  const cfg = await aiConfig();
  const hasKey = cfg.ready;
  const who = isFree(cfg) ? "Gemini" : "Claude";
  let tab = "url";
  let photos = [];
  let video = null; // { file, url } for a video picked or shared from the gallery
  let prefill = { url: "", text: "" };
  let autoRun = false;
  const MAX_VIDEO_MB = 60;

  if (new URLSearchParams(query).get("shared")) {
    const shared = await takeSharedPayload();
    const sharedVideo = shared?.files.find((f) => f.type.startsWith("video/"));
    if (sharedVideo) {
      tab = "photo";
      video = { file: sharedVideo, url: URL.createObjectURL(sharedVideo) };
    } else if (shared?.files.length) {
      tab = "photo";
      for (const f of shared.files) {
        try {
          photos.push(await resizeImage(f));
        } catch {}
      }
    } else if (shared) {
      const all = [shared.url, shared.text, shared.title].filter(Boolean).join(" ");
      const link = all.match(/https?:\/\/\S+/)?.[0];
      if (link) {
        tab = "url";
        prefill.url = link;
        autoRun = hasKey || (cfg.geminiKey && youtubeId(link));
      } else {
        tab = "text";
        prefill.text = [shared.title, shared.text].filter(Boolean).join("\n");
      }
    }
    history.replaceState(null, "", "#/import");
  }

  app.innerHTML = `
    <a class="btn ghost small" href="#/">${icon.back} Recipes</a>
    <h1 style="margin-top:12px">Import a recipe</h1>
    <p class="muted" style="margin:0">${who} pulls out the ingredients, steps and timings. You review everything before saving.</p>
    ${hasKey ? "" : `<div class="notice">AI import needs a free Gemini key (or a Claude key). <a href="#/settings">Add one in Settings</a>; it takes a couple of minutes. Until then you can use <b>Quick parse</b> on pasted text, or <a href="#/new">type a recipe in</a>.</div>`}
    <div class="tabs" role="tablist">
      <button data-tab="url">🔗 Link</button>
      <button data-tab="photo">📷 Photo/Video</button>
      <button data-tab="text">📝 Text</button>
    </div>
    <div class="card panel" id="panel"></div>
    <p class="muted" style="font-size:13px;margin-top:12px">Tip: from Chrome, YouTube or your gallery, tap <b>Share → Recipe Book</b> to send a link, photo or video straight here.</p>`;

  const panel = app.querySelector("#panel");
  const setTab = (t) => {
    tab = t;
    app.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === t));
    renderPanel();
  };
  const costNote = (txt) => `<p class="muted" style="font-size:13px;margin:8px 0 0;text-align:center">${txt}</p>`;

  function renderPanel(error = "") {
    const err = error ? `<div class="error">${esc(error)}</div>` : "";
    if (tab === "url") {
      panel.innerHTML = `${err}<form id="f">
        <label class="field">Recipe webpage or YouTube link<input class="input" name="url" type="url" inputmode="url" placeholder="https://…" value="${esc(prefill.url)}" required></label>
        <button class="btn primary" style="width:100%" ${hasKey || cfg.geminiKey ? "" : "disabled"}>Import from link</button></form>
        ${costNote(isFree(cfg) ? "Free with Gemini · YouTube videos and Shorts are watched, sound included" : "Usually under 1¢ with Claude Haiku · YouTube links use Gemini")}`;
    } else if (tab === "photo") {
      panel.innerHTML = video ? `${err}
        <video src="${video.url}" controls muted playsinline class="video-prev"></video>
        <div class="row" style="margin-top:8px"><span class="muted" style="flex:1;font-size:13px">${(video.file.size / 1048576).toFixed(1)} MB video</span>
          <button class="btn small ghost" id="rm-video">Remove</button></div>
        <button class="btn primary" style="width:100%;margin-top:12px" id="go" ${cfg.geminiKey ? "" : "disabled"}>Watch video &amp; get recipe</button>
        ${costNote(cfg.geminiKey ? "Free with Gemini · uses what's said, on-screen text and what's shown" : "Reading videos needs a free Gemini key (Claude can't watch video). Add one in Settings.")}`
      : `${err}
        <label class="dropzone" id="drop">
          <input type="file" id="files" accept="image/*,video/*" multiple hidden>
          <div style="font-size:30px">📷</div>
          <strong>Take or choose photos, or a video</strong>
          <div style="font-size:14px">Cookbook pages, recipe cards, screenshots, or a saved TikTok/Reel/cooking video.</div>
        </label>
        <div class="thumbs">${photos.map((p, i) => `<div class="t"><img src="${p.preview}" alt=""><button data-rm="${i}" aria-label="Remove">×</button></div>`).join("")}</div>
        <button class="btn primary" style="width:100%;margin-top:12px" id="go" ${photos.length && hasKey ? "" : "disabled"}>Read ${photos.length || ""} photo${photos.length === 1 ? "" : "s"}</button>
        ${costNote(isFree(cfg) ? "Free with Gemini" : "About 0.1–0.5¢ per photo with Claude Haiku")}`;
    } else {
      panel.innerHTML = `${err}<form id="f">
        <label class="field">Paste the recipe<textarea class="input" name="text" rows="12" placeholder="Paste a recipe from an email, a note, a social post…" required>${esc(prefill.text)}</textarea></label>
        <div class="row">
          <button class="btn primary" style="flex:1" name="mode" value="ai" ${hasKey ? "" : "disabled"}>Read with ${who}</button>
          <button class="btn" style="flex:1" name="mode" value="free">Quick parse (free)</button>
        </div></form>
        ${costNote(isFree(cfg) ? "Both free · Quick parse works offline but is less accurate" : "Claude: about 0.1¢ · Quick parse: free, works offline, less accurate")}`;
    }
  }
  setTab(tab);

  async function run(kind, payload) {
    const watching = kind === "video";
    panel.innerHTML = `<div class="working"><div class="spinner"></div><strong>${watching ? "Watching the video…" : "Reading your recipe…"}</strong><span class="muted">${watching ? "Videos can take up to a minute." : "This usually takes 10–30 seconds."}</span></div>`;
    try {
      await runAI(kind, payload);
      location.hash = "#/review";
    } catch (err) {
      renderPanel(kind === "url" && isSocialVideoLink(payload) ? SOCIAL_VIDEO_HELP : err.message);
    }
  }

  // Links: YouTube is watched as a video; TikTok/Instagram get a hint; everything else is read as a page.
  function importLink(url) {
    prefill.url = url;
    const id = youtubeId(url);
    if (id) return run("video", { uri: `https://www.youtube.com/watch?v=${id}`, link: url });
    return run("url", url);
  }

  async function readVideoFile() {
    if (video.file.size > MAX_VIDEO_MB * 1048576) {
      return renderPanel(`That video is ${(video.file.size / 1048576).toFixed(0)} MB. Videos up to ${MAX_VIDEO_MB} MB work; try a shorter clip or screenshots.`);
    }
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(video.file);
    });
    run("video", { data, mimeType: video.file.type || "video/mp4" });
  }

  app.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) setTab(b.dataset.tab);
  });

  async function addFiles(files) {
    const vid = files.find((f) => f.type.startsWith("video/"));
    if (vid) {
      // One video at a time; it replaces any photos.
      if (video) URL.revokeObjectURL(video.url);
      video = { file: vid, url: URL.createObjectURL(vid) };
      photos = [];
      return renderPanel();
    }
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      try {
        photos.push(await resizeImage(f));
      } catch (err) {
        toast(err.message);
      }
    }
    renderPanel();
  }

  panel.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (tab === "url") return importLink(String(fd.get("url")).trim());
    const text = String(fd.get("text")).trim();
    prefill.text = text;
    if (e.submitter?.value === "free") {
      await runFreeParse(text);
      location.hash = "#/review";
    } else {
      run("text", text);
    }
  });
  panel.addEventListener("change", (e) => {
    if (e.target.id === "files") addFiles([...e.target.files]);
  });
  panel.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) {
      e.preventDefault();
      photos.splice(Number(rm.dataset.rm), 1);
      renderPanel();
    } else if (e.target.closest("#rm-video")) {
      URL.revokeObjectURL(video.url);
      video = null;
      renderPanel();
    } else if (e.target.closest("#go")) {
      if (video) readVideoFile();
      else run("photo", photos.map(({ mediaType, data }) => ({ mediaType, data })));
    }
  });
  panel.addEventListener("dragover", (e) => {
    e.preventDefault();
    panel.querySelector("#drop")?.classList.add("over");
  });
  panel.addEventListener("dragleave", () => panel.querySelector("#drop")?.classList.remove("over"));
  panel.addEventListener("drop", (e) => {
    e.preventDefault();
    if (tab === "photo") addFiles([...e.dataTransfer.files]);
  });

  if (autoRun) importLink(prefill.url);
}

// ---------- settings ----------
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
});

function keyCard({ id, title, value, placeholder, where, help }) {
  return `<h2>${title}</h2>
    <div class="card panel">
      <p style="margin-top:0">${value ? "✅ Key saved." : "No key yet."} It's stored only on this phone and sent only to ${where}.</p>
      <form id="${id}-form">
        <label class="field">API key
          <input class="input" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${placeholder}" value="${esc(value)}">
        </label>
        <div class="key-msg"></div>
        <div class="row">
          <button class="btn primary">Save &amp; test</button>
          <button type="button" class="btn ghost" data-show>Show</button>
          ${value ? `<span class="spacer"></span><button type="button" class="btn danger" data-remove>Remove</button>` : ""}
        </div>
      </form>
      <details style="margin-top:12px"><summary>How do I get a key?</summary><ol style="padding-left:20px">${help}</ol></details>
    </div>`;
}

function wireKeyCard(id, metaKey, tester) {
  const form = app.querySelector(`#${id}-form`);
  const input = form.querySelector("[name=key]");
  form.querySelector("[data-show]").addEventListener("click", (e) => {
    input.type = input.type === "password" ? "text" : "password";
    e.target.textContent = input.type === "password" ? "Show" : "Hide";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    const msg = form.querySelector(".key-msg");
    if (!key) return;
    msg.innerHTML = `<p class="muted">Checking key…</p>`;
    const problem = await tester(key);
    if (problem) {
      msg.innerHTML = `<div class="error">${esc(problem)}</div>`;
      return;
    }
    await setMeta(metaKey, key);
    await setMeta("aiProvider", id); // a freshly added key becomes the one in use
    toast("Key saved and working.");
    viewSettings();
  });
  form.querySelector("[data-remove]")?.addEventListener("click", async () => {
    if (!confirm("Remove this API key from this phone?")) return;
    await setMeta(metaKey, "");
    viewSettings();
  });
}

async function viewSettings() {
  document.title = "Settings";
  const cfg = await aiConfig();
  const spend = await getMeta("spend", { total: 0, count: 0 });
  const photoStatus = await getMeta("photoStatus", null);
  const missingPhotos = (await api("/api/recipes")).filter((r) => !r.image && !r.photoSearched).length;
  const lastBackup = await getMeta("lastBackup", null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const standalone = matchMedia("(display-mode: standalone)").matches;

  app.innerHTML = `
    <a class="btn ghost small" href="#/">${icon.back} Recipes</a>
    <h1 style="margin-top:12px">Settings</h1>

    ${standalone ? "" : `<h2>Install on your phone</h2>
    <div class="card panel">
      <p style="margin-top:0">Install Recipe Book so it opens like an app, works offline, and shows up in your <b>Share</b> menu.</p>
      ${installPrompt ? `<button class="btn primary" id="install">Install app</button>` : `<p class="muted" style="margin-bottom:0">In Chrome, tap the <b>⋮</b> menu → <b>Add to Home screen</b> → <b>Install</b>.</p>`}
    </div>`}

    <h2>AI</h2>
    <div class="card panel">
      <p style="margin-top:0">Which AI reads recipes and answers your questions:</p>
      <label class="choice"><input type="radio" name="provider" value="gemini" ${cfg.provider === "gemini" ? "checked" : ""}>
        <span><b>Gemini (free)</b><br><span class="muted">Google's free tier. Daily limits, but plenty for personal use. Google may use what you send to improve its products.</span></span></label>
      <label class="choice"><input type="radio" name="provider" value="claude" ${cfg.provider === "claude" ? "checked" : ""}>
        <span><b>Claude (paid)</b><br><span class="muted">Usually under 1¢ per import, billed to your Anthropic account.</span></span></label>
    </div>

    <div class="row" style="margin:-4px 0 4px"><button class="btn small" id="test-ai">Test AI</button><span id="test-ai-msg" class="muted" style="font-size:13px;flex:1"></span></div>

    ${keyCard({
      id: "gemini", title: "Gemini API key (free)", value: cfg.geminiKey, placeholder: "AIza…",
      where: "Google",
      help: `<li>Go to <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with your Google account.</li>
        <li>Tap <b>Create API key</b>. If it asks for a project, let it create one.</li>
        <li>Copy the key and paste it above.</li>
        <li>No card needed. If Google ever offers to set up billing, you can skip it; that's what keeps it free.</li>`,
    })}

    ${keyCard({
      id: "claude", title: "Claude API key (paid, optional)", value: cfg.claudeKey, placeholder: "sk-ant-…",
      where: "Anthropic",
      help: `<li>Go to <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> and sign up.</li>
        <li>Add a little credit under <b>Billing</b>. $5 lasts a long time at under 1¢ per import.</li>
        <li>Under <b>Billing → Limits</b>, set a monthly spend limit so a mistake can never cost much.</li>
        <li>Under <b>API keys</b>, tap <b>Create key</b>, copy it, and paste it above.</li>`,
    })}

    <h2>Photos</h2>
    <div class="card panel">
      <p style="margin-top:0">${missingPhotos ? `${missingPhotos} recipe${missingPhotos === 1 ? "" : "s"} still need${missingPhotos === 1 ? "s" : ""} a photo.` : "Every recipe has a photo (or you chose none)."}</p>
      ${photoStatus ? `<p class="muted" style="font-size:13px">Last run ${new Date(photoStatus.at).toLocaleString()}: ${photoStatus.found} added${photoStatus.failed ? `, ${photoStatus.failed} failed` : ""}.</p>
        ${photoStatus.error ? `<div class="error" style="font-size:13px">${esc(photoStatus.error)}</div>` : ""}` : ""}
      <button class="btn small" id="find-photos" ${missingPhotos ? "" : "disabled"}>${fillingPhotos ? "Finding photos…" : "Find photos now"}</button>
    </div>

    <h2>AI usage</h2>
    <div class="card panel">
      <p style="margin:0">${spend.count} AI request${spend.count === 1 ? "" : "s"} · Claude spending about <b>${spend.total ? formatCost(spend.total) : "0¢"}</b></p>
      <p class="muted" style="font-size:13px">Gemini requests are free. Claude spending is estimated on this phone; your real bill is at console.anthropic.com.</p>
      <button class="btn small" id="reset-spend">Reset counter</button>
    </div>

    <h2>Backup</h2>
    <div class="card panel">
      <p style="margin-top:0">Your recipes live only on this phone. Save a backup to Google Drive now and then: if you clear Chrome's data or lose the phone, a backup is the only way to get them back.</p>
      <p class="muted" style="font-size:13px">${lastBackup ? `Last backup: ${new Date(lastBackup).toLocaleDateString()}` : "No backup yet."}</p>
      <div class="row">
        <button class="btn primary" id="backup">Save backup</button>
        <label class="btn">Restore from backup<input type="file" id="restore" accept="application/json,.json" hidden></label>
      </div>
    </div>

    <h2>Storage</h2>
    <div class="card panel">
      <p style="margin:0">${persisted ? "✅ Protected: Chrome won't clear your recipes to free up space." : "Chrome may clear data if the phone runs very low on space. Installing the app usually prevents this."}</p>
      ${est ? `<p class="muted" style="font-size:13px;margin-bottom:0">Using ${(est.usage / 1048576).toFixed(1)} MB</p>` : ""}
    </div>`;

  app.querySelector("#install")?.addEventListener("click", async () => {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    viewSettings();
  });

  app.querySelectorAll("[name=provider]").forEach((radio) =>
    radio.addEventListener("change", async () => {
      await setMeta("aiProvider", radio.value);
      toast(radio.value === "gemini" ? "Using Gemini (free)" : "Using Claude");
      viewSettings();
    }));

  app.querySelector("#find-photos").addEventListener("click", (e) => {
    e.target.disabled = true;
    e.target.textContent = "Finding photos…";
    fillMissingPhotos({ manual: true });
  });

  // Runs one tiny real request with the selected AI and shows exactly what happened.
  app.querySelector("#test-ai").addEventListener("click", async () => {
    const msg = app.querySelector("#test-ai-msg");
    msg.textContent = "Testing…";
    try {
      const res = await photoQueries({ ...cfg, geminiKey: cfg.provider === "gemini" ? cfg.geminiKey : "" }, { title: "Spaghetti Bolognese", ingredientNames: ["beef mince", "tomatoes"] });
      msg.textContent = `✅ ${cfg.provider === "gemini" ? "Gemini" : "Claude"} works (replied: ${res.queries.join(", ")})`;
    } catch (err) {
      msg.textContent = `❌ ${err.message}`;
    }
  });

  wireKeyCard("gemini", "geminiKey", testGeminiKey);
  wireKeyCard("claude", "apiKey", testKey);

  app.querySelector("#reset-spend").addEventListener("click", async () => {
    await setMeta("spend", { total: 0, count: 0 });
    viewSettings();
  });

  app.querySelector("#backup").addEventListener("click", async () => {
    const blob = await exportBackup();
    const name = `recipe-book-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: "application/json" });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Recipe Book backup" });
      } else {
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
      await setMeta("lastBackup", new Date().toISOString());
      viewSettings();
    } catch (err) {
      if (err.name !== "AbortError") toast(`Backup failed: ${err.message}`);
    }
  });
  app.querySelector("#restore").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm("Add the recipes from this backup to this phone? Recipes that exist in both are replaced by the backup's version. Nothing else is deleted.")) return;
    try {
      const { recipes } = await importBackup(file);
      state.stores = (await api("/api/stores")).stores;
      toast(`Restored ${recipes} recipe${recipes === 1 ? "" : "s"}`);
      refreshShoppingBadge();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- editor (new, imported draft, or existing) ----------
function draftBanner() {
  const li = state.lastImport;
  if (!li) return "";
  let retry = "";
  if (li.kind === "free") {
    retry = `<button type="button" class="btn small" id="retry">Read it with AI instead</button>`;
  } else if (li.tier === "cheap") {
    retry = li.provider === "gemini"
      ? `<button type="button" class="btn small" id="retry">Not right? Try harder (free)</button>`
      : `<button type="button" class="btn small" id="retry">Not right? Try harder with ${MODELS.strong.label} (~5–10¢)</button>`;
  }
  const estimates = state.draft?.ingredients?.filter((i) => i.estimated).length || 0;
  const how = li.kind === "free" ? "Parsed for free" : `Read by ${li.model} · ${li.cost === 0 ? "free" : `about ${formatCost(li.cost)}`}`;
  return `<div class="notice"><div>Here's what ${li.kind === "free" ? "the quick parser" : li.provider === "gemini" ? "Gemini" : "Claude"} found. Fix anything that's off, then save.</div>
    ${estimates ? `<div style="font-size:13px;margin-top:4px"><b>≈</b> ${estimates} amount${estimates === 1 ? " wasn't" : "s weren't"} given in the source, so ${estimates === 1 ? "it was" : "they were"} estimated. Check ${estimates === 1 ? "it" : "them"} below.</div>` : ""}
    <div class="muted" style="font-size:13px;margin:4px 0 8px">${how}</div>${retry}</div>`;
}

async function viewEditor(id) {
  let recipe;
  if (id) recipe = await api(`/api/recipes/${id}`);
  else recipe = state.draft || { title: "", ingredients: [], steps: [], tags: [] };
  const isDraft = !id && Boolean(state.draft);
  document.title = id ? `Edit ${recipe.title}` : "New recipe";

  recipe = structuredClone(recipe);
  if (!recipe.ingredients.length) recipe.ingredients.push({ quantity: null, unit: "", name: "", note: "" });
  if (!recipe.steps.length) recipe.steps.push({ text: "", timerMinutes: null });

  const v = (x) => (x == null ? "" : esc(x));

  app.innerHTML = `
    <a class="btn ghost small" href="${id ? `#/recipe/${id}` : "#/"}">${icon.back} ${id ? "Back" : "Cancel"}</a>
    <h1 style="margin-top:12px">${id ? "Edit recipe" : isDraft ? "Review import" : "New recipe"}</h1>
    ${isDraft ? draftBanner() : ""}
    <form id="ed" autocomplete="off">
      <div class="card panel">
        <label class="field">Title<input class="input" name="title" value="${v(recipe.title)}" required></label>
        <label class="field">Description<textarea class="input" name="description" rows="2">${v(recipe.description)}</textarea></label>
        <div class="cover-edit">
          <div class="prev" id="cover-prev">${recipe.image ? `<img src="${esc(recipe.image)}" alt="">` : ""}</div>
          <label class="btn small">Cover photo<input type="file" id="cover" accept="image/*" hidden></label>
          <button type="button" class="btn small ghost" id="cover-rm" ${recipe.image ? "" : "hidden"}>Remove</button>
        </div>
        <div class="edit-grid">
          <label class="field">Servings<input class="input" name="servings" type="number" min="0" step="any" inputmode="decimal" value="${v(recipe.servings)}"></label>
          <label class="field">Prep (min)<input class="input" name="prepMinutes" type="number" min="0" inputmode="numeric" value="${v(recipe.prepMinutes)}"></label>
          <label class="field">Cook (min)<input class="input" name="cookMinutes" type="number" min="0" inputmode="numeric" value="${v(recipe.cookMinutes)}"></label>
          <label class="field">Total (min)<input class="input" name="totalMinutes" type="number" min="0" inputmode="numeric" value="${v(recipe.totalMinutes)}"></label>
        </div>
        <label class="field">Tags (comma separated)<input class="input" name="tags" value="${v(recipe.tags.join(", "))}" placeholder="dinner, chicken, quick"></label>
        <label class="field">Source<input class="input" name="source" value="${v(recipe.source)}" placeholder="Website, cookbook, Grandma…"></label>
      </div>

      <h2>Ingredients</h2>
      <div class="card panel">
        <div class="erow muted" style="font-size:12px;font-weight:700"><span>Qty</span><span>Unit</span><span>Ingredient</span><span></span></div>
        <div id="ings"></div>
        <button type="button" class="btn small" id="add-ing">${icon.plus} Ingredient</button>
      </div>

      <h2>Steps</h2>
      <div class="card panel">
        <div id="steps-ed"></div>
        <button type="button" class="btn small" id="add-step">${icon.plus} Step</button>
      </div>

      <h2>Notes</h2>
      <div class="card panel"><textarea class="input" name="notes" rows="4" placeholder="Tips, substitutions, how it turned out…">${v(recipe.notes)}</textarea></div>

      <div class="sticky-save">
        ${id ? `<button type="button" class="btn danger" id="del">${icon.trash} Delete</button><span class="spacer"></span>` : ""}
        <button class="btn primary" id="save">Save recipe</button>
      </div>
    </form>`;

  const ings = app.querySelector("#ings");
  const stepsEl = app.querySelector("#steps-ed");

  app.querySelector("#retry")?.addEventListener("click", async (e) => {
    const { kind, payload, tier } = state.lastImport;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Reading again…";
    try {
      if (kind === "free") await runAI("text", payload, "cheap");
      else await runAI(kind, payload, "strong");
      viewEditor(null);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });

  // Read current inputs back into `recipe` so re-renders (add/remove rows) don't lose typing.
  function collect() {
    ings.querySelectorAll("[data-i]").forEach((row) => {
      const ing = recipe.ingredients[row.dataset.i];
      const qInput = row.querySelector("[name=q]");
      if (qInput.value !== qInput.dataset.orig) ing.estimated = false; // you set it yourself
      ing.quantity = qInput.value;
      ing.unit = row.querySelector("[name=u]").value;
      ing.name = row.querySelector("[name=n]").value;
      ing.note = row.querySelector("[name=no]").value;
    });
    stepsEl.querySelectorAll("[data-s]").forEach((row) => {
      const s = recipe.steps[row.dataset.s];
      s.text = row.querySelector("textarea").value;
      s.timerMinutes = row.querySelector("input").value;
    });
  }

  function renderRows() {
    ings.innerHTML = recipe.ingredients.map((ing, i) => `
      <div data-i="${i}" style="margin-bottom:10px">
        ${ing.section && ing.section !== recipe.ingredients[i - 1]?.section ? `<div class="ing-section">${esc(ing.section)}</div>` : ""}
        <div class="erow">
          <input class="input${ing.estimated ? " est" : ""}" name="q" inputmode="decimal" value="${v(ing.quantity)}" data-orig="${v(ing.quantity)}" placeholder="1" ${ing.estimated ? 'title="Estimated by AI"' : ""}>
          <input class="input" name="u" value="${v(ing.unit)}" placeholder="cup">
          <input class="input" name="n" value="${v(ing.name)}" placeholder="flour">
          <button type="button" class="iconbtn" data-rm-ing="${i}" aria-label="Remove">${icon.close}</button>
          <input class="input note-in" name="no" value="${v(ing.note)}" placeholder="note (optional)">
          ${ing.estimated ? '<span class="est-tag">≈ amount estimated by AI — edit it to confirm</span>' : ""}
        </div>
      </div>`).join("");
    stepsEl.innerHTML = recipe.steps.map((s, i) => `
      <div class="estep" data-s="${i}">
        <span class="n">${i + 1}</span>
        <div>
          <textarea class="input" rows="3" placeholder="What to do…">${v(s.text)}</textarea>
          <label class="timer-in">⏱ Timer <input class="input" type="number" min="0" step="any" inputmode="decimal" value="${v(s.timerMinutes)}" placeholder="—"> min</label>
        </div>
        <button type="button" class="iconbtn" data-rm-step="${i}" aria-label="Remove step">${icon.close}</button>
      </div>`).join("");
  }
  renderRows();

  app.querySelector("#add-ing").addEventListener("click", () => {
    collect();
    recipe.ingredients.push({ quantity: null, unit: "", name: "", note: "", section: recipe.ingredients.at(-1)?.section || "" });
    renderRows();
    ings.querySelector(`[data-i="${recipe.ingredients.length - 1}"] [name=n]`).focus();
  });
  app.querySelector("#add-step").addEventListener("click", () => {
    collect();
    recipe.steps.push({ text: "", timerMinutes: null });
    renderRows();
    stepsEl.querySelector(`[data-s="${recipe.steps.length - 1}"] textarea`).focus();
  });
  app.querySelector("#ed").addEventListener("click", (e) => {
    const ri = e.target.closest("[data-rm-ing]");
    const rs = e.target.closest("[data-rm-step]");
    if (!ri && !rs) return;
    collect();
    if (ri) recipe.ingredients.splice(Number(ri.dataset.rmIng), 1);
    if (rs) recipe.steps.splice(Number(rs.dataset.rmStep), 1);
    renderRows();
  });

  app.querySelector("#cover").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = await resizeImage(file, 1400);
    const { url } = await api("/api/images", { method: "POST", body: { blob: img.blob } });
    recipe.image = url;
    recipe.imageCredit = "";
    app.querySelector("#cover-prev").innerHTML = `<img src="${url}" alt="">`;
    app.querySelector("#cover-rm").hidden = false;
  });
  app.querySelector("#cover-rm").addEventListener("click", () => {
    recipe.image = null;
    recipe.photoSearched = true;
    app.querySelector("#cover-prev").innerHTML = "";
    app.querySelector("#cover-rm").hidden = true;
  });

  app.querySelector("#del")?.addEventListener("click", async () => {
    if (!confirm(`Delete “${recipe.title}”? This can't be undone.`)) return;
    await api(`/api/recipes/${id}`, { method: "DELETE" });
    toast("Recipe deleted");
    location.hash = "#/";
  });

  app.querySelector("#ed").addEventListener("submit", async (e) => {
    e.preventDefault();
    collect();
    const fd = new FormData(e.target);
    const body = {
      ...recipe,
      title: fd.get("title"),
      description: fd.get("description"),
      servings: fd.get("servings"),
      prepMinutes: fd.get("prepMinutes"),
      cookMinutes: fd.get("cookMinutes"),
      totalMinutes: fd.get("totalMinutes"),
      tags: String(fd.get("tags")).split(",").map((t) => t.trim()).filter(Boolean),
      source: fd.get("source") || null,
      notes: fd.get("notes"),
      ingredients: recipe.ingredients.map((i) => ({
        ...i,
        quantity: parseQty(i.quantity),
      })),
    };
    const btn = app.querySelector("#save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const saved = id
        ? await api(`/api/recipes/${id}`, { method: "PUT", body })
        : await api("/api/recipes", { method: "POST", body });
      state.draft = null;
      state.lastImport = null;
      toast("Saved");
      if (!saved.image && !saved.photoSearched) setTimeout(fillMissingPhotos, 500);
      location.hash = `#/recipe/${saved.id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = "Save recipe";
    }
  });
}

// ---------- shopping list ----------
async function viewShopping() {
  document.title = "Shopping list";
  let items = await api("/api/shopping");
  const AISLE_ORDER = ["Produce", "Meat & Seafood", "Dairy & Eggs", "Bakery", "Pantry", "Spices", "Frozen", "Drinks", "Other"];

  function render() {
    const open = items.filter((i) => !i.checked).length;
    const groups = new Map();
    for (const it of items) {
      const key = it.store || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const keys = [...groups.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    const sortItems = (list) =>
      list.sort((a, b) =>
        a.checked - b.checked ||
        AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle) ||
        a.name.localeCompare(b.name));

    app.innerHTML = `
      <div class="row">
        <a class="btn ghost small" href="#/">${icon.back} Recipes</a>
        <span class="spacer"></span>
        ${items.length ? `<button class="btn small" id="share">Share</button>
        <button class="btn small" id="clear" ${items.some((i) => i.checked) ? "" : "disabled"}>Clear checked</button>` : ""}
      </div>
      <h1 style="margin-top:12px">Shopping list</h1>
      <p class="muted" style="margin:0">${open} to get${items.length - open ? ` · ${items.length - open} in the cart` : ""}</p>
      <form class="add-item" id="add">
        <input class="input" name="name" placeholder="Add an item (e.g. 2 lb chicken thighs)">
        <button class="btn primary">${icon.plus}<span class="desktop-only">Add</span></button>
      </form>
      ${items.length ? keys.map((k) => {
        const list = sortItems(groups.get(k));
        const left = list.filter((i) => !i.checked).length;
        return `<section class="store-group">
          <h2>${k ? `🏪 ${esc(k)}` : "📍 No store picked yet"} <span class="count">${left} left</span></h2>
          <div class="card">${list.map((it) => {
            const qty = [formatQty(it.quantity), it.unit].filter(Boolean).join(" ");
            return `<div class="sitem ${it.checked ? "checked" : ""}" data-id="${it.id}">
              <input type="checkbox" ${it.checked ? "checked" : ""} aria-label="Got it">
              <div>
                <div class="name">${qty ? `<b>${esc(qty)}</b> ` : ""}${esc(it.name)}</div>
                ${it.recipes.length ? `<div class="from">for ${esc(it.recipes.join(", "))}</div>` : ""}
              </div>
              <div class="row" style="gap:2px;flex-wrap:nowrap">${storeSelect(it.store, "data-store")}
                <button class="iconbtn" data-del aria-label="Remove">${icon.close}</button></div>
            </div>`;
          }).join("")}</div></section>`;
      }).join("") : `<div class="empty"><h2>Your list is empty</h2><p>Open a recipe, tap <b>Ingredients</b>, and add what you need.</p></div>`}
      <details style="margin-top:24px"><summary class="muted">Manage stores</summary>
        <div class="card panel" style="margin-top:8px">
          ${state.stores.map((s) => `<div class="row" style="padding:4px 0"><span>${esc(s)}</span><span class="spacer"></span><button class="iconbtn" data-rm-store="${esc(s)}" aria-label="Remove store">${icon.close}</button></div>`).join("") || '<p class="muted">No stores yet.</p>'}
          <form class="row" id="add-store" style="margin-top:8px"><input class="input" name="store" placeholder="New store" style="flex:1"><button class="btn">Add</button></form>
        </div>
      </details>`;
  }
  render();

  async function updateItem(id, patch) {
    const it = items.find((i) => i.id === id);
    Object.assign(it, patch);
    render();
    await api(`/api/shopping/${id}`, { method: "PATCH", body: patch });
    refreshShoppingBadge();
  }

  app.addEventListener("change", onChange);
  app.addEventListener("click", onClick);
  app.addEventListener("submit", onSubmit);
  // These listeners live on #app, so detach them when we navigate away.
  window.addEventListener("hashchange", () => {
    app.removeEventListener("change", onChange);
    app.removeEventListener("click", onClick);
    app.removeEventListener("submit", onSubmit);
  }, { once: true });

  async function onChange(e) {
    const row = e.target.closest(".sitem");
    if (!row) return;
    if (e.target.type === "checkbox") return updateItem(row.dataset.id, { checked: e.target.checked });
    if (e.target.matches("[data-store]")) {
      const it = items.find((i) => i.id === row.dataset.id);
      const store = resolveStoreChoice(e.target, it.store);
      if (store === null) return;
      // Remember it for next time, and re-file other unchecked items with the same name.
      await api("/api/ingredient-store", { method: "PUT", body: { name: it.name, store } });
      items = await api("/api/shopping");
      render();
    }
  }

  async function onClick(e) {
    const row = e.target.closest(".sitem");
    if (row && e.target.closest("[data-del]")) {
      items = items.filter((i) => i.id !== row.dataset.id);
      render();
      await api(`/api/shopping/${row.dataset.id}`, { method: "DELETE" });
      return refreshShoppingBadge();
    }
    if (e.target.closest("#clear")) {
      items = await api("/api/shopping/clear", { method: "POST", body: {} });
      render();
      return refreshShoppingBadge();
    }
    if (e.target.closest("#share")) {
      const text = items.filter((i) => !i.checked)
        .map((i) => `• ${[formatQty(i.quantity), i.unit, i.name].filter(Boolean).join(" ")}${i.store ? ` (${i.store})` : ""}`)
        .join("\n");
      if (navigator.share) navigator.share({ title: "Shopping list", text }).catch(() => {});
      else {
        await navigator.clipboard.writeText(text);
        toast("Copied to clipboard");
      }
      return;
    }
    const rmStore = e.target.closest("[data-rm-store]");
    if (rmStore) {
      state.stores = state.stores.filter((s) => s !== rmStore.dataset.rmStore);
      await api("/api/stores", { method: "PUT", body: { stores: state.stores } });
      render();
      app.querySelector("details").open = true;
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (e.target.id === "add") {
      const raw = new FormData(e.target).get("name").trim();
      if (!raw) return;
      // "2 lb chicken thighs" -> quantity 2, unit lb, name chicken thighs
      const m = raw.match(/^([\d.\/½¼¾⅓⅔⅛ ]+)\s*(cups?|tbsp|tsp|lbs?|oz|g|kg|ml|l|cans?|packs?|bags?|bunch(?:es)?|dozen)?\s+(.+)$/i);
      const item = m ? { quantity: parseQty(m[1]), unit: m[2] || "", name: m[3] } : { name: raw };
      await api("/api/shopping", { method: "POST", body: { items: [item] } });
      items = await api("/api/shopping");
      render();
      app.querySelector("#add [name=name]").focus();
      refreshShoppingBadge();
    } else if (e.target.id === "add-store") {
      const name = new FormData(e.target).get("store").trim();
      if (!name || state.stores.includes(name)) return;
      state.stores.push(name);
      await api("/api/stores", { method: "PUT", body: { stores: state.stores } });
      render();
      app.querySelector("details").open = true;
    }
  }
}

// ---------- automatic photos for recipes without one ----------
let fillingPhotos = false;

// AI steps are optional: if the AI fails, fall back to the title search and the best-scoring photo.
async function autoPhoto(recipe, notes) {
  const cfg = await aiConfig();
  const hasAI = Boolean(cfg.geminiKey || cfg.claudeKey);
  let queries = queriesFromTitle(recipe.title);
  if (hasAI) {
    try {
      const res = await photoQueries(cfg, recipe);
      if (res.cost) await addSpend(res.cost);
      if (res.queries.length) queries = res.queries;
    } catch (err) {
      notes.aiError = err.message;
    }
  }
  const candidates = await findPhotos(queries, { limit: 8 });
  if (!candidates.length) return null;
  let choice = candidates[0];
  if (hasAI && !notes.aiError) {
    try {
      const previews = await previewsFor(candidates);
      if (previews.length) {
        const res = await pickPhoto(cfg, recipe, previews);
        if (res.cost) await addSpend(res.cost);
        choice = res.index == null ? null : previews[res.index].candidate;
      }
    } catch (err) {
      notes.aiError = err.message;
    }
  }
  if (!choice) return null;
  const { url } = await api("/api/images", { method: "POST", body: { blob: await downloadPhoto(choice) } });
  return { url, credit: choice.credit };
}

// Finds photos for recipes that don't have one, showing progress. A problem with one recipe
// skips it (and it's retried next time); losing the connection stops the run.
async function fillMissingPhotos({ manual = false } = {}) {
  if (fillingPhotos) return;
  if (!navigator.onLine) {
    if (manual) toast("You're offline. Photos need an internet connection.");
    return;
  }
  const todo = (await api("/api/recipes")).filter((r) => !r.image && !r.photoSearched);
  if (!todo.length) {
    if (manual) toast("Every recipe already has a photo.");
    return;
  }
  fillingPhotos = true;
  const notes = {};
  let found = 0;
  let failed = 0;
  let lastError = "";
  try {
    for (const [n, r] of todo.entries()) {
      toast(`Finding photos ${n + 1}/${todo.length}…`);
      try {
        const photo = await autoPhoto(r, notes);
        // No photo while the AI was failing: leave it unmarked so it's retried once the AI works.
        if (photo || !notes.aiError) {
          await api(`/api/recipes/${r.id}`, {
            method: "PUT",
            body: photo ? { image: photo.url, imageCredit: photo.credit, photoSearched: true } : { photoSearched: true },
          });
        }
        if (photo) {
          found++;
          const thumb = document.querySelector(`a.rcard[href="#/recipe/${r.id}"] .thumb`);
          if (thumb) thumb.outerHTML = `<div class="thumb"><img src="${esc(photo.url)}" alt="" loading="lazy"></div>`;
        }
      } catch (err) {
        failed++;
        lastError = err.message;
        if (!navigator.onLine || err instanceof TypeError) break; // network gone
      }
    }
  } finally {
    fillingPhotos = false;
  }
  await setMeta("photoStatus", {
    at: new Date().toISOString(), found, failed,
    error: lastError || (notes.aiError ? `AI step skipped: ${notes.aiError}` : ""),
  });
  if (found || failed) {
    toast(found ? `Added photos to ${found} recipe${found === 1 ? "" : "s"}${failed ? ` (${failed} failed, see Settings)` : ""}` : "Couldn't add photos. See Settings → Photos.");
  }
  if (location.hash === "#/settings") viewSettings();
}

// ---------- boot ----------
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  requestPersistence();
  try {
    state.stores = (await api("/api/stores")).stores;
  } catch {}
  refreshShoppingBadge();
  window.addEventListener("hashchange", router);
  router();
  setTimeout(fillMissingPhotos, 1500);
}
boot();
