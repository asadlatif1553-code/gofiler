/**
 * GoFiler Service Worker
 * Caches the app shell for full offline support.
 * Does NOT cache external CDN or WebLLM model files (they manage their own cache).
 */

const CACHE_NAME   = "gofiler-v24";
const OFFLINE_URL  = "/index.html";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon.svg",
  "/manifest.json"
];

/* ── URLs to never cache (WebLLM model files are huge — WebLLM manages its own cache) ── */
function isUncacheable(url) {
  return (
    url.includes("esm.run")      ||
    url.includes("esm.sh")       ||
    url.includes("mlc-ai")       ||
    url.includes("huggingface")  ||
    url.endsWith(".wasm")        ||
    url.endsWith(".bin")         ||
    url.includes("model-")       ||
    url.includes("Llama")        ||
    url.includes("tokenizer")    ||
    url.includes("ndarray-cache")
  );
  // Note: cdnjs.cloudflare.com and jsdelivr.net ARE cached (jsPDF, etc.)
}

/* ── Install: cache app shell ── */
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: delete old caches ── */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch ── */
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET and uncacheable external resources
  if (request.method !== "GET" || isUncacheable(url)) return;

  // API calls — network first, offline JSON fallback
  if (url.includes("/api/")) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ ok: false, offline: true, error: "You are offline. This feature requires the GoFiler server." }),
          { headers: { "Content-Type": "application/json" } }
        )
      )
    );
    return;
  }

  // HTML pages — network FIRST so updates are instant; fall back to cache when offline
  const isHTML = request.headers.get("accept")?.includes("text/html") ||
                 url.endsWith("/") || url.endsWith(".html");
  if (isHTML) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(c => c || caches.match(OFFLINE_URL)))
    );
    return;
  }

  // Static assets (JS, CSS, images, fonts) — cache first, update in background
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(response => {
        if (response && response.status === 200 && response.type !== "opaque") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
      return cached || networkFetch;
    }).catch(() => caches.match(OFFLINE_URL))
  );
});

/* ── Handle shortcut URL params (tab deep links) ── */
self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
