const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

// Real local API and AES encryption; remote responses and DOM are mechanical
// fixtures. A second realm shares storage, not a simulated backup restore.
async function harness(sharedDriver = null) {
  const driver = sharedDriver || new core.MemoryDocumentStore(), elements = new Map(), calls = [];
  let response = null, sessionResponse = null;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: class { constructor() { return driver; } } },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null },
    fetch: async (path, options) => {
      calls.push({ path, ...options });
      const payload = path === '/api/app/session' ? sessionResponse ? await sessionResponse() : { authenticated: true, csrf_token: 'synthetic-csrf' }
        : path === '/api/app/config' ? { provider: 'SyntheticMechanicalFixture', capabilities: { text_ai: { available: true } } }
        : response ? await response(JSON.parse(options.body))
        : { provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: '这段原话已经保存。' };
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal, password = 'fictional-health-memory-passphrase';
  if (!sharedDriver) await api.vault.setup(password);
  const ready = api.initialise(); await new Promise(setImmediate);
  element('vaultPassphrase').value = password;
  await element('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') => api.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const memory = async () => (await request('/api/health-memory')).j.health_context;
  const entry = values => ({ category: 'conditions', text: '虚构甲：2021年医生曾告知有哮喘', temporal_status: 'historical', confirmation_status: 'confirmed', confirmed_by: 'self', occurred_on: '2021-02-03', remember: true, source_kind: 'self_statement', ...values });
  const add = async values => request('/api/health-memory', { expected_version: (await memory()).version, entry: entry(values) });
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const say = async (conversation, text = '这次又咳嗽了。') => (await api.request(`/api/conversations/${conversation.conversation_id}/turns`, { method: 'POST', body: JSON.stringify({ text, expected_version: conversation.version }), headers: { 'Idempotency-Key': webcrypto.randomUUID() } })).j.conversation;
  const subjects = async () => (await request('/api/health-subjects')).j;
  const switchTo = async subject_id => request('/api/health-subjects/active', { subject_id, expected_version: (await subjects()).version });
  return { api, driver, calls, request, memory, entry, add, start, say, subjects, switchTo, setResponse(value) { response = value; }, setSessionResponse(value) { sessionResponse = value; } };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('explicit remembered health data survives unlock in a new realm and a genuinely new conversation uses it', async () => {
  const h = await harness(); const created = await h.add(); assert.equal(created.r.status, 201);
  const saved = created.j.health_context.entries[0]; assert.equal(saved.subject_id, 'subject_self');
  assert.ok(saved.recorded_at && saved.confirmed_at && saved.updated_at);
  assert.equal(JSON.stringify(await h.driver.listDocs()).includes(saved.text), false);
  const first = await h.say(await h.start()); h.api.lock();
  const fresh = await harness(h.driver), next = await fresh.say(await fresh.start());
  assert.notEqual(next.conversation_id, first.conversation_id);
  const sent = JSON.parse(fresh.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.equal(sent.subject_id, 'subject_self');
  assert.equal(sent.health_context[0].text, saved.text);
  assert.equal(sent.health_context[0].temporal_status, 'historical');
  assert.equal(sent.health_context[0].occurred_on, '2021-02-03');
  assert.equal((await fresh.memory()).entries.length, 1);
});

test('unconfirmed and uncertain entries stay local and cannot be remembered or manually sent', async () => {
  const h = await harness();
  assert.equal((await h.add({ confirmation_status: 'unconfirmed' })).j.error, 'health_memory_remember_invalid');
  assert.equal((await h.add({ temporal_status: 'uncertain' })).j.error, 'health_memory_remember_invalid');
  await h.add({ text: '虚构甲：不确定是否过敏', category: 'allergies', confirmation_status: 'unconfirmed', temporal_status: 'uncertain', remember: false });
  const saved = (await h.memory()).entries[0]; assert.equal(saved.confirmed_at, null); assert.equal(saved.source, 'user_unconfirmed');
  const c = await h.start();
  assert.equal((await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [saved.context_id] })).j.error, 'context_selection_invalid');
  await h.say(c);
  assert.deepEqual(JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context, []);
});

