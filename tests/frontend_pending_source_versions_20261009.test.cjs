// Original synthetic input only. Two VM realms without Web Locks share the
// actual encrypted core over MemoryDocumentStore. fetch is an in-memory double;
// no browser, provider/network, credentials or actual runtime is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');
const source = fs.readFileSync(path.join(__dirname, '../frontend/local-store.js'), 'utf8');
const originalText = '我咳嗽两天了。';
const correctedText = '我咳嗽三天了。';
const password = 'synthetic-pending-source-regression';
const lateText = '我会保留您刚才说的原话。';
const lateModel = 'synthetic-old-v1-response';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function realm(driver) {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {},
      classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  let authenticated = true;
  let model = async () => { throw new Error('unexpected_offline_model_fixture'); };
  class SharedDriver { constructor() { return driver; } }
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: SharedDriver }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController,
    setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null },
    fetch: async (route, options) => {
      assert.ok(['/api/app/session', '/api/ai/conversation-turn'].includes(route), 'only in-memory local fixtures');
      const payload = options?.body ? JSON.parse(options.body) : null;
      calls.push({ route, payload });
      const body = route === '/api/app/session'
        ? { authenticated, csrf_token: authenticated ? 'synthetic-csrf' : null }
        : await model(payload);
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    },
  });
  vm.runInContext(source, context, { filename: 'frontend/local-store.js' });
  const api = context.HealthLocal;
  if (!await driver.getMeta('vault')) await api.vault.setup(password);
  const ready = api.initialise();
  await new Promise(setImmediate);
  element('vaultPassphrase').value = password;
  await element('vaultForm').onsubmit({ preventDefault() {} });
  await ready;
  const request = (route, body) => api.request(route, body === undefined ? {} : {
    method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': webcrypto.randomUUID() },
  });
  return { api, request, calls, setAuthenticated(value) { authenticated = value; },
    setModel(value) { model = value; } };
}

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('offline_fixture_progress_timeout');
}

function draft(payload) {
  const turn = payload.turns.at(-1);
  return {
    provider: 'SyntheticOfflineProvider', model_id: lateModel, action: 'reply', assistant_text: lateText,
    question_category: null, controller: payload.controller,
    completeness: { clinical_state: {
      onset_course: { status: 'known', summary: turn.text, evidence_turn_ids: [turn.turn_id], context_ids: [] },
    }, relevant_context_ids: [], contradictions: [] },
  };
}

