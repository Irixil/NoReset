// Synthetic budget failures only; no budget receipt, key or remote provider.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js'), safety = require('../frontend/safety.js');
async function harness(code) {
  const elements = new Map(), calls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  let approvedSynthetic = false;
  const context = vm.createContext({ HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { storage: {} }, document: { getElementById: element, querySelector: () => null },
    fetch: async path => { calls.push(path); const denied = path.includes('/api/ai/') && !approvedSynthetic;
      return { status: denied ? 503 : 200, ok: !denied, json: async () => path === '/api/app/session' ? { authenticated: true, csrf_token: 'synthetic-only' }
        : denied ? { ok: false, error: code, retryable: false } : { recognition: { text: '纯虚构：机械恢复文字', is_mock: false } } }; } });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal, pass = 'synthetic-preflight-gate'; await api.vault.setup(pass);
  const ready = api.initialise(); await new Promise(setImmediate); element('vaultPassphrase').value = pass; await element('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const id = 'media_synthetic_gate'; await api.vault.put('media:' + id, { media_id: id, kind: 'image', content_type: 'image/png', original_filename: 'synthetic.png', save_status: 'saved', recognition_status: 'not_started', version: 1, created_at: new Date().toISOString() });
  await api.vault.putBinary('media-binary:' + id, new Uint8Array([7, 1, 8]).buffer);
  const get = () => api.request('/api/media/' + id);
  const recognize = () => api.request('/api/media/' + id + '/recognize', { method: 'POST', body: '{}' });
  const wait = async status => { for (let i = 0; i < 500; i++) { const x = await get(); if (x.j.media?.recognition_status === status) return x.j.media; await new Promise(setImmediate); } throw new Error('synthetic recognition wait exceeded'); };
  return { api, id, calls, get, recognize, wait, newSyntheticAuthorization() { approvedSynthetic = true; } };
}
for (const code of ['trial_authorization_required', 'trial_budget_exhausted']) test(`${code} retains original and offers only explicit new-authorization manual recovery`, async () => {
  const h = await harness(code); await h.recognize(); const failed = await h.wait('failed');
  assert.equal(failed.recognition.error.code, code); assert.equal(failed.recognition.retryable, false);
  assert.equal(failed.recognition.manual_retry_after_authorization, true);
  assert.match(failed.recognition.error_message, /授权/);
  if (code === 'trial_budget_exhausted') assert.match(failed.recognition.error_message, /新.*授权/);
  for (let i = 0; i < 3; i++) await h.get();
  assert.equal(h.calls.filter(path => path === '/api/ai/media/recognize').length, 1, 'reads never automatically restart a blocked trial');
  assert.deepEqual([...new Uint8Array((await h.api.vault.get('media-binary:' + h.id)).bytes)], [7, 1, 8]);
  await h.recognize(); const stillDenied = await h.wait('failed'); assert.equal(stillDenied.recognition.error.code, code);
  assert.equal((await h.api.vault.list('event:')).length, 0, 'a manual click does not bypass an unchanged authorization gate');
  h.newSyntheticAuthorization(); await h.recognize(); const recovered = await h.wait('succeeded');
  assert.equal(recovered.recognition.text, '纯虚构：机械恢复文字');
  assert.equal(h.calls.filter(path => path === '/api/ai/media/recognize').length, 3);
  assert.equal((await h.api.vault.list('event:')).length, 1);
  assert.deepEqual([...new Uint8Array((await h.api.vault.get('media-binary:' + h.id)).bytes)], [7, 1, 8]);
});