test('correction immediately removes stale context and analysis from stored reports; new conversation sees only corrected memory', async () => {
  const h = await harness(); await h.add();
  h.setResponse(payload => ({ provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: '原话已保存。', completeness: { clinical_state: {}, relevant_context_ids: [payload.health_context[0].context_id], contradictions: [] } }));
  const c = await h.say(await h.start()); const old = (await h.memory()).entries[0]; assert.match(c.report.body, /2021年/);
  const edited = await h.request(`/api/health-memory/${old.context_id}`, { expected_version: (await h.memory()).version, entry: h.entry({ text: '虚构甲：更正为2023年医生曾告知有哮喘', occurred_on: '2023-02-03' }) }, 'PATCH');
  assert.equal(edited.r.status, 200);
  const stored = await h.api.vault.get(`conversation:${c.conversation_id}`);
  assert.equal(stored.completeness, null); assert.equal(stored.analysis_sources, null);
  assert.deepEqual(plain(stored.health_context), []); assert.deepEqual(plain(stored.selected_context_ids), []);
  assert.equal(stored.report.body.includes(old.text), false);
  const next = await h.say(await h.start());
  const sent = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.equal(sent.health_context[0].text, edited.j.health_context.entries[0].text);
  assert.notEqual(next.conversation_id, c.conversation_id);
});

test('revoking reuse and deleting an entry stop future disclosure and clear retained background snapshots', async () => {
  const h = await harness(); await h.add(); const c = await h.say(await h.start()), saved = (await h.memory()).entries[0];
  const revoke = await h.request(`/api/health-memory/${saved.context_id}`, { expected_version: (await h.memory()).version, entry: h.entry({ remember: false }) }, 'PATCH');
  assert.equal(revoke.r.status, 200); assert.equal((await h.memory()).entries.length, 1);
  await h.say(await h.start()); assert.deepEqual(JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context, []);
  const deletion = await h.request(`/api/health-memory/${saved.context_id}`, { expected_version: (await h.memory()).version }, 'DELETE'); assert.equal(deletion.r.status, 200);
  assert.equal((await h.memory()).entries.length, 0);
  assert.equal(JSON.stringify(await h.api.vault.get(`conversation:${c.conversation_id}`)).includes(saved.text), false);
  await h.say(await h.start()); assert.deepEqual(JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context, []);
});

test('family identities isolate health memory, conversations, records, handoffs and direct IDs', async () => {
  const h = await harness(); await h.add(); const self = await h.say(await h.start()), selfRecord = self.turns.find(turn => turn.role === 'elder').record_id;
  const registry = await h.subjects(), created = await h.request('/api/health-subjects', { label: '虚构家属乙', relationship: 'family', expected_version: registry.version });
  const family = created.j.subjects.find(item => item.relationship === 'family'); await h.switchTo(family.subject_id);
  assert.equal((await h.memory()).entries.length, 0);
  assert.equal((await h.request(`/api/conversations/${self.conversation_id}`)).j.error, 'subject_mismatch');
  assert.equal((await h.request(`/api/events/${selfRecord}`)).j.error, 'subject_mismatch');
  assert.equal((await h.request('/api/conversations')).j.conversations.length, 0);
  assert.equal((await h.request('/api/events')).j.events.length, 0);
  assert.equal((await h.request('/api/handoffs', {})).j.handoff.items.length, 0);
  await h.add({ text: '虚构乙：2024年曾有湿疹', confirmed_by: 'family', source_kind: 'family_report' });
  const second = await h.say(await h.start(), '虚构乙：手臂痒。');
  const sent = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.equal(sent.subject_id, family.subject_id); assert.equal(sent.health_context.length, 1); assert.match(sent.health_context[0].text, /虚构乙/);
  const crossLink = await h.api.request(`/api/conversations/${second.conversation_id}/turns`, { method: 'POST', body: JSON.stringify({ text: self.turns.find(turn => turn.role === 'elder').text, record_id: selfRecord, expected_version: second.version }), headers: { 'Idempotency-Key': webcrypto.randomUUID() } });
  assert.equal(crossLink.r.status, 409);
  await h.switchTo('subject_self'); assert.equal((await h.memory()).entries.length, 1); assert.match((await h.memory()).entries[0].text, /虚构甲/);
});

