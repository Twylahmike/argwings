// RG Wings Stays service worker: makes the site installable and keeps the public pages usable on a weak connection.
// Safe by design: it never stores or serves anything private (admin, bookings, receipts, login, API calls).
// Bump VERSION when this file's behaviour changes: old caches are deleted on activate. Built assets have hashed names, so they never go stale.
const VERSION = 'v2'
const MAX_STATIC = 200
const STATIC = `static-${VERSION}`
const PAGES = `pages-${VERSION}`
// The offline page lives inside the worker so it works whatever the host does to /offline.html (it redirects).
const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline · RG Wings Stays</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f7f1ec;color:#1c1a17;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:500;font-size:2.25rem;margin:0 0 8px}p{margin:0 0 20px;color:#555}
button{height:44px;padding:0 24px;border:0;border-radius:8px;background:#a9761f;color:#fff;font-size:1rem}
@media (prefers-color-scheme:dark){body{background:#131211;color:#f1ece4}p{color:#b8b0a4}}</style></head>
<body><main><h1>You are offline</h1><p>Check your connection and try again. Pages you opened before may still be available.</p><button onclick="location.reload()">Try again</button></main></body></html>`
const offline = () => new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
const PRIVATE = /^\/(admin|booking|receipt|request|login|account|auth|forgot-password|reset-password|api)(\/|$)/

// Keep the asset cache bounded: drop the oldest entries beyond MAX_STATIC.
function trim(cache) {
  return cache.keys().then((keys) => (keys.length > MAX_STATIC ? Promise.all(keys.slice(0, keys.length - MAX_STATIC).map((k) => cache.delete(k))) : undefined))
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.add('/app-icon-192.png')).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![STATIC, PAGES].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // Supabase, functions, maps, images elsewhere: leave to the network
  if (PRIVATE.test(url.pathname)) return // never cache anything private

  // Built assets have hashed names, so cache-first is safe.
  if (url.pathname.startsWith('/assets/') || /\.(?:png|webp|jpg|jpeg|svg|ico|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(STATIC).then((c) => c.put(req, copy).then(() => trim(c))) }
        return res
      })),
    )
    return
  }

  // Public pages: network first, fall back to the last copy, then to the offline page.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(PAGES).then((c) => c.put(req, copy)) }
        return res
      }).catch(() => caches.match(req).then((hit) => hit || offline())),
    )
  }
})
