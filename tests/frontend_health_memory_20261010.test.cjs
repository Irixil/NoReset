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

test('toggling only remember preserves confirmation time; source edits refresh it and cancel-confirm clears it', async () => {
  const h = await harness();
  const created = await h.add(); assert.equal(created.r.status, 201);
  let saved = created.j.health_context.entries[0], priorConfirmedAt = saved.confirmed_at;
  const patch = async entry => h.request(`/api/health-memory/${saved.context_id}`, {
    expected_version: (await h.memory()).version, entry,
  }, 'PATCH');
  const fields = entry => Object.fromEntries(['text', 'category', 'temporal_status', 'source_kind', 'occurred_on', 'confirmed_by', 'confirmation_status', 'source'].map(key => [key, entry[key]]));
  await new Promise(resolve => setTimeout(resolve, 5));
  let result = await patch(h.entry({ remember: false }));
  assert.equal(result.r.status, 200);
  saved = (await h.memory()).entries[0];
  assert.equal(saved.confirmed_at, priorConfirmedAt);
  assert.deepEqual(fields(saved), fields(created.j.health_context.entries[0]));

  priorConfirmedAt = saved.confirmed_at;
  await new Promise(resolve => setTimeout(resolve, 5));
  result = await patch(h.entry({ remember: false, text: '虚构甲：更正为2021年曾持续咳嗽一周' }));
  assert.equal(result.r.status, 200);
  saved = (await h.memory()).entries[0];
  assert.notEqual(saved.confirmed_at, priorConfirmedAt);
  priorConfirmedAt = saved.confirmed_at;

  result = await patch(h.entry({ remember: false, text: saved.text, confirmation_status: 'unconfirmed' }));
  assert.equal(result.r.status, 200);
  saved = (await h.memory()).entries[0];
  assert.equal(saved.confirmed_at, null);

  await new Promise(resolve => setTimeout(resolve, 5));
  result = await patch(h.entry({ remember: false, text: saved.text, confirmation_status: 'confirmed' }));
  assert.equal(result.r.status, 200);
  saved = (await h.memory()).entries[0];
  assert.ok(saved.confirmed_at);
  assert.notEqual(saved.confirmed_at, priorConfirmedAt);
});