test('independent local user stores never share a health memory or context ID', async () => {
  const a = await harness(), b = await harness(); await a.add();
  assert.equal((await b.memory()).entries.length, 0); await b.say(await b.start());
  assert.deepEqual(JSON.parse(b.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context, []);
});

test('CAS rejects stale corrections and prevents two tabs from overwriting one another', async () => {
  const a = await harness(), b = await harness(a.driver); const initial = await a.memory();
  const body = { expected_version: initial.version, entry: a.entry() };
  const outcomes = await Promise.all([a.request('/api/health-memory', body), b.request('/api/health-memory', { ...body, entry: b.entry({ text: '虚构乙：另一个并发条目' }) })]);
  assert.equal(outcomes.filter(result => result.r.status === 201).length, 1);
  assert.equal(outcomes.filter(result => result.j.error === 'stale_health_memory').length, 1);
  assert.equal((await a.memory()).entries.length, 1);
});

test('remember limit, strict dates, text length and required confirmation metadata preserve existing entries', async () => {
  const h = await harness();
  for (let i = 0; i < 5; i += 1) assert.equal((await h.add({ text: `虚构必要条目${i}` })).r.status, 201);
  assert.equal((await h.add({ text: '超出第五项' })).j.error, 'health_memory_remember_limit');
  for (const values of [{ occurred_on: '2023-02-29' }, { occurred_on: 'bad' }, { text: 'x'.repeat(501) }, { confirmation_status: 'invented' }, { remember: 'true' }, { source_kind: 'model_inference' }]) {
    assert.equal((await h.add({ ...values, remember: values.remember ?? false })).r.status, 400);
  }
  assert.equal((await h.memory()).entries.length, 5);
});

test('legacy background stays assigned to self, retains real stored dates and never gains automatic reuse', async () => {
  const h = await harness(); await h.api.vault.put('health-context:current', { version: 7, updated_at: '2025-01-03T00:00:00Z', entries: [{ context_id: 'context_legacy_fictional1', category: 'conditions', text: '虚构旧背景', source: 'user_confirmed', confirmed_at: '2025-01-02T00:00:00Z', updated_at: '2025-01-03T00:00:00Z' }] });
  const saved = (await h.memory()).entries[0]; assert.equal(saved.subject_id, 'subject_self'); assert.equal(saved.remember, false); assert.equal(saved.confirmed_at, '2025-01-02T00:00:00Z'); assert.equal(saved.occurred_on, null);
  assert.equal((await h.start()).selected_context_ids.length, 0);
});

test('remember false disables automatic reuse but confirmed data can be explicitly selected for this conversation', async () => {
  const h = await harness(); await h.add({ remember: false }); const entry = (await h.memory()).entries[0];
  let c = await h.start(); assert.deepEqual(plain(c.selected_context_ids), []);
  c = (await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [entry.context_id] })).j.conversation;
  await h.say(c); assert.equal(JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context[0].context_id, entry.context_id);
  assert.deepEqual(plain((await h.start()).selected_context_ids), []);
  assert.equal((await h.request('/api/health-context', { fields: {} })).j.error, 'health_context_requires_memory_editor');
  assert.equal((await h.memory()).entries.length, 1);
});

test('a memory correction during a model request wins and the late old response cannot revive background or clinical facts', async () => {
  const a = await harness(); await a.add(); const b = await harness(a.driver), c = await a.start();
  let release, notify; const entered = new Promise(resolve => { notify = resolve; });
  a.setResponse(payload => new Promise(resolve => { release = resolve; notify(payload); }));
  const pending = a.say(c); const sent = await entered, old = sent.health_context[0];
  const edit = await b.request(`/api/health-memory/${old.context_id}`, { expected_version: (await b.memory()).version, entry: b.entry({ text: '虚构甲：更正为2024年才出现过哮喘', occurred_on: '2024-03-04' }) }, 'PATCH');
  assert.equal(edit.r.status, 200);
  release({ provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: '这段旧资料已收到。', completeness: { clinical_state: {}, relevant_context_ids: [old.context_id], contradictions: [] } });
  await pending;
  const current = (await a.request(`/api/conversations/${c.conversation_id}`)).j.conversation;
  assert.equal(current.completeness, null); assert.equal(current.analysis_sources, null);
  assert.deepEqual(plain(current.selected_context_ids), []); assert.equal(JSON.stringify(current.report).includes(old.text), false);
  assert.equal(current.turns.some(turn => turn.text === '这段旧资料已收到。'), false);
  assert.equal(current.turns.some(turn => turn.role === 'elder'), true);
});

