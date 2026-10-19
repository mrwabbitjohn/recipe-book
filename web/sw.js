// Service worker: makes the app work offline and receives things shared from Android's share menu.
// Bump VERSION when you deploy changes so phones pick up the new files.
const VERSION = "v13";
const APP_CACHE = `recipe-book-${VERSION}`;
const APP_FILES = [
  "./", "index.html", "styles.css", "app.js", "store.js", "localapi.js", "ai.js", "parse.js",
  "gemini.js", "photos.js", "vendor/anthropic-sdk.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("recipe-book-") && k !== APP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Park shared content in a cache, then open the import screen, which picks it up.
async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll("photos").filter((f) => f && f.size);
  await caches.delete("share-inbox");
  const inbox = await caches.open("share-inbox");
  await Promise.all(files.map((f, i) =>
    inbox.put(`file-${i}`, new Response(f, { headers: { "content-type": f.type || "image/jpeg" } }))));
  await inbox.put("meta", new Response(JSON.stringify({
    title: form.get("title") || "",
    text: form.get("text") || "",
    url: form.get("url") || "",
    fileCount: files.length,
  })));
  return Response.redirect(new URL("./#/import?shared=1", self.registration.scope).href, 303);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // Claude API calls, recipe photos: straight to network

  if (request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET") return;

  // Network first so updates show up right away; fall back to the cache when offline.
  // cache: "no-cache" makes the browser check with GitHub every time (a quick "has it changed?"),
  // instead of reusing its own copy for up to 10 minutes after we publish an update.
  event.respondWith(
    fetch(request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(request, { ignoreSearch: true })) || caches.match("index.html")),
  );
});