test('clearing one conversation background survives unlock without revoking remembered reuse', async () => {
  const h = await harness(); await h.add();
  const original = await h.start(), saved = (await h.memory()).entries[0];
  assert.deepEqual(plain(original.selected_context_ids), [saved.context_id]);

  const cleared = await h.request(`/api/conversations/${original.conversation_id}/context`, { context_ids: [] });
  assert.deepEqual(plain(cleared.j.conversation.selected_context_ids), []);
  const answered = await h.say(cleared.j.conversation);
  assert.deepEqual(plain(answered.health_context), []);
  assert.deepEqual(JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context, []);

  h.api.lock();
  const fresh = await harness(h.driver);
  const reopened = await fresh.request(`/api/conversations/${original.conversation_id}`);
  assert.deepEqual(plain(reopened.j.conversation.selected_context_ids), []);
  const afterUnlock = await fresh.say(reopened.j.conversation);
  assert.deepEqual(plain(afterUnlock.health_context), []);
  assert.deepEqual(JSON.parse(fresh.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context, []);

  const genuinelyNew = await fresh.start();
  assert.notEqual(genuinelyNew.conversation_id, original.conversation_id);
  assert.deepEqual(plain(genuinelyNew.selected_context_ids), [saved.context_id]);
  await fresh.say(genuinelyNew);
  assert.equal(JSON.parse(fresh.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body).health_context[0].context_id, saved.context_id);
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

test('archive and handoff projections retain their own member ID without changing source or confirmation metadata', async () => {
  const h = await harness();
  const self = await h.say(await h.start(), '虚构本人：膝盖有些不舒服。');
  const selfArchive = (await h.request(`/api/conversations/${self.conversation_id}`)).j.conversation;
  assert.equal(selfArchive.subject_id, 'subject_self');

  const registry = await h.subjects();
  const created = await h.request('/api/health-subjects', { label: '妈妈', relationship: 'family', expected_version: registry.version });
  const mom = created.j.subjects.find(subject => subject.label === '妈妈');
  await h.switchTo(mom.subject_id);
  await h.add({ text: '妈妈去年冬天膝盖疼，休息后缓解。', source_kind: 'family_report', confirmed_by: 'family', occurred_on: '2025-12-10' });
  const saved = (await h.memory()).entries[0];
  assert.deepEqual({ subject_id: saved.subject_id, source_kind: saved.source_kind, confirmed_by: saved.confirmed_by,
    confirmation_status: saved.confirmation_status, occurred_on: saved.occurred_on }, {
    subject_id: mom.subject_id, source_kind: 'family_report', confirmed_by: 'family',
    confirmation_status: 'confirmed', occurred_on: '2025-12-10',
  });
  const momConversation = await h.say(await h.start(), '我以前膝盖疼过吗？');
  const momListed = (await h.request('/api/conversations')).j.conversations.find(item => item.conversation_id === momConversation.conversation_id);
  assert.equal(momListed.subject_id, mom.subject_id);
  const reopened = (await h.request(`/api/conversations/${momConversation.conversation_id}`)).j.conversation;
  assert.equal(reopened.subject_id, mom.subject_id);
  assert.equal(reopened.report.status_label, '自动整理 · 本人未核对');
  assert.equal(reopened.turns.find(turn => turn.role === 'elder').source_kind, 'elder');
  assert.equal(reopened.turns.find(turn => turn.role === 'elder').text, '我以前膝盖疼过吗？');

  const handoff = (await h.request('/api/handoffs', {})).j.handoff;
  assert.equal(handoff.conversation_reports.length, 1);
  assert.equal(handoff.conversation_reports[0].subject_id, mom.subject_id);
  assert.equal(handoff.conversation_reports[0].report.status_label, '自动整理 · 本人未核对');
  assert.equal(handoff.conversation_reports[0].transcript.find(turn => turn.role === 'elder').text, '我以前膝盖疼过吗？');

  await h.switchTo('subject_self');
  const legacy = await h.api.vault.get(`conversation:${self.conversation_id}`);
  delete legacy.subject_id;
  await h.api.vault.put(`conversation:${self.conversation_id}`, legacy);
  const legacyArchive = (await h.request(`/api/conversations/${self.conversation_id}`)).j.conversation;
  assert.equal(legacyArchive.subject_id, 'subject_self', 'legacy missing IDs keep the established Self default');
  assert.equal((await h.request('/api/conversations')).j.conversations.find(item => item.conversation_id === self.conversation_id).subject_id,
    'subject_self', 'legacy Self list projection keeps the established default');
});

test('standalone-only and attachments-only handoffs retain the verified active subject ID', async () => {
  const addMom = async h => {
    const registry = await h.subjects();
    const created = await h.request('/api/health-subjects', { label: '妈妈', relationship: 'family', expected_version: registry.version });
    const mom = created.j.subjects.find(subject => subject.label === '妈妈');
    await h.switchTo(mom.subject_id);
    return mom;
  };
  const standalone = await harness(), mom = await addMom(standalone);
  await standalone.request('/api/events', { raw_text: '妈妈的独立合成记录', source_kind: 'elder', actor_name: '老人' });
  const standaloneHandoff = (await standalone.request('/api/handoffs', {})).j.handoff;
  assert.equal(standaloneHandoff.subject_id, mom.subject_id);
  assert.equal(standaloneHandoff.conversation_reports.length, 0);
  assert.equal(standaloneHandoff.items.length, 1);

  const attachmentOnly = await harness(), attachmentMom = await addMom(attachmentOnly);
  const timestamp = new Date().toISOString();
  await attachmentOnly.api.vault.put('media:media_fixture_attachmentonly', {
    media_id: 'media_fixture_attachmentonly', subject_id: attachmentMom.subject_id, kind: 'image',
    content_type: 'image/png', original_filename: 'fictional.png', created_at: timestamp, updated_at: timestamp,
    save_status: 'saved', recognition_status: 'failed', link_status: 'not_linked', version: 1,
    recognition: { error: { code: 'provider_unavailable', retryable: true } }, event_link: null,
  });
  const attachmentHandoff = (await attachmentOnly.request('/api/handoffs', {})).j.handoff;
  assert.equal(attachmentHandoff.subject_id, attachmentMom.subject_id);
  assert.equal(attachmentHandoff.conversation_reports.length, 0);
  assert.equal(attachmentHandoff.items.length, 0);
  assert.equal(attachmentHandoff.media_attachments.length, 1);
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

for (const operation of ['correct', 'revoke', 'delete', 'stop', 'context-clear']) {
  test(`context invalidation prunes only linked controller evidence and survives reopen: ${operation}`, async () => {
    const h = await harness(), oldText = '虚构控制器哨兵：去年曾经干咳一周';
    await h.add({ text: oldText, category: 'similar_episodes' });
    await h.add({ text: '虚构保留背景：平时戴眼镜', category: 'conditions' });
    const [oldEntry, keptEntry] = (await h.memory()).entries;
    const validQuestion = '这次咳嗽影响睡眠吗？', staleQuestion = '您以前那次干咳也出现了吗？';
    const stalePending = '以前咳嗽时有没有痰？';
    let conversation = await h.start();
    conversation = (await h.request(`/api/conversations/${conversation.conversation_id}/context`, { context_ids: [] })).j.conversation;
    h.setResponse(payload => ({ provider: 'SyntheticMechanicalFixture', action: 'ask', assistant_text: validQuestion,
      question_category: 'functional_impact',
      controller: { ...payload.controller, asked_questions: [...payload.controller.asked_questions, validQuestion],
        followup_questions: [validQuestion], linked_context_ids: [], question_count: 4, no_new_fact_count: 3,
        session_id: 'session_preserve_controller', session_anchor_turn_id: 'turn_session_anchor_12345678',
        session_turn_ids: ['turn_session_anchor_12345678'], non_health_sources: [{ turn_id: 'turn_nonhealth_keep_12345678', version: 1, sha256: 'a'.repeat(64) }] } }));
    conversation = await h.say(conversation, '纯虚构：这次咳嗽影响睡眠。');
    conversation = (await h.request(`/api/conversations/${conversation.conversation_id}/context`, { context_ids: [oldEntry.context_id, keptEntry.context_id] })).j.conversation;
    h.setResponse(payload => {
      const latest = payload.turns.at(-1);
      return { provider: 'SyntheticMechanicalFixture', action: 'ask', assistant_text: `我记得${oldText}，${staleQuestion}`,
        question_category: 'relevant_history',
        controller: { ...payload.controller, asked_questions: [...payload.controller.asked_questions, staleQuestion, stalePending],
          followup_questions: [validQuestion, staleQuestion, stalePending], pending_followups: [validQuestion, staleQuestion, stalePending],
          linked_context_ids: [oldEntry.context_id, keptEntry.context_id], question_count: 9, no_new_fact_count: 4,
          question_counts: { ...payload.controller.question_counts, associated_symptoms: 3 },
          grounded_answers: [{ category: 'functional_impact', turn_id: latest.turn_id, version: latest.version, quote: latest.text,
            responding_to: latest.responding_to, question: validQuestion }],
          non_health_sources: [{ turn_id: 'turn_nonhealth_keep_12345678', version: 1, sha256: 'a'.repeat(64) }] } };
    });
    conversation = await h.say(conversation, '昨晚醒来两次。');
    h.setResponse(payload => {
      const latest = payload.turns.at(-1);
      return { provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: `我记得${oldText}，已经记下。`,
        controller: { ...payload.controller, followup_questions: [validQuestion, staleQuestion, stalePending],
          pending_followups: [validQuestion, staleQuestion, stalePending], linked_context_ids: [oldEntry.context_id, keptEntry.context_id],
          grounded_answers: [...(payload.controller.grounded_answers || []), { category: 'associated_symptoms', turn_id: latest.turn_id,
            version: latest.version, quote: latest.text, responding_to: latest.responding_to, question: staleQuestion }] } };
    });
    conversation = await h.say(conversation, '没有。');
    const oldAssistantText = conversation.turns.find(turn => turn.role === 'assistant' && turn.text.includes(oldText)).text;
    assert.ok(oldAssistantText);

    if (operation === 'context-clear') {
      const result = await h.request(`/api/conversations/${conversation.conversation_id}/context`, { context_ids: [keptEntry.context_id] });
      assert.equal(result.r.status, 200); conversation = result.j.conversation;
    } else {
      const version = (await h.memory()).version;
      if (operation === 'delete') {
        assert.equal((await h.request(`/api/health-memory/${oldEntry.context_id}`, { expected_version: version }, 'DELETE')).r.status, 200);
      } else {
        const entry = operation === 'correct' ? h.entry({ text: '虚构更正：去年只是嗓子发干', category: 'similar_episodes' })
          : h.entry({ text: oldText, category: 'similar_episodes', ...(operation === 'revoke' ? { confirmation_status: 'unconfirmed' } : {}), remember: false });
        assert.equal((await h.request(`/api/health-memory/${oldEntry.context_id}`, { expected_version: version, entry }, 'PATCH')).r.status, 200);
      }
      conversation = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
    }

    const storedController = plain(conversation.controller);
    assert.deepEqual(storedController.linked_context_ids, [keptEntry.context_id]);
    assert.deepEqual(storedController.asked_questions, [conversation.turns[0].text, validQuestion]);
    assert.deepEqual(storedController.followup_questions, [validQuestion]);
    assert.deepEqual(storedController.pending_followups, [validQuestion]);
    assert.equal(storedController.question_count, 9); assert.equal(storedController.no_new_fact_count, 4);
    assert.equal(storedController.question_counts.associated_symptoms, 3);
    assert.equal(storedController.session_id, 'session_preserve_controller');
    assert.deepEqual(storedController.session_turn_ids, ['turn_session_anchor_12345678']);
    assert.deepEqual(storedController.non_health_sources, [{ turn_id: 'turn_nonhealth_keep_12345678', version: 1, sha256: 'a'.repeat(64) }]);
    assert.equal(storedController.grounded_answers.length, 1);
    assert.equal(storedController.grounded_answers[0].question, validQuestion);
    assert.ok(conversation.turns.some(turn => turn.role === 'assistant' && turn.text === oldAssistantText), 'original assistant prose remains local');
    const lines = conversation.report.sections.flatMap(section => section.lines);
    const historicalAnswer = lines.find(line => line.answer_context_answer && line.text === '没有。');
    assert.equal(historicalAnswer?.question_binding_current, false);
    assert.match(lines.find(line => line.answer_context_question && line.text.includes(staleQuestion))?.tags?.[0] || '', /助手历史问题 · 已失效/);

    const fresh = await harness(h.driver), reopened = (await fresh.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
    assert.deepEqual(plain(reopened.controller), storedController);
    assert.ok(reopened.turns.some(turn => turn.role === 'assistant' && turn.text === oldAssistantText));
    const currentQuestionTurn = { turn_id: 'turn_current_repeated_question_123456', role: 'assistant', text: staleQuestion,
      action: 'ask', question_category: 'functional_impact', created_at: '2026-10-10T12:00:00.000Z', version: 1,
      model_context_ids: [keptEntry.context_id] };
    await fresh.api.vault.put(`conversation:${conversation.conversation_id}`, { ...reopened,
      turns: [...reopened.turns, currentQuestionTurn],
      controller: { ...reopened.controller, followup_questions: [validQuestion, staleQuestion], pending_followups: [validQuestion, staleQuestion] } });
    const reopenedWithCurrentQuestion = (await fresh.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
    const next = await fresh.start();
    assert.equal(JSON.stringify(next.controller).includes(oldText), false);
    if (operation === 'correct') assert.ok(next.health_context.some(item => item.context_id === oldEntry.context_id && item.text === '虚构更正：去年只是嗓子发干'));
    else if (operation === 'context-clear') assert.ok(next.health_context.some(item => item.context_id === oldEntry.context_id), 'conversation-level deselection does not revoke remember=true');
    else assert.equal(next.health_context.some(item => item.context_id === oldEntry.context_id), false);

    fresh.setResponse(payload => ({ provider: 'SyntheticMechanicalFixture', action: 'ask', assistant_text: '今天还有其他不舒服吗？',
      question_category: 'associated_symptoms', controller: { ...payload.controller, followup_questions: ['今天还有其他不舒服吗？'] } }));
    let current = await fresh.say(reopenedWithCurrentQuestion, '继续说这次的情况。');
    let sent = JSON.parse(fresh.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
    assert.equal(JSON.stringify(sent.controller).includes(oldText), false);
    assert.equal(JSON.stringify(sent.controller).includes(stalePending), false);
    assert.deepEqual(plain(sent.controller.linked_context_ids), [keptEntry.context_id]);
    assert.deepEqual(plain(sent.controller.followup_questions), [validQuestion, staleQuestion]);
    assert.equal(sent.controller.grounded_answers.length, 1);
    assert.equal(sent.turns.at(-1).responding_to.text, staleQuestion, 'a current turn using the same wording remains bindable');
    fresh.setResponse(payload => ({ provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: '好的，我保留您说不清楚。', controller: payload.controller }));
    current = await fresh.say(current, '不清楚。');
    sent = JSON.parse(fresh.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
    assert.equal(sent.turns.at(-1).text, '不清楚。');
    assert.equal(sent.turns.at(-1).responding_to.text, '今天还有其他不舒服吗？', 'a fresh valid unknown-answer binding remains current');
  });
}

for (const questionMode of [false, true]) for (const operation of ['revoke', 'correct', 'delete', 'stop']) {
  test(`withdrawn memory is omitted from later provider context after ${operation}, question=${questionMode}`, async () => {
    const h = await harness(), old = '虚构专用撤回哨兵：去年曾经干咳一周';
    await h.add({ text: old, category: 'similar_episodes' });
    const saved = (await h.memory()).entries[0];
    h.setResponse(() => ({ provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: questionMode
      ? `我记得：${old}，您今天还咳嗽吗？` : `我记得：${old}。这次咳嗽两天了。` }));
    let conversation = await h.say(await h.start(), '这次又咳嗽两天了。');
    assert.ok(conversation.turns.some(turn => turn.role === 'assistant' && turn.text.includes(old)));
    const version = (await h.memory()).version;
    if (operation === 'delete') {
      const result = await h.request(`/api/health-memory/${saved.context_id}`, { expected_version: version }, 'DELETE');
      assert.equal(result.r.status, 200);
    } else {
      const entry = operation === 'correct' ? h.entry({ text: '虚构更正：去年只是嗓子发干', category: 'similar_episodes' })
        : h.entry({ text: old, category: 'similar_episodes', ...(operation === 'revoke' ? { confirmation_status: 'unconfirmed' } : {}), remember: false });
      const result = await h.request(`/api/health-memory/${saved.context_id}`, { expected_version: version, entry }, 'PATCH');
      assert.equal(result.r.status, 200);
    }
    const freshQuestion = '这次咳嗽是否影响睡眠？';
    h.setResponse(payload => ({ provider: 'SyntheticMechanicalFixture', action: 'ask', assistant_text: freshQuestion,
      question_category: 'associated_symptoms', controller: payload.controller }));
    const current = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
    conversation = await h.say(current, questionMode ? '没有。' : '我想继续说今天的情况。');
    let sent = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
    assert.deepEqual(plain(sent.health_context), []);
    assert.equal(JSON.stringify(sent).includes(old), false);
    assert.equal(sent.turns.at(-1).responding_to, null, 'a source whose remembered context changed is no longer a current question');
    assert.ok(conversation.turns.some(turn => turn.role === 'assistant' && turn.text.includes(old)), 'the original assistant wording remains local');

    h.setResponse(payload => ({ provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: '我会记下您还不确定。' }));
    conversation = await h.say(conversation, '不清楚。');
    sent = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
    assert.equal(sent.turns.at(-1).text, '不清楚。');
    const boundSource = conversation.turns.find(turn => turn.turn_id === sent.turns.at(-1).responding_to?.turn_id);
    assert.equal(boundSource?.text, freshQuestion);
    assert.deepEqual(plain(sent.turns.at(-1).responding_to), { turn_id: boundSource?.turn_id, text: freshQuestion },
      'a new unaffected question keeps its precise unknown-answer binding');
  });
}
