/* Service worker — caches the app shell so it opens instantly and offline.
   Never caches API calls to Apps Script.

   Updating safely: index.html loads app.js?v=<VERSION>, so a page can only ever run the code
   it was released with. The shell is fetched with cache: 'reload' (bypassing the browser's own
   cache), and the page itself is network-first, so a new release shows on the next open. */

const VERSION = '20';
const CACHE = 'receipts-v' + VERSION;
const SHELL = ['./', './index.html', './app.js?v=' + VERSION, './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first for the page (with a short wait, then the cached copy), so updates arrive at once
function pageFirst(req) {
  return new Promise(resolve => {
    let done = false;
    const fromCache = () => caches.match(req).then(hit => hit || caches.match('./index.html'));
    const timer = setTimeout(() => { if (!done) { done = true; fromCache().then(resolve); } }, 2500);
    fetch(new Request(req, { cache: 'no-cache' })).then(res => {
      if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(() => { if (!done) { done = true; clearTimeout(timer); fromCache().then(resolve); } });
  });
}

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET' || url.includes('script.google.com')) return;
  if (e.request.mode === 'navigate') { e.respondWith(pageFirst(e.request)); return; }

  // Everything else: cached copy first (versioned URLs never go stale), refreshed in the background
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(new Request(e.request, { cache: 'no-cache' })).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
