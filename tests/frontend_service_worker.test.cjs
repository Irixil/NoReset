const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/service-worker.js'), 'utf8');

function createWorker({ fetchImpl = async () => new Response('network'), putImpl, cacheNames = [] } = {}) {
  const listeners = new Map();
  const entries = new Map();
  const deleted = [];
  const writes = [];
  let precached = [];
  const cache = {
    async addAll(paths) {
      assert.ok(paths.every(request => request.cache === 'reload'), 'new versions bypass stale HTTP cache');
      precached = Array.from(paths, request => new URL(request.url).pathname);
      for (const key of precached) if (!entries.has(key)) entries.set(key, new Response(`precache:${key}`));
    },
    async put(key, response) {
      writes.push(key);
      if (putImpl) return putImpl(key, response);
      entries.set(key, response);
    },
    async match(key) {
      const response = entries.get(key);
      return response?.clone();
    },
  };
  const caches = {
    async open() { return cache; },
    async keys() { return [...cacheNames]; },
    async delete(key) { deleted.push(key); return true; },
  };
  const self = {
    location: { origin: 'https://app.test' },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  const context = vm.createContext({ URL, Request, Response, caches, fetch: fetchImpl, self });
  vm.runInContext(source, context, { filename: 'frontend/service-worker.js' });

  function dispatch(name, request) {
    const lifetime = [];
    const event = {
      request,
      respondWith(promise) { this.response = Promise.resolve(promise); },
      waitUntil(promise) { lifetime.push(Promise.resolve(promise)); },
    };
    listeners.get(name)(event);
    return { response: event.response, lifetime: Promise.all(lifetime), lifetimeCount: lifetime.length };
  }

  return { cache, caches, deleted, entries, precached: () => precached, writes, dispatch };
}

function request(pathname, { method = 'GET', origin = 'https://app.test', mode = 'cors' } = {}) {
  return { method, url: `${origin}${pathname}`, mode };
}

async function installShell(worker) {
  await worker.dispatch('install', undefined).lifetime;
}

test('pre-caches only the declared shell and activation preserves unrelated origin caches', async () => {
  const worker = createWorker({ cacheNames: ['bingli-beta-shell-v21-old', 'other-app-cache', 'bingli-beta-shell-v22-record-trash', 'bingli-beta-shell-v23-audit'] });
  await worker.dispatch('install', undefined).lifetime;
  assert.deepEqual(worker.precached(), [
    '/', '/styles.css', '/ios.css', '/splash.css', '/runtime-config.js', '/config.js', '/local-store-core.js',
    '/safety.js', '/local-store.js', '/app.js', '/media.js', '/splash.js',
    '/assets/brand-mascot.png', '/manifest.webmanifest',
  ]);

  const activation = worker.dispatch('activate', undefined);
  await activation.lifetime;
  assert.deepEqual(worker.deleted, ['bingli-beta-shell-v21-old', 'bingli-beta-shell-v22-record-trash', 'bingli-beta-shell-v23-audit']);
});

test('only same-origin shell requests are intercepted; API, health, and other paths pass through', () => {
  const worker = createWorker();
  for (const path of ['/health', '/api/events', '/api/media/1', '/settings.json', '/other.js', '/styles.css.map']) {
    assert.equal(worker.dispatch('fetch', request(path)).response, undefined, path);
  }
  assert.equal(worker.dispatch('fetch', request('/app.js', { method: 'POST' })).response, undefined);
  assert.equal(worker.dispatch('fetch', request('/app.js', { origin: 'https://other.test' })).response, undefined);
});

test('caches successful shell responses, waits for cache work, and keeps query variants out of storage', async () => {
  let startPut;
  let finishPut;
  const putStarted = new Promise(resolve => { startPut = resolve; });
  const putGate = new Promise(resolve => { finishPut = resolve; });
  const worker = createWorker({
    fetchImpl: async () => new Response('fresh app'),
    putImpl: async (key, response) => { startPut(); await putGate; worker.entries.set(key, response); },
  });
  await installShell(worker);
  const event = worker.dispatch('fetch', request('/app.js'));
  assert.equal(event.lifetimeCount, 1);
  const response = await event.response;
  assert.equal(await response.text(), 'fresh app');
  await putStarted;
  let lifetimeDone = false;
  event.lifetime.then(() => { lifetimeDone = true; });
  await Promise.resolve();
  assert.equal(lifetimeDone, false, 'waitUntil must include the pending cache write');
  finishPut();
  await event.lifetime;
  assert.equal(lifetimeDone, true);
  assert.equal(worker.writes.length, 1);
  assert.equal(worker.writes[0], '/app.js');
  assert.equal(await (await worker.cache.match('/app.js')).text(), 'fresh app');

  const queryWorker = createWorker({ fetchImpl: async () => new Response('versioned response') });
  await installShell(queryWorker);
  const queryEvent = queryWorker.dispatch('fetch', request('/app.js?build=secret'));
  await queryEvent.response;
  await queryEvent.lifetime;
  assert.deepEqual(queryWorker.writes, []);
  assert.equal(queryWorker.entries.has('/app.js?build=secret'), false);
});

test('failed or unexpected network responses never replace a good shell cache entry', async () => {
  const worker = createWorker({ fetchImpl: async () => new Response('server error', { status: 500 }) });
  await installShell(worker);
  const networkEvent = worker.dispatch('fetch', request('/app.js'));
  const networkResponse = await networkEvent.response;
  await networkEvent.lifetime;
  assert.equal(networkResponse.status, 500);
  assert.deepEqual(worker.writes, []);
  assert.equal(await (await worker.cache.match('/app.js')).text(), 'precache:/app.js');

  const notFoundWorker = createWorker({ fetchImpl: async () => new Response('missing', { status: 404 }) });
  await installShell(notFoundWorker);
  const notFound = await notFoundWorker.dispatch('fetch', request('/styles.css')).response;
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFoundWorker.writes, []);

  const opaqueWorker = createWorker({ fetchImpl: async () => ({ status: 200, ok: true, type: 'opaque', redirected: false, clone() { return this; } }) });
  await installShell(opaqueWorker);
  await opaqueWorker.dispatch('fetch', request('/app.js')).response;
  assert.deepEqual(opaqueWorker.writes, []);

  const redirectWorker = createWorker({ fetchImpl: async () => ({ status: 200, ok: true, type: 'basic', redirected: true, clone() { return this; } }) });
  await installShell(redirectWorker);
  await redirectWorker.dispatch('fetch', request('/app.js')).response;
  assert.deepEqual(redirectWorker.writes, []);
});

