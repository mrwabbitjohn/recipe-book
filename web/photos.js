// Finds a free, openly licensed photo of a dish via Openverse (mostly Flickr and Wikimedia photos).
// No key, no cost. Photos are downloaded and stored on the phone so they work offline.

const API = "https://api.openverse.org/v1/images/";

// Words that describe the recipe rather than the dish, and hurt photo searches.
const NOISE = /\b(easy|simple|quick|best|homemade|classic|perfect|ultimate|my|the|with|and|a|kick|style|takeaway|\d+-minute|minute|one-pot|weeknight|recipe|all-purpose)\b/gi;

// Fallback search phrases from the title when no AI is available.
export function queriesFromTitle(title) {
  const clean = (s) => s.replace(NOISE, " ").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const paren = title.match(/\(([^)]+)\)/)?.[1] || "";
  const words = clean(title.replace(/\([^)]*\)/g, " ")).split(" ");
  return [...new Set([words.slice(0, 3).join(" "), clean(paren), words.slice(-2).join(" ")])].filter((q) => q.length > 2);
}

async function search(q) {
  const params = new URLSearchParams({ q, page_size: "20", mature: "false", category: "photograph" });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Photo search failed (${res.status})`);
  return (await res.json()).results || [];
}

const credit = (r) => {
  // Openverse gives "by", "by-nc-sa", "cc0", "pdm" (public domain mark)…
  const code = String(r.license || "").toLowerCase();
  const license = !code ? ""
    : code === "pdm" ? "Public domain"
    : code === "cc0" ? "CC0"
    : `CC ${code.toUpperCase()}${r.license_version ? ` ${r.license_version}` : ""}`;
  return [r.creator ? `Photo: ${r.creator}` : "Photo", license].filter(Boolean).join(" · ") + " · via Openverse";
};

// Prefer results whose title/tags mention the search words, and reasonably large landscape photos.
function score(r, q) {
  const text = `${r.title || ""} ${(r.tags || []).map((t) => t.name).join(" ")}`.toLowerCase();
  const words = q.toLowerCase().split(" ").filter((w) => w.length > 2);
  const hits = words.filter((w) => text.includes(w)).length;
  return (words.length ? hits / words.length : 0) * 10 + (r.width >= 800 ? 1 : 0) + (r.width > r.height ? 1 : 0);
}

// Candidate photos for a list of search phrases (most specific first), best first.
// Takes a few from each phrase so one phrase can't fill the list with near-duplicates.
export async function findPhotos(queries, { limit = 12 } = {}) {
  const perQuery = Math.max(3, Math.ceil(limit / Math.max(1, queries.length)));
  const lists = await Promise.all(queries.map((q) =>
    search(q).then((rs) => rs.map((r) => ({ r, s: score(r, q) })).filter((x) => x.s >= 5).sort((a, b) => b.s - a.s)).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    let taken = 0;
    for (const { r } of list) {
      const key = (r.title || r.id).toLowerCase();
      if (taken >= perQuery || seen.has(r.id) || seen.has(key) || !r.thumbnail) continue;
      seen.add(r.id);
      seen.add(key);
      out.push({ id: r.id, thumb: r.thumbnail, url: r.url, title: r.title || "", credit: credit(r), page: r.foreign_landing_url || "" });
      taken++;
    }
  }
  return out.slice(0, limit);
}

async function shrink(blob, max) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || blob), "image/jpeg", 0.85));
  } catch {
    return blob;
  }
}

async function fetchImage(src) {
  const res = await fetch(src);
  const blob = await res.blob();
  if (!res.ok || !blob.type.startsWith("image/")) throw new Error("not an image");
  return blob;
}

// Downloads a candidate (full size if possible, else the preview) as a phone-sized JPEG blob.
export async function downloadPhoto(candidate) {
  for (const src of [candidate.url, candidate.thumb]) {
    try {
      return await shrink(await fetchImage(src), 1200);
    } catch {}
  }
  throw new Error("Couldn't download that photo. Try another one.");
}

// Small base64 previews for the AI to choose from.
export async function previewsFor(candidates) {
  const previews = await Promise.all(candidates.map(async (c) => {
    try {
      const blob = await shrink(await fetchImage(c.thumb), 384);
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      return { candidate: c, mediaType: "image/jpeg", data };
    } catch {
      return null;
    }
  }));
  return previews.filter(Boolean);
}
