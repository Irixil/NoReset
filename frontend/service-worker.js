const CACHE = 'bingli-beta-shell-v53-source-version';
const CACHE_PREFIX = 'bingli-beta-shell-';
const SHELL = ['/', '/styles.css', '/ios.css', '/splash.css', '/runtime-config.js', '/config.js', '/local-store-core.js', '/safety.js', '/local-store.js', '/app.js', '/media.js', '/splash.js', '/assets/brand-mascot.png', '/manifest.webmanifest'];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('install', event => {
  // A new shell must fetch this build, not reuse the HTTP cache of an older build.
  const requests = SHELL.map(path => new Request(new URL(path, self.location.origin), { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const isNavigationShell = request.mode === 'navigate' && url.pathname === '/';
  const isStaticShell = request.mode !== 'navigate' && url.pathname !== '/' && SHELL_PATHS.has(url.pathname);
  if (!isNavigationShell && !isStaticShell) return;

  // Query-busted shell URLs are never stored under their parameterized URL.
  // Their pathname may use the already-installed, allowlisted shell entry
  // when the network is unavailable.
  const cacheKey = url.pathname;
  let cacheWrite = Promise.resolve();
  const responsePromise = (async () => {
    try {
      const response = await fetch(request);
      const expectedSameOriginResponse = response?.status === 200 && response.ok === true &&
        (response.type === 'basic' || response.type === 'default') && response.redirected !== true;
      if (expectedSameOriginResponse && !url.search) {
        const cacheCopy = response.clone();
        cacheWrite = (async () => {
          const cache = await caches.open(CACHE);
          await cache.put(cacheKey, cacheCopy);
        })().catch(() => {
          // Keep a successful network response usable even when Cache Storage fails.
        });
      }
      return response;
    } catch {
      try {
        const cache = await caches.open(CACHE);
        return await cache.match(cacheKey) || Response.error();
      } catch {
        return Response.error();
      }
    }
  })();

  event.respondWith(responsePromise);
  event.waitUntil(responsePromise.then(() => cacheWrite, () => undefined));
});