test('cache write failure preserves a successful network response', async () => {
  const worker = createWorker({
    fetchImpl: async () => new Response('fresh despite cache failure'),
    putImpl: async () => { throw new Error('quota exceeded'); },
  });
  await installShell(worker);
  const event = worker.dispatch('fetch', request('/styles.css'));
  const response = await event.response;
  await event.lifetime;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'fresh despite cache failure');
  assert.equal(worker.writes.length, 1);
});

test('offline fallback returns only the matching pre-cached shell resource', async () => {
  const worker = createWorker({ fetchImpl: async () => { throw new Error('offline'); } });
  await installShell(worker);
  const shellEvent = worker.dispatch('fetch', request('/app.js'));
  const shell = await shellEvent.response;
  await shellEvent.lifetime;
  assert.equal(await shell.text(), 'precache:/app.js');

  const queryEvent = worker.dispatch('fetch', request('/app.js?build=1'));
  const queryShell = await queryEvent.response;
  await queryEvent.lifetime;
  assert.equal(await queryShell.text(), 'precache:/app.js');
  assert.deepEqual(worker.writes, []);

  const navigation = worker.dispatch('fetch', request('/', { mode: 'navigate' }));
  const response = await navigation.response;
  await navigation.lifetime;
  assert.equal(await response.text(), 'precache:/');

  const runtimeConfig = worker.dispatch('fetch', request('/runtime-config.js?build=clinical-intake'));
  const runtimeResponse = await runtimeConfig.response;
  await runtimeConfig.lifetime;
  assert.equal(await runtimeResponse.text(), 'precache:/runtime-config.js');
});

test('runtime config falls back while offline, then returns a fresh network value when connectivity returns', async () => {
  let online = false;
  const worker = createWorker({ fetchImpl: async request => {
    if (!online) throw new Error('offline');
    return new Response(`globalThis.__BINGLI_CONFIG__ = {"apiBaseUrl":"https://api.test"};`);
  } });
  await installShell(worker);

  const offline = worker.dispatch('fetch', request('/runtime-config.js?build=app'));
  assert.equal(await (await offline.response).text(), 'precache:/runtime-config.js');
  await offline.lifetime;
  assert.deepEqual(worker.writes, []);

  online = true;
  const recovered = worker.dispatch('fetch', request('/runtime-config.js?reconnect=1'));
  assert.match(await (await recovered.response).text(), /https:\/\/api\.test/);
  await recovered.lifetime;
  assert.deepEqual(worker.writes, [], 'query variants stay out of the shell cache');
});
