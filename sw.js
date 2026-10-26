/* AQP Run-and-Grade — offline support (service worker)
 * Online: always loads the newest copy from the website (same as before).
 * Offline / no answer within a few seconds: opens the copy saved on this iPad.
 * Kill switch: set KILL = true and publish — every iPad drops the saved copies
 * and goes back to online-only on its next open with internet.
 */
var REPO = "mv";
var VERSION = "2026.10.26.1";
var KILL = false;
var CACHE = "aqp-offline-" + REPO + "-v1";
var TIMEOUT_MS = 4000;

self.addEventListener("install", function (e) { self.skipWaiting(); });

self.addEventListener("activate", function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) {
      return k.indexOf("aqp-offline-" + REPO + "-") === 0 && (KILL || k !== CACHE);
    }).map(function (k) { return caches.delete(k); }));
    if (KILL) { await self.registration.unregister(); return; }
    await self.clients.claim();
  })());
});

function keyOf(u) { var x = new URL(u, self.location.href); x.search = ""; x.hash = ""; return x.href; }
function skip(req) {
  if (req.method !== "GET") return true;
  var u = new URL(req.url);
  if (u.origin !== self.location.origin) return true;   // cloud sync, CDNs: untouched
  if (u.pathname.indexOf("/decks/") >= 0) return true;  // briefing slides: online only
  if (/\/sw\.js$/.test(u.pathname)) return true;
  return false;
}
function good(res) { return res && res.ok && res.type === "basic" && !res.redirected; }

async function notify(msg) {
  var cs = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  cs.forEach(function (c) { try { c.postMessage(msg); } catch (e) {} });
}

async function store(key, res) {
  try { var c = await caches.open(CACHE); await c.put(key, res); } catch (e) {}
}

self.addEventListener("fetch", function (e) {
  if (KILL || skip(e.request)) return;
  var req = e.request, key = keyOf(req.url);
  e.respondWith((async function () {
    var net = fetch(req, { cache: "no-store" }).then(function (res) {
      if (good(res)) {
        var copy = res.clone();
        try { e.waitUntil(store(key, copy)); } catch (x) { store(key, copy); }
      }
      return res;
    });
    var timedOut = false;
    var timer = new Promise(function (r) { setTimeout(function () { timedOut = true; r("timeout"); }, TIMEOUT_MS); });
    try {
      var first = await Promise.race([net, timer]);
      if (first !== "timeout") return first;
    } catch (err) { /* offline */ }
    var cached = await caches.match(key, { ignoreSearch: true });
    if (cached) {
      if (timedOut && req.mode === "navigate") {
        // Slow connection: show the saved copy now, finish the download in the background,
        // and tell the page if a newer version arrived.
        var oldText = cached.clone().text();
        e.waitUntil(net.then(async function (res) {
          if (!good(res)) return;
          var a = await oldText, b = await res.clone().text();
          if (a !== b) notify({ type: "aqp-updated" });
        }).catch(function () {}));
      }
      return cached;
    }
    return net;   // nothing saved yet — wait for the network
  })());
});

/* Page asks us to save the files the app needs (first open with internet). */
self.addEventListener("message", function (e) {
  var d = e.data || {};
  if (KILL || d.type !== "aqp-warm" || !Array.isArray(d.urls)) return;
  e.waitUntil((async function () {
    var c = await caches.open(CACHE), ok = 0;
    for (var i = 0; i < d.urls.length; i++) {
      var key = keyOf(d.urls[i]);
      try {
        if (await c.match(key)) { ok++; continue; }
        var res = await fetch(d.urls[i], { cache: "no-store" });
        if (good(res)) { await c.put(key, res); ok++; }
      } catch (err) {}
    }
    if (e.source) e.source.postMessage({ type: "aqp-warmed", optional: !!d.optional, ok: ok, total: d.urls.length, version: VERSION });
  })());
});