test('a different tab changing the active family identity during session lookup prevents a supplier request', async () => {
  const a = await harness(); await a.add(); const b = await harness(a.driver), registry = await b.subjects();
  const created = await b.request('/api/health-subjects', { label: '虚构家属丙', relationship: 'family', expected_version: registry.version });
  const family = created.j.subjects.find(item => item.relationship === 'family'); const c = await a.start();
  let release, notify; const entered = new Promise(resolve => { notify = resolve; });
  a.setSessionResponse(() => new Promise(resolve => { release = resolve; notify(); }));
  const pending = a.say(c); await entered; assert.equal((await b.switchTo(family.subject_id)).r.status, 200);
  release({ authenticated: true, csrf_token: 'synthetic-csrf' }); await pending;
  assert.equal(a.calls.some(call => call.path === '/api/ai/conversation-turn'), false);
  assert.equal((await b.request('/api/conversations')).j.conversations.length, 0);
  assert.equal((await b.request('/api/events')).j.events.length, 0);
});

test('a failed memory transaction preserves both the previous profile and conversation background intact', async () => {
  const h = await harness(); await h.add(); const c = await h.say(await h.start()), beforeProfile = plain(await h.memory()), beforeConversation = plain(await h.api.vault.get(`conversation:${c.conversation_id}`));
  const mutate = h.driver.mutateDocs.bind(h.driver); h.driver.mutateDocs = async () => { throw new Error('synthetic_memory_quota_abort'); };
  const failed = await h.request(`/api/health-memory/${beforeProfile.entries[0].context_id}`, { expected_version: beforeProfile.version }, 'DELETE');
  h.driver.mutateDocs = mutate;
  assert.equal(failed.r.ok, false); assert.deepEqual(plain(await h.memory()), beforeProfile);
  assert.deepEqual(plain(await h.api.vault.get(`conversation:${c.conversation_id}`)), beforeConversation);
});

test('a stale tab cannot silently write its self form into a newly active family profile with the same memory version', async () => {
  const a = await harness(), b = await harness(a.driver);
  const old = await a.memory(); assert.equal(old.subject_id, 'subject_self'); assert.equal(old.version, 0);
  const registry = await b.subjects(), created = await b.request('/api/health-subjects', { label: '虚构家属丁', relationship: 'family', expected_version: registry.version });
  const family = created.j.subjects.find(item => item.relationship === 'family'); await b.switchTo(family.subject_id);
  assert.equal((await b.memory()).version, 0);
  const stale = await a.request('/api/health-memory', { expected_version: old.version, entry: a.entry() });
  assert.equal(stale.j.error, 'subject_changed'); assert.equal(stale.r.status, 409);
  assert.equal((await b.memory()).entries.length, 0);
  for (const [path, body] of [['/api/health-context', { fields: { conditions: ['虚构甲的旧表单'] } }], ['/api/conversations/start', { mode: 'new', local_date: '2026-10-10' }], ['/api/events', undefined], ['/api/media', undefined], ['/api/handoffs', {}]]) {
    const result = await a.request(path, body); assert.equal(result.j.error, 'subject_changed');
  }
  const observed = await a.subjects(); assert.equal(observed.active_subject_id, family.subject_id); assert.equal(observed.observed_subject_id, 'subject_self');
  assert.equal((await a.request('/api/health-memory')).j.error, 'subject_changed', 'registry inspection cannot adopt an unseen patient');
  await a.switchTo('subject_self'); assert.equal((await a.memory()).subject_id, 'subject_self');
  assert.equal((await a.add()).r.status, 201);
  assert.equal((await b.request('/api/health-memory')).j.error, 'subject_changed', 'the other tab must explicitly acknowledge this switch too');
});

test('a form bound to the displayed owner and registry version is rejected before any memory write', async () => {
  const h = await harness(), profile = await h.memory(), registry = await h.subjects();
  const wrongOwner = await h.request('/api/health-memory', { subject_id: 'subject_invented_other', expected_subject_version: registry.version, expected_version: profile.version, entry: h.entry() });
  assert.equal(wrongOwner.r.status, 403); assert.equal(wrongOwner.j.error, 'subject_mismatch');
  const wrongVersion = await h.request('/api/health-memory', { subject_id: profile.subject_id, expected_subject_version: registry.version + 1, expected_version: profile.version, entry: h.entry() });
  assert.equal(wrongVersion.j.error, 'stale_health_subjects');
  const wrongRead = await h.api.request('/api/events', { headers: { 'X-Health-Subject-Id': 'subject_invented_other', 'X-Health-Subject-Version': String(registry.version) } });
  assert.equal(wrongRead.j.error, 'subject_mismatch');
  const valid = await h.request('/api/health-memory', { subject_id: profile.subject_id, expected_subject_version: registry.version, expected_version: profile.version, entry: h.entry() });
  assert.equal(valid.r.status, 201);
});

