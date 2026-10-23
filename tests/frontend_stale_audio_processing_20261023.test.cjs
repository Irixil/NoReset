// Regressions for stale audio processing markers. Synthetic provider only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

class SharedLocks {
  held = new Set();
  pending = [];
  failQuery = false;
  query() {
    if (this.failQuery) return Promise.reject(new Error('synthetic query failure'));
    return Promise.resolve({
      held: [...this.held].map(name => ({ name, mode: 'exclusive' })),
      pending: this.pending.map(({ name }) => ({ name, mode: 'exclusive' })),
    });
  }
  request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (options?.ifAvailable && this.held.has(name)) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      this.pending.push({ name, options, callback, resolve, reject });
      this.#pump();
    });
  }
  #pump() {
    const index = this.pending.findIndex(item => !this.held.has(item.name));
    if (index < 0) return;
    const item = this.pending.splice(index, 1)[0];
    if (item.options?.ifAvailable && this.pending.some(other => other.name === item.name)) {
      queueMicrotask(() => item.resolve(item.callback(null)));
      return;
    }
    this.held.add(item.name);
    queueMicrotask(async () => {
      try { item.resolve(await item.callback({ name: item.name, mode: 'exclusive' })); }
      catch (error) { item.reject(error); }
      finally { this.held.delete(item.name); this.#pump(); }
    });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function createPage(driver, locks, password, response, setup = false) {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: class { constructor() { return driver; } } },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout, navigator: { storage: {}, locks },
    document: { getElementById: element, querySelector: () => null, addEventListener() {} },
    fetch: async path => {
      calls.push(path);
      if (path === '/api/app/session') return { ok: true, status: 200, json: async () => ({ authenticated: true, csrf_token: 'synthetic-only' }) };
      if (path === '/api/app/config') return { ok: true, status: 200, json: async () => ({ asr_trial: null }) };
      if (path === '/api/ai/media/recognize') return typeof response === 'function' ? response() : response.promise;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal;
  if (setup) await api.vault.setup(password);
  const ready = api.initialise();
  await new Promise(setImmediate);
  element('vaultPassphrase').value = password;
  await element('vaultForm').onsubmit({ preventDefault() {} });
  await ready;
  return { api, calls, request: (path, body) => api.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) };
}

function audio(id, status = 'not_started', updatedAt = new Date().toISOString()) {
  return { media_id: id, subject_id: 'subject_self', kind: 'audio', content_type: 'audio/wav', original_filename: 'synthetic.wav',
    temporary: true, save_status: 'saved', recognition_status: status, link_status: 'not_linked', version: 1,
    created_at: updatedAt, updated_at: updatedAt };
}

async function waitFor(check) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('synthetic operation did not reach expected state');
}

test('a stale processing marker no longer blocks a new local audio recognition', async () => {
  const driver = new core.MemoryDocumentStore(), locks = new SharedLocks(), password = 'synthetic-only-passphrase', response = deferred();
  const page = await createPage(driver, locks, password, response, true);
  const staleAt = new Date(Date.now() - 121000).toISOString();
  await page.api.vault.put('media:stale-audio', audio('stale-audio', 'processing', staleAt));
  await page.api.vault.putBinary('media-binary:stale-audio', new Uint8Array([1, 2, 3]).buffer, { content_type: 'audio/wav' });
  await page.api.vault.put('media:new-audio', audio('new-audio'));
  await page.api.vault.putBinary('media-binary:new-audio', new Uint8Array([4, 5, 6]).buffer, { content_type: 'audio/wav' });

  const started = await page.request('/api/media/new-audio/recognize', {});
  assert.equal(started.r.status, 202);
  await waitFor(() => page.calls.includes('/api/ai/media/recognize'));
  assert.equal(page.calls.filter(path => path === '/api/ai/media/recognize').length, 1);
  const stale = (await page.request('/api/media/stale-audio')).j.media;
  assert.equal(stale.recognition_status, 'interrupted');

  response.resolve({ ok: true, status: 200, json: async () => ({ ok: true, recognition: { text: '合成转写', is_mock: false } }) });
  await waitFor(async () => (await page.api.vault.get('media:new-audio'))?.recognition_status === 'succeeded');
  assert.equal((await page.api.vault.get('media:stale-audio')).recognition_status, 'processing', 'stale history is not silently retried or rewritten');
  assert.equal(page.calls.filter(path => path === '/api/ai/media/recognize').length, 1);
});

