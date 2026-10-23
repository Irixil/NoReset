// Synthetic local API regression for stale event-delete confirmations.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

async function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null },
    fetch: async path => ({ ok: true, status: 200, json: async () => path === '/api/app/session'
      ? { authenticated: true, csrf_token: 'synthetic-delete-version' }
      : { action: 'ask', assistant_text: '什么时候开始的？' } }),
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal, passphrase = 'synthetic-delete-version-v161';
  await api.vault.setup(passphrase);
  const ready = api.initialise();
  await new Promise(setImmediate);
  element('vaultPassphrase').value = passphrase;
  await element('vaultForm').onsubmit({ preventDefault() {} });
  await ready;
  const request = (path, body, method = 'POST') => api.request(path, {
    method, body: JSON.stringify(body), headers: { 'Idempotency-Key': webcrypto.randomUUID() },
  });
  const create = async source_kind => (await request('/api/events', { raw_text: 'V161 虚构删除确认测试', source_kind })).j.event;
  return { api, request, create };
}

test('stale delete confirmation preserves the same record, media and history after an in-place update', async () => {
  const h = await harness();
  const original = await h.create('document');
  const oldConfirmation = { delete_scope_confirmed: true, expected_version: original.version };
  const mediaId = 'media_v161_delete_version_original';
  await h.api.vault.put(`media:${mediaId}`, {
    media_id: mediaId, subject_id: original.subject_id, kind: 'image', record_id: original.record_id,
    event_link: { record_id: original.record_id }, save_status: 'saved', recognition_status: 'not_started', version: 1,
  });
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([137, 80, 78, 71]).buffer,
    { content_type: 'image/png', filename: 'synthetic.png' });
  const updated = (await h.request(`/api/events/${original.record_id}/source-review`, {
    expected_version: original.version, compared_with_original: true,
  })).j.event;
  assert.equal(updated.record_id, original.record_id);
  assert.equal(updated.version, original.version + 1);

  const stale = await h.request(`/api/events/${original.record_id}`, oldConfirmation, 'DELETE');
  assert.equal(stale.r.status, 409);
  assert.equal(stale.j.error, 'stale_version');
  assert.equal((await h.api.vault.get(`event:${original.record_id}`)).version, updated.version);
  assert.equal((await h.api.vault.get(`event:${original.record_id}`)).source_review.method, 'original_comparison');
  assert.ok(await h.api.vault.get(`media:${mediaId}`));
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
  assert.ok((await h.api.vault.list(`history:${original.record_id}:`)).length > 0);

  const current = await h.request(`/api/events/${original.record_id}`, {
    delete_scope_confirmed: true, expected_version: updated.version,
  }, 'DELETE');
  assert.equal(current.r.status, 200);
  assert.equal(await h.api.vault.get(`event:${original.record_id}`), undefined);
  assert.equal(await h.api.vault.get(`media:${mediaId}`), undefined);
  assert.equal(await h.api.vault.get(`media-binary:${mediaId}`), undefined);
  assert.equal((await h.api.vault.list(`history:${original.record_id}:`)).length, 0);
});

test('an unchanged event is deleted with the current expected version', async () => {
  const h = await harness(), event = await h.create('elder');
  const result = await h.request(`/api/events/${event.record_id}`, {
    delete_scope_confirmed: true, expected_version: event.version,
  }, 'DELETE');
  assert.equal(result.r.status, 200);
  assert.equal(await h.api.vault.get(`event:${event.record_id}`), undefined);
});

test('legacy internal delete calls without expected_version remain compatible', async () => {
  const h = await harness(), event = await h.create('elder');
  const result = await h.request(`/api/events/${event.record_id}`, { delete_scope_confirmed: true }, 'DELETE');
  assert.equal(result.r.status, 200);
  assert.equal(await h.api.vault.get(`event:${event.record_id}`), undefined);
});
