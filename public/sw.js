/* MR//ROOM PWA shell — intentionally excludes account, API and media responses. */
"use strict";

const CACHE_PREFIX = "mrroom-shell-";
const CACHE_VERSION = "20260801-pwa-v7";
const CORE_CACHE_NAME = `${CACHE_PREFIX}core-${CACHE_VERSION}`;
const RUNTIME_CACHE_NAME = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const CORE_ASSETS = [
  "/manifest.webmanifest",
  "/offline.html",
  "/pwa-register.js?v=20260801-v1",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
  "/apple-touch-icon.png",
  "/mineradio-card-art.png",
  "/mineradio-starfield.png",
  "/classic/index.html",
  "/classic/vendor/qrcode.min.js?v=1.5.4",
  "/classic/room-sync-core.js?v=20260801-adaptive-v2",
  "/classic/classic-web-bridge.js?v=20260801-sync-v6",
  "/classic/cover-pipeline.js?v=20260801-v1",
  "/classic/sonic-terrain.js?v=20260801-voxel-v5",
  "/classic/playback-recovery.js?v=20260730-v2",
  "/classic/vendor/three.r128.min.js",
  "/classic/vendor/music-tempo.min.js",
  "/classic/vendor/gsap.min.js",
];
const STATIC_DESTINATIONS = new Set(["font", "image", "script", "style", "worker"]);
const MAX_RUNTIME_ENTRIES = 120;
let explicitUpdateActivation = false;

function cacheKeyForNavigation(url) {
  if (url.pathname.startsWith("/classic/")) {
    return new Request("/classic/index.html");
  }
  return new Request(url.pathname || "/");
}

function isSensitiveOrStreamingRequest(request, url) {
  if (request.headers.has("range")) return true;
  if (request.destination === "audio" || request.destination === "video") return true;
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/.well-known/mr-room/") ||
    url.pathname.startsWith("/__mineradio/") ||
    url.pathname.startsWith("/track/") ||
    url.pathname.startsWith("/upload/") ||
    url.pathname.startsWith("/events/") ||
    url.pathname.startsWith("/auth/")
  );
}

function isStaticAsset(request, url) {
  return (
    STATIC_DESTINATIONS.has(request.destination) ||
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/classic/") ||
    /\.(?:css|gif|ico|jpe?g|js|mjs|png|svg|webmanifest|webp|woff2?)$/i.test(url.pathname)
  );
}

async function putSafe(cache, key, response) {
  if (!response || !response.ok || response.type !== "basic") return;
  try {
    await cache.put(key, response.clone());
  } catch {
    // A valid network response must never be turned into a playback/UI failure
    // merely because the browser declined to persist it.
  }
}

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_RUNTIME_ENTRIES) return;
  await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map((key) => cache.delete(key)));
}

async function precacheCore() {
  const cache = await caches.open(CORE_CACHE_NAME);
  await Promise.all(
    CORE_ASSETS.map(async (asset) => {
      const request = new Request(asset, { cache: "reload" });
      const response = await fetch(request);
      if (!response.ok || response.type !== "basic") {
        throw new Error(`core_asset_unavailable:${asset}`);
      }
      await cache.put(request, response);
    }),
  );
}

async function networkFirstNavigation(request) {
  const runtimeCache = await caches.open(RUNTIME_CACHE_NAME);
  const coreCache = await caches.open(CORE_CACHE_NAME);
  const url = new URL(request.url);
  const fallbackKey = cacheKeyForNavigation(url);

  try {
    const response = await fetch(request);
    await putSafe(runtimeCache, fallbackKey, response);
    return response;
  } catch {
    const cached =
      await runtimeCache.match(fallbackKey)
      || await coreCache.match(
        url.pathname.startsWith("/classic/") ? "/classic/index.html" : "/offline.html",
      );
    if (cached) return cached;
    return Response.error();
  }
}

async function cacheFirstStatic(request) {
  const coreCache = await caches.open(CORE_CACHE_NAME);
  const runtimeCache = await caches.open(RUNTIME_CACHE_NAME);
  const cached = await coreCache.match(request) || await runtimeCache.match(request);
  if (cached) {
    if (!(await coreCache.match(request))) {
      void fetch(request)
        .then(async (response) => {
          await putSafe(runtimeCache, request, response);
          await trimCache(runtimeCache);
        })
        .catch(() => undefined);
    }
    return cached;
  }

  const response = await fetch(request);
  await putSafe(runtimeCache, request, response);
  await trimCache(runtimeCache);
  return response;
}

self.addEventListener("install", (event) => {
  // Activation is requested by the page only while playback is idle. This
  // prevents mixed bridge versions without interrupting an in-flight barrier.
  event.waitUntil(precacheCore());
});

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "MRROOM_ACTIVATE_UPDATE") return;
  explicitUpdateActivation = true;
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(CACHE_PREFIX)
                && key !== CORE_CACHE_NAME
                && key !== RUNTIME_CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => (explicitUpdateActivation ? self.clients.claim() : undefined)),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isSensitiveOrStreamingRequest(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isStaticAsset(request, url)) {
    event.respondWith(cacheFirstStatic(request));
  }
});
