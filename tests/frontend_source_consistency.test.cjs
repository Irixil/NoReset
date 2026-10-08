// Synthetic-only local public API regressions. Memory persistence and HTTP
// doubles do not certify real browsers or medical/model accuracy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');
const reply = { provider: 'SyntheticProvider', action: 'ask', assistant_text: '什么时候开始的？', question_category: 'onset_course',
  controller: { question_count: 7, asked_categories: ['main_complaint', 'onset_course'] },
  completeness: { clinical_state: {}, relevant_context_ids: [], contradictions: [] } };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function harness() {
  const elements = new Map();
  const element = key => { if (!elements.has(key)) elements.set(key, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(key); };
  const responses = new Map(), calls = [];
  const context = vm.createContext({ HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout, navigator: { storage: {} }, document: { getElementById: element, querySelector: () => null },
    fetch: async (path, options) => { calls.push({ path, ...options }); const body = responses.get(path) || (path === '/api/app/session' ? { authenticated: true, csrf_token: 'synthetic-csrf' } : reply); return { ok: true, status: 200, json: async () => await body }; } });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal, passphrase = 'synthetic-source-consistency';
  await api.vault.setup(passphrase); const ready = api.initialise(); await new Promise(setImmediate);
  element('vaultPassphrase').value = passphrase; await element('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const request = (path, body, method = 'POST') => api.request(path, body === undefined ? {} : { method, body: JSON.stringify(body), headers: { 'Idempotency-Key': webcrypto.randomUUID() } });
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-08' })).j.conversation;
  const say = async (conversation, text, extra = {}) => (await request(`/api/conversations/${conversation.conversation_id}/turns`, { text, expected_version: conversation.version, ...extra })).j.conversation;
  const revise = async (recordId, text) => { const event = await api.vault.get(`event:${recordId}`); return request(`/api/events/${recordId}/revise`, { raw_text: text, reason: '虚构原话纠错', expected_version: event.version }); };
  return { api, request, start, say, revise, calls, responses };
}

test('archive revision atomically updates every conversation source and retains prior versions', async () => {
  const h = await harness();
  const first = await h.say(await h.start(), '纯虚构：昨天左膝酸痛');
  const source = first.turns.find(turn => turn.role === 'elder');
  const second = await h.say(await h.start(), source.text, { record_id: source.record_id });
  const independent = await h.say(await h.start(), '纯虚构：今天右手发麻');
  const cloudCalls = h.calls.length;
  const revision = await h.revise(source.record_id, '纯虚构更正：昨天右膝酸痛');
  assert.equal(revision.r.status, 201);
  assert.equal(h.calls.length, cloudCalls, 'archive correction saves locally without making a paid model request');
  assert.equal((await h.api.vault.get(`event:${source.record_id}`)).state, 'superseded');
  for (const before of [first, second]) {
    const saved = (await h.request(`/api/conversations/${before.conversation_id}`)).j.conversation;
    const turn = saved.turns.find(item => item.role === 'elder');
    assert.equal(turn.text, '纯虚构更正：昨天右膝酸痛');
    assert.equal(turn.record_id, revision.j.event.record_id);
    assert.equal(turn.version, 2);
    assert.equal(turn.original_text, source.text);
    assert.equal(turn.versions[0].text, source.text);
    assert.equal(turn.versions[0].record_id, source.record_id);
    assert.equal(saved.version, before.version + 1);
    assert.equal(saved.report.version, before.report.version + 1);
    assert.match(saved.report.body, /右膝酸痛/);
    assert.doesNotMatch(saved.report.body, /左膝酸痛/);
    assert.equal(saved.completeness, null);
    assert.equal(saved.controller.question_count, 1);
    assert.deepEqual(Array.from(saved.relevant_health_context), []);
    assert.ok(saved.turns.filter(item => item.role === 'assistant').slice(1).every(item => item.superseded));
    assert.ok(saved.report.source_turn_ids.includes(turn.turn_id));
  }
  assert.equal((await h.request(`/api/conversations/${independent.conversation_id}`)).j.conversation.version, independent.version);
});

test('deleting a linked event or revised source refuses instead of leaving a dangling report', async () => {
  const h = await harness();
  let conversation = await h.say(await h.start(), '纯虚构：昨天左膝酸痛');
  const source = conversation.turns.find(turn => turn.role === 'elder');
  let result = await h.request(`/api/events/${source.record_id}`, { delete_scope_confirmed: true }, 'DELETE');
  assert.equal(result.r.status, 409);
  assert.equal(result.j.error, 'conversation_source_changed');
  assert.match(result.j.message, /整段对话/);
  const revised = await h.revise(source.record_id, '纯虚构更正：昨天右膝酸痛');
  result = await h.request(`/api/events/${revised.j.event.record_id}`, { delete_scope_confirmed: true }, 'DELETE');
  assert.equal(result.r.status, 409);
  conversation = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.match(conversation.report.body, /右膝酸痛/);
  assert.ok(await h.api.vault.get(`event:${revised.j.event.record_id}`));
  const removed = await h.request(`/api/conversations/${conversation.conversation_id}`, { delete_scope_confirmed: true, expected_version: conversation.version }, 'DELETE');
  assert.equal(removed.r.ok, true);
  assert.equal(await h.api.vault.get(`event:${source.record_id}`), undefined);
  assert.equal(await h.api.vault.get(`event:${revised.j.event.record_id}`), undefined);
});

test('a failed archive correction transaction preserves original event, conversation and report', async () => {
  const h = await harness(), conversation = await h.say(await h.start(), '纯虚构：昨天左膝酸痛');
  const source = conversation.turns.find(turn => turn.role === 'elder');
  const mutate = h.api.vault.driver.mutateDocs.bind(h.api.vault.driver);
  h.api.vault.driver.mutateDocs = async () => { throw new Error('synthetic_quota_abort'); };
  const revision = await h.revise(source.record_id, '纯虚构更正：昨天右膝酸痛');
  assert.equal(revision.r.ok, false);
  h.api.vault.driver.mutateDocs = mutate;
  assert.equal((await h.api.vault.get(`event:${source.record_id}`)).state, 'inbox');
  assert.equal((await h.api.vault.list('event:')).length, 1);
  const saved = await h.api.vault.get(`conversation:${conversation.conversation_id}`);
  assert.equal(saved.version, conversation.version);
  assert.equal(saved.report.version, conversation.report.version);
  assert.equal(saved.turns.find(turn => turn.role === 'elder').text, source.text);
});

test('archive correction waits for an in-flight reply and supersedes its old inference', async () => {
  const h = await harness();
  const first = await h.say(await h.start(), '纯虚构：昨天左膝酸痛');
  const source = first.turns.find(turn => turn.role === 'elder');
  const remote = deferred(); h.responses.set('/api/ai/conversation-turn', remote.promise);
  const beforeCalls = h.calls.length;
  const sending = h.say(first, '纯虚构：走路也疼');
  while (h.calls.length < beforeCalls + 1) await new Promise(setImmediate);
  let revised = false;
  const revision = h.revise(source.record_id, '纯虚构更正：昨天右膝酸痛').then(result => { revised = true; return result; });
  await new Promise(setImmediate);
  assert.equal(revised, false, 'archive correction uses conversation lock before event lock');
  remote.resolve({ ...reply, assistant_text: '走路时哪边更不舒服？' });
  await sending; assert.equal((await revision).r.ok, true);
  const saved = (await h.request(`/api/conversations/${first.conversation_id}`)).j.conversation;
  assert.match(saved.report.body, /右膝酸痛/);
  assert.doesNotMatch(saved.report.body, /左膝酸痛/);
  assert.ok(saved.turns.filter(turn => turn.role === 'assistant').slice(1).every(turn => turn.superseded));
  assert.equal(saved.completeness, null);
});

test('a new conversation cannot link an old source while archive replacement is committing', async () => {
  const h = await harness();
  const first = await h.say(await h.start(), '纯虚构：昨天左膝酸痛');
  const source = first.turns.find(turn => turn.role === 'elder'), second = await h.start();
  const entered = deferred(), release = deferred(), mutate = h.api.vault.driver.mutateDocs.bind(h.api.vault.driver);
  h.api.vault.driver.mutateDocs = async (...args) => {
    if (args[0].some(document => document.key === `event:${source.record_id}`)) {
      entered.resolve(); await release.promise;
    }
    return mutate(...args);
  };
  const revision = h.revise(source.record_id, '纯虚构更正：昨天右膝酸痛');
  await entered.promise;
  const linking = h.request(`/api/conversations/${second.conversation_id}/turns`, {
    text: source.text, record_id: source.record_id, expected_version: second.version,
  });
  release.resolve();
  assert.equal((await revision).r.ok, true);
  const linked = await linking;
  assert.equal(linked.r.status, 409);
  assert.equal(linked.j.error, 'conversation_source_invalid');
  assert.equal((await h.request(`/api/conversations/${second.conversation_id}`)).j.conversation.turns.filter(turn => turn.role === 'elder').length, 0);
});

test('explicitly linking a deleted source refuses instead of silently recreating a different record', async () => {
  const h = await harness(), conversation = await h.start();
  const linked = await h.request(`/api/conversations/${conversation.conversation_id}/turns`, {
    text: '纯虚构：旧资料', record_id: 'rec_synthetic_deleted', expected_version: conversation.version,
  });
  assert.equal(linked.r.status, 409);
  assert.equal(linked.j.error, 'conversation_source_invalid');
  assert.equal((await h.api.vault.list('event:')).length, 0);
});

test('deleting a conversation with a shared source refuses without damaging either report', async () => {
  const h = await harness();
  const first = await h.say(await h.start(), '纯虚构：昨天左膝酸痛');
  const source = first.turns.find(turn => turn.role === 'elder');
  const second = await h.say(await h.start(), source.text, { record_id: source.record_id });
  const revision = await h.revise(source.record_id, '纯虚构更正：昨天右膝酸痛');
  const current = (await h.request(`/api/conversations/${first.conversation_id}`)).j.conversation;
  const removed = await h.request(`/api/conversations/${first.conversation_id}`, {
    delete_scope_confirmed: true, expected_version: current.version,
  }, 'DELETE');
  assert.equal(removed.r.status, 409);
  assert.equal(removed.j.error, 'conversation_source_shared');
  assert.match(removed.j.message, /其他对话引用/);
  for (const before of [first, second]) {
    const saved = (await h.request(`/api/conversations/${before.conversation_id}`)).j.conversation;
    assert.match(saved.report.body, /右膝酸痛/);
    assert.equal(saved.turns.find(turn => turn.role === 'elder').record_id, revision.j.event.record_id);
  }
  assert.ok(await h.api.vault.get(`event:${source.record_id}`));
  assert.ok(await h.api.vault.get(`event:${revision.j.event.record_id}`));
});

test('recognition linking and archive deletion/correction do not invert event and media locks', async () => {
  const h = await harness(), conversation = await h.start();
  const media = { media_id: 'media_synthetic_source_lock', kind: 'audio', content_type: 'audio/webm', original_filename: 'synthetic.webm',
    temporary: true, conversation_id: conversation.conversation_id, save_status: 'saved', recognition_status: 'not_started', version: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await h.api.vault.put(`media:${media.media_id}`, media);
  await h.api.vault.putBinary(`media-binary:${media.media_id}`, new Uint8Array([1, 2, 3]).buffer);
  h.responses.set('/api/ai/media/recognize', { recognition: { text: '纯虚构：昨天左膝酸痛', is_mock: false } });
  const entered = deferred(), release = deferred(), put = h.api.vault.put.bind(h.api.vault);
  let blocked = false;
  h.api.vault.put = async (key, value) => {
    if (!blocked && key === `media:${media.media_id}` && value.recognition_status === 'succeeded') {
      blocked = true; entered.resolve(); await release.promise;
    }
    return put(key, value);
  };
  const started = await h.request(`/api/media/${media.media_id}/recognize`, {});
  assert.equal(started.r.status, 202);
  await entered.promise;
  const source = (await h.api.vault.list('event:'))[0];
  assert.equal(source.source_conversation_id, conversation.conversation_id);
  try {
    const deleted = await Promise.race([
      h.request(`/api/events/${source.record_id}`, { delete_scope_confirmed: true }, 'DELETE'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('synthetic_delete_deadlock')), 500)),
    ]);
    assert.equal(deleted.r.status, 409);
    assert.equal(deleted.j.error, 'conversation_source_changed');
    let corrected = false;
    const correcting = h.revise(source.record_id, '纯虚构更正：昨天右膝酸痛').then(result => { corrected = true; return result; });
    await new Promise(setImmediate);
    assert.equal(corrected, false, 'archive correction waits for the owner conversation outside event/media locks');
    release.resolve();
    const revision = await Promise.race([correcting,
      new Promise((_, reject) => setTimeout(() => reject(new Error('synthetic_correction_deadlock')), 1000))]);
    assert.equal(revision.r.ok, true);
    const saved = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
    assert.match(saved.report.body, /右膝酸痛/);
    assert.equal(saved.turns.find(turn => turn.role === 'elder').record_id, revision.j.event.record_id);
    assert.ok(h.calls.some(call => call.path === '/api/ai/conversation-turn'));
    assert.ok(h.calls.filter(call => call.path === '/api/ai/conversation-turn').every(call => !call.body.includes('source_conversation_id')),
      'the local ownership marker is not included in cloud model payloads');
  } finally { release.resolve(); h.api.vault.put = put; }
});