test('future occurred dates are rejected locally before persistence, reuse or a model request', async () => {
  const h = await harness(); const before = plain(await h.memory());
  const future = await h.add({ occurred_on: '2099-01-01' });
  assert.equal(future.r.status, 400); assert.equal(future.j.error, 'health_memory_invalid');
  assert.deepEqual(plain(await h.memory()), before); assert.equal(h.calls.length, 0);
});

test('lock and a fresh unlocked realm bind to the active patient without restoring or inventing an account', async () => {
  const a = await harness(); await a.memory(); const registry = await a.subjects();
  const created = await a.request('/api/health-subjects', { label: '虚构家属戊', relationship: 'family', expected_version: registry.version });
  const family = created.j.subjects.find(item => item.relationship === 'family'); await a.switchTo(family.subject_id); await a.add({ text: '虚构戊的既往资料', confirmed_by: 'family', source_kind: 'family_report' }); a.api.lock();
  const fresh = await harness(a.driver); const memory = await fresh.memory();
  assert.equal(memory.subject_id, family.subject_id); assert.equal(memory.entries[0].text, '虚构戊的既往资料');
  const c = await fresh.start(); assert.equal(c.subject_id, family.subject_id);
});

test('a family switch injected at the actual event or media upload transaction aborts the old-page write atomically', async () => {
  for (const kind of ['event', 'upload']) {
    const a = await harness(), b = await harness(a.driver); await a.memory();
    const registry = await b.subjects(), created = await b.request('/api/health-subjects', { label: `虚构并发${kind}`, relationship: 'family', expected_version: registry.version });
    const family = created.j.subjects.find(item => item.relationship === 'family');
    const original = a.driver.mutateDocs.bind(a.driver); let switched = false;
    a.driver.mutateDocs = async (...args) => {
      if (!switched && args[0].some(doc => doc.key.startsWith(kind === 'event' ? 'event:' : 'upload:'))) {
        switched = true; assert.equal((await b.switchTo(family.subject_id)).r.status, 200);
      }
      return original(...args);
    };
    let result;
    if (kind === 'event') result = await a.request('/api/events', { raw_text: '虚构本人旧表单原话', source_kind: 'elder', actor_name: '虚构本人' });
    else {
      const form = new FormData(); form.append('kind', 'image'); form.append('content_type', 'image/png'); form.append('total_parts', '1'); form.append('expected_size', '4');
      result = await a.api.request('/api/media/uploads', { method: 'POST', body: form });
    }
    a.driver.mutateDocs = original;
    assert.equal(switched, true); assert.equal(result.j.error, 'subject_changed');
    assert.equal((await a.api.vault.list(kind === 'event' ? 'event:' : 'upload:')).length, 0);
    assert.equal((await b.request('/api/events')).j.events.length, 0);
    assert.equal((await b.request('/api/media')).j.media.length, 0);
  }
});

test('original attachment access rechecks patient ownership after its asynchronous binary read', async () => {
  const a = await harness(), b = await harness(a.driver); await a.memory();
  const registry = await b.subjects(), created = await b.request('/api/health-subjects', { label: '虚构原件所属人', relationship: 'family', expected_version: registry.version });
  const family = created.j.subjects.find(item => item.relationship === 'family'), mediaId = 'media_fictional_owner_read';
  await a.api.vault.put(`media:${mediaId}`, { media_id: mediaId, subject_id: 'subject_self' });
  await a.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([1, 2, 3]).buffer, { content_type: 'image/png' });
  const get = a.api.vault.get.bind(a.api.vault); let switched = false;
  a.api.vault.get = async key => {
    const value = await get(key);
    if (!switched && key === `media-binary:${mediaId}`) {
      switched = true; assert.equal((await b.switchTo(family.subject_id)).r.status, 200);
    }
    return value;
  };
  try { await assert.rejects(a.api.originalObjectUrl(mediaId), /subject_changed/); }
  finally { a.api.vault.get = get; }
  assert.equal(switched, true); assert.equal(a.calls.length, 0);
});