for (const mode of ['initial_submit', 'resume_assistant']) {
  test(`${mode}: an old v1 success cannot replace a saved v2 source or bind its old analysis to v2 without Web Locks`, async () => {
    const driver = new core.MemoryDocumentStore();
    const a = await realm(driver), b = await realm(driver);
    let conversation = (await a.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-09' })).j.conversation;
    const id = conversation.conversation_id;
    const read = () => a.api.vault.get('conversation:' + id);
    const delayed = deferred();
    let oldPayload;
    a.setModel(payload => { oldPayload = payload; return delayed.promise; });
    let pending;
    if (mode === 'initial_submit') {
      pending = a.request(`/api/conversations/${id}/turns`, { text: originalText, expected_version: conversation.version });
    } else {
      a.setAuthenticated(false);
      conversation = (await a.request(`/api/conversations/${id}/turns`, { text: originalText, expected_version: conversation.version })).j.conversation;
      a.setAuthenticated(true);
      pending = a.request(`/api/conversations/${id}/resume-assistant`, {});
    }
    try {
      await until(() => oldPayload !== undefined);
      const v1 = await read(), turn = v1.turns.find(item => item.role === 'elder');
      assert.equal(turn.text, originalText);
      assert.equal(turn.version, 1);
      assert.equal(oldPayload.turns.at(-1).turn_id, turn.turn_id);
      assert.equal(oldPayload.turns.at(-1).version, 1);
      b.setAuthenticated(false); // Offline editing still commits v2 before its analysis fails.
      const edited = await b.request(`/api/conversations/${id}/turns/${turn.turn_id}`, {
        text: correctedText, expected_version: turn.version, expected_conversation_version: v1.version,
      });
      assert.equal(edited.r.ok, true);
      const before = await read();
      const corrected = before.turns.find(item => item.turn_id === turn.turn_id);
      assert.equal(corrected.text, correctedText);
      assert.equal(corrected.version, 2);
      assert.equal(corrected.versions[0].text, originalText);
      const eventBefore = await a.api.vault.get('event:' + turn.record_id);
      assert.equal(eventBefore.raw_text, correctedText);
      delayed.resolve(draft(oldPayload));
      await pending;
      const after = await read();
      const current = after.turns.find(item => item.turn_id === turn.turn_id);
      const event = await a.api.vault.get('event:' + turn.record_id);
      assert.equal(current.text, correctedText, 'late v1 must not restore old raw text');
      assert.equal(current.version, 2, 'late v1 must not restore old turn version');
      assert.deepEqual(JSON.parse(JSON.stringify(current.versions)), JSON.parse(JSON.stringify(corrected.versions)), 'v1 history remains unchanged');
      assert.deepEqual(event, eventBefore, 'late v1 must not desynchronize or mutate the saved event');
      assert.equal(after.version, before.version, 'discarded old success must not create a conversation revision');
      assert.deepEqual(after.report, before.report, 'discarded old success must not create or overwrite the current report');
      assert.deepEqual(after.completeness, before.completeness, 'old known duration must not enter current clinical state');
      assert.deepEqual(after.analysis_sources, before.analysis_sources, 'old analysis must not be stamped with current v2 sources');
      assert.deepEqual(after.last_ai_metadata, before.last_ai_metadata, 'old model metadata remains discarded');
      assert.ok(!after.turns.some(item => !item.superseded && item.role === 'assistant' && item.text === lateText), 'old successful reply must not be attached to the corrected source');
      assert.equal(a.calls.filter(call => call.route === '/api/ai/conversation-turn').length, 1);
      assert.equal(b.calls.filter(call => call.route === '/api/ai/conversation-turn').length, 0);
    } finally {
      delayed.resolve(oldPayload ? draft(oldPayload) : {});
      await pending;
    }
  });
}

test('correction: a delayed v2 analysis cannot replace a subsequent v3 correction in another realm', async () => {
  const driver = new core.MemoryDocumentStore(), a = await realm(driver), b = await realm(driver);
  let conversation = (await a.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-09' })).j.conversation;
  a.setAuthenticated(false);
  conversation = (await a.request(`/api/conversations/${conversation.conversation_id}/turns`, {
    text: originalText, expected_version: conversation.version,
  })).j.conversation;
  const id = conversation.conversation_id, first = conversation.turns.find(item => item.role === 'elder');
  const read = () => a.api.vault.get('conversation:' + id), delayed = deferred();
  let oldPayload;
  a.setAuthenticated(true);
  a.setModel(payload => { oldPayload = payload; return delayed.promise; });
  const pending = a.request(`/api/conversations/${id}/turns/${first.turn_id}`, {
    text: correctedText, expected_version: first.version, expected_conversation_version: conversation.version,
  });
  try {
    await until(() => oldPayload !== undefined);
    assert.equal(oldPayload.turns.at(-1).version, 2);
    assert.equal(oldPayload.turns.at(-1).text, correctedText);
    const v2 = await read(), turn = v2.turns.find(item => item.turn_id === first.turn_id);
    b.setAuthenticated(false);
    const edited = await b.request(`/api/conversations/${id}/turns/${turn.turn_id}`, {
      text: '我咳嗽四天了。', expected_version: turn.version, expected_conversation_version: v2.version,
    });
    assert.equal(edited.r.ok, true);
    const before = await read(), eventBefore = await a.api.vault.get('event:' + first.record_id);
    const current = before.turns.find(item => item.turn_id === first.turn_id);
    assert.equal(current.version, 3);
    assert.equal(current.text, '我咳嗽四天了。');
    assert.deepEqual(Array.from(current.versions, item => item.version), [1, 2]);
    delayed.resolve(draft(oldPayload));
    const result = await pending;
    assert.equal(result.j.result_discarded, true);
    assert.deepEqual(await read(), before, 'v3, full history, report and metadata remain exactly unchanged');
    assert.deepEqual(await a.api.vault.get('event:' + first.record_id), eventBefore);
    assert.equal(a.calls.filter(call => call.route === '/api/ai/conversation-turn').length, 1);
    assert.equal(b.calls.filter(call => call.route === '/api/ai/conversation-turn').length, 0);
  } finally {
    delayed.resolve(oldPayload ? draft(oldPayload) : {});
    await pending;
  }
});

test('selected health context: changing its real local record discards the old analysis without rebinding its source', async () => {
  const driver = new core.MemoryDocumentStore(), a = await realm(driver), b = await realm(driver);
  const oldText = '原创虚构背景：以前有左膝不适。';
  const newText = '原创虚构背景：以前有右手不适。';
  const context = (await a.request('/api/health-context', { fields: { conditions: [oldText] } })).j.health_context;
  const selected = context.entries[0];
  let conversation = (await a.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-09' })).j.conversation;
  const id = conversation.conversation_id;
  conversation = (await a.request(`/api/conversations/${id}/context`, { context_ids: [selected.context_id] })).j.conversation;
  const read = () => a.api.vault.get('conversation:' + id), delayed = deferred();
  let oldPayload;
  a.setModel(payload => { oldPayload = payload; return delayed.promise; });
  const pending = a.request(`/api/conversations/${id}/turns`, { text: originalText, expected_version: conversation.version });
  try {
    await until(() => oldPayload !== undefined);
    assert.equal(oldPayload.health_context[0].context_id, selected.context_id);
    assert.equal(oldPayload.health_context[0].text, oldText);
    const changed = await b.request('/api/health-context', { fields: { conditions: [newText] } });
    assert.equal(changed.r.ok, true);
    assert.equal(changed.j.health_context.entries[0].text, newText);
    assert.notEqual(changed.j.health_context.entries[0].context_id, selected.context_id);
    const before = await read();
    const reply = draft(oldPayload);
    reply.completeness.clinical_state.relevant_history = {
      status: 'known', summary: oldText, evidence_turn_ids: [], context_ids: [selected.context_id],
    };
    reply.completeness.relevant_context_ids = [selected.context_id];
    delayed.resolve(reply);
    const result = await pending;
    assert.equal(result.j.result_discarded, true);
    assert.deepEqual(await read(), before, 'changed background must not be silently rebound as current analysis');
    assert.equal((await a.api.vault.get('health-context:current')).entries[0].text, newText);
    assert.equal(a.calls.filter(call => call.route === '/api/ai/conversation-turn').length, 1);
    assert.equal(b.calls.filter(call => call.route === '/api/ai/conversation-turn').length, 0);
  } finally {
    delayed.resolve(oldPayload ? draft(oldPayload) : {});
    await pending;
  }
});