test('a live ASR request in another page blocks a second audio request', async () => {
  const driver = new core.MemoryDocumentStore(), locks = new SharedLocks(), password = 'synthetic-only-passphrase', response = deferred();
  const first = await createPage(driver, locks, password, response, true);
  const second = await createPage(driver, locks, password, response);
  for (const id of ['first-audio', 'second-audio']) {
    await first.api.vault.put(`media:${id}`, audio(id));
    await first.api.vault.putBinary(`media-binary:${id}`, new Uint8Array([1, 2, 3]).buffer, { content_type: 'audio/wav' });
  }

  const started = await first.request('/api/media/first-audio/recognize', {});
  assert.equal(started.r.status, 202);
  await waitFor(() => first.calls.includes('/api/ai/media/recognize'));
  assert.ok((await locks.query()).held.some(lock => lock.name === 'bingli-audio-recognition-active-v1'));
  const processing = await first.api.vault.get('media:first-audio');
  await first.api.vault.put('media:first-audio', { ...processing, updated_at: new Date(Date.now() - 121000).toISOString() });

  const blocked = await second.request('/api/media/second-audio/recognize', {});
  assert.equal(blocked.r.status, 409);
  assert.equal(blocked.j.error, 'audio_recognition_in_progress');
  assert.equal((await second.api.vault.get('media:second-audio')).recognition_status, 'not_started');
  assert.equal(first.calls.filter(path => path === '/api/ai/media/recognize').length, 1);
  assert.equal(second.calls.filter(path => path === '/api/ai/media/recognize').length, 0);

  response.resolve({ ok: true, status: 200, json: async () => ({ ok: true, recognition: { text: '合成转写', is_mock: false } }) });
  await waitFor(async () => (await first.api.vault.get('media:first-audio'))?.recognition_status === 'succeeded');
});

test('lock-query failure fails closed, provider failure releases the scope, and same-media retry is explicit', async () => {
  const driver = new core.MemoryDocumentStore(), locks = new SharedLocks(), password = 'synthetic-only-passphrase';
  let response = deferred();
  const first = await createPage(driver, locks, password, () => response.promise, true);
  const second = await createPage(driver, locks, password, () => response.promise);
  await first.api.vault.put('media:retry-audio', audio('retry-audio'));
  await first.api.vault.putBinary('media-binary:retry-audio', new Uint8Array([7, 8, 9]).buffer, { content_type: 'audio/wav' });

  assert.equal((await first.request('/api/media/retry-audio/recognize', {})).r.status, 202);
  await waitFor(() => first.calls.filter(path => path === '/api/ai/media/recognize').length === 1);
  const processing = await first.api.vault.get('media:retry-audio');
  await first.api.vault.put('media:retry-audio', { ...processing, updated_at: new Date(Date.now() - 121000).toISOString() });
  locks.failQuery = true;
  const duplicate = await second.request('/api/media/retry-audio/recognize', {});
  assert.equal(duplicate.r.status, 409);
  assert.equal(duplicate.j.error, 'audio_recognition_in_progress');
  assert.equal(first.calls.filter(path => path === '/api/ai/media/recognize').length, 1);
  assert.equal(second.calls.filter(path => path === '/api/ai/media/recognize').length, 0);
  locks.failQuery = false;

  response.resolve({ ok: false, status: 503, json: async () => ({ ok: false, error: 'provider_unavailable', retryable: true }) });
  await waitFor(async () => (await first.api.vault.get('media:retry-audio'))?.recognition_status === 'failed');
  assert.ok(!(await locks.query()).held.some(lock => lock.name === 'bingli-audio-recognition-active-v1'));

  response = deferred();
  const retry = await second.request('/api/media/retry-audio/recognize', {});
  assert.equal(retry.r.status, 202);
  await waitFor(() => second.calls.filter(path => path === '/api/ai/media/recognize').length === 1);
  assert.equal(first.calls.filter(path => path === '/api/ai/media/recognize').length
    + second.calls.filter(path => path === '/api/ai/media/recognize').length, 2);
  response.resolve({ ok: true, status: 200, json: async () => ({ ok: true, recognition: { text: '合成转写', is_mock: false } }) });
  await waitFor(async () => (await second.api.vault.get('media:retry-audio'))?.recognition_status === 'succeeded');
});
