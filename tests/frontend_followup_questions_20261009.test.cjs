// Synthetic local API + real AES-GCM over MemoryDocumentStore. Every HTTP call
// is a strict in-process fixture; this is not a browser or model-order claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');
const password = 'synthetic pending questions vault only';
const questions = ['这几天有没有发热？', '这几天有没有气短？', '这几天有没有胸口不舒服？'];
const plain = value => JSON.parse(JSON.stringify(value));
const lines = conversation => conversation.report.sections.flatMap(section => section.lines);
const candidates = conversation => lines(conversation).filter(line => line.candidate_question === true);
const known = (summary, turn) => ({ status: 'known', summary, evidence_turn_ids: [turn.turn_id], context_ids: [] });

async function harness() {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {},
      classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  let response = () => { throw new Error('No synthetic reply registered'); };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL,
    URLSearchParams, AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null },
    fetch: async (path, options = {}) => {
      assert.ok(['/api/app/session', '/api/ai/conversation-turn'].includes(path), 'Unexpected HTTP must fail closed');
      calls.push({ path, ...options });
      const body = path === '/api/app/session'
        ? { authenticated: true, csrf_token: 'synthetic-local-only' }
        : response(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal;
  await api.vault.setup(password);
  const unlock = async () => {
    const ready = api.initialise();
    await new Promise(setImmediate);
    element('vaultPassphrase').value = password;
    await element('vaultForm').onsubmit({ preventDefault() {} });
    await ready;
  };
  await unlock();
  const request = async (path, body) => {
    const result = await api.request(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Idempotency-Key': webcrypto.randomUUID() }, body: JSON.stringify(body),
    });
    assert.equal(result.r.ok, true, JSON.stringify(result.j));
    return result.j;
  };
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-09' })).conversation;
  const say = async (c, text) => (await request(`/api/conversations/${c.conversation_id}/turns`, { text, expected_version: c.version })).conversation;
  const read = async c => (await request(`/api/conversations/${c.conversation_id}`)).conversation;
  return { api, calls, unlock, request, start, say, read, setResponse(fn) { response = fn; } };
}

function reply(payload, pending, action = 'ask', summary = null) {
  const last = payload.turns.at(-1);
  return {
    provider: 'SyntheticOfflineFixture', model_id: 'synthetic-local-fixture', action,
    assistant_text: action === 'ask' ? pending[0] : '原话已保留，未回答的问题留待核实。',
    question_category: action === 'ask' ? 'associated_symptoms' : null,
    controller: { ...payload.controller, followup_questions: [...questions] },
    completeness: { clinical_state: summary ? { associated_symptoms: known(summary, last) }
      : { associated_symptoms: { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] } },
    pending_questions: pending, contradictions: [], relevant_context_ids: [] },
  };
}

async function twoPending(h) {
  h.setResponse(payload => reply(payload, questions));
  let c = await h.say(await h.start(), '纯虚构：咳嗽三天，晚上明显。');
  h.setResponse(payload => reply(payload, questions.slice(1), 'ask', '没有发热'));
  return h.say(c, '纯虚构：没有发热。');
}

function assertPending(c, expected) {
  assert.deepEqual(plain(c.completeness.pending_questions), expected);
  assert.deepEqual(plain(c.report.pending_questions), expected);
  assert.deepEqual(plain(candidates(c).map(line => line.text)), expected);
  for (const line of candidates(c)) {
    assert.equal(line.kind, 'check');
    assert.deepEqual(plain(line.tags), ['助手候选 · 未回答']);
    assert.match(line.source_label, /不是患者陈述/);
    assert.equal(line.source_turn_ids, undefined);
    assert.equal(line.source_context_ids, undefined);
    assert.equal(line.source_versions, undefined);
    assert.ok(c.report.sections.find(section => section.key === 'verification').lines.includes(line));
  }
}

test('candidate history persists and transfers while doctor pending questions decrease 2 → 1 → 0', async () => {
  const h = await harness();
  let c = await twoPending(h);
  assertPending(c, questions.slice(1));
  assert.equal(lines(c).some(line => line.kind === 'summary' && /气短|胸口/.test(line.text)), false);
  assert.ok(lines(c).some(line => line.kind === 'summary' && line.text === '没有发热'));
  const originalSources = plain(c.analysis_sources);
  const calls = h.calls.length;
  const saved = await h.read(c);
  assertPending(saved, questions.slice(1));
  assert.deepEqual(plain(saved.controller.followup_questions), questions);
  assert.deepEqual(plain(saved.analysis_sources), originalSources);
  assert.equal(h.calls.length, calls, 'GET does not call the model');

  h.setResponse(payload => {
    assert.deepEqual(payload.controller.followup_questions, questions);
    assert.equal(payload.turns.at(-1).responding_to.text, questions[1]);
    return reply(payload, questions.slice(2), 'ask', '没有气短');
  });
  c = await h.say(c, '纯虚构：没有气短。');
  assertPending(c, questions.slice(2));
  h.setResponse(payload => {
    assert.equal(payload.turns.at(-1).responding_to.text, questions[2]);
    return reply(payload, [], 'finish', '没有胸口不舒服');
  });
  c = await h.say(c, '纯虚构：没有胸口不舒服，先这样。');
  assertPending(c, []);
  assert.deepEqual(plain(c.controller.followup_questions), questions, 'Answered candidates remain candidate history');
  assert.equal(c.turns.at(-1).action, 'finish');
  assert.equal(c.turns.filter(turn => turn.role === 'elder').length, 4);
});

test('pending candidates survive lock/unlock and encrypted backup restore into an empty vault', async () => {
  const h = await harness(), c = await twoPending(h), calls = h.calls.length;
  const expected = plain(c);
  const docs = await h.api.vault.driver.listDocs();
  assert.equal(JSON.stringify(docs).includes(questions[1]), false, 'No plaintext candidate in encrypted documents');
  h.api.lock();
  await assert.rejects(h.api.vault.get('conversation:' + c.conversation_id), /vault_locked/);
  await h.unlock();
  assert.deepEqual(plain(await h.read(c)), expected);
  assert.equal(h.calls.length, calls);
  const archive = await h.api.vault.exportArchive();
  assert.equal(JSON.stringify(archive).includes(questions[1]), false);
  const fresh = await harness();
  assert.deepEqual(await fresh.api.vault.list('conversation:'), []);
  const file = new Blob([JSON.stringify(archive)]);
  const preview = await fresh.api.previewBackup(file, password);
  await fresh.api.restoreBackup(preview, password);
  const restored = await fresh.read(c);
  assert.deepEqual(plain(restored), expected);
  assertPending(restored, questions.slice(1));
  assert.equal(fresh.calls.length, 0, 'Fresh restore and GET use no network');
  const handoff = (await fresh.request('/api/handoffs', { record_ids: c.turns.filter(turn => turn.role === 'elder').map(turn => turn.record_id) })).handoff;
  assertPending({ ...restored, report: handoff.conversation_reports[0].report }, questions.slice(1));
  assert.deepEqual(plain(handoff.conversation_reports[0].completeness.pending_questions), questions.slice(1));
  assert.equal(fresh.calls.length, 0, 'Handoff uses no network');
});

test('unknown at explicit finish retains candidates as unanswered and never invents a denial', async () => {
  const h = await harness();
  h.setResponse(payload => reply(payload, questions));
  let c = await h.say(await h.start(), '纯虚构：咳嗽三天。');
  h.setResponse(payload => reply(payload, questions, 'finish'));
  c = await h.say(c, '纯虚构：我不清楚，先这样。');
  assertPending(c, questions);
  assert.equal(c.turns.at(-1).action, 'finish');
  assert.equal(c.completeness.clinical_state.associated_symptoms.status, 'missing');
  assert.equal(lines(c).some(line => line.kind === 'summary'), false);
  const patientFacts = lines(c).filter(line => !line.candidate_question).map(line => line.text)
    .concat(c.report.transcript.filter(turn => turn.role === 'elder').map(turn => turn.text)).join('\n');
  assert.doesNotMatch(patientFacts, /没有发热|没有气短|没有胸口|一切正常|信息已完整/);
  assert.ok(c.report.transcript.some(turn => turn.text === '纯虚构：我不清楚，先这样。'));
});

test('pending-only changes and legacy or mistagged candidate caches rebuild locally without changing sources', async () => {
  const h = await harness(), c = await twoPending(h), calls = h.calls.length;
  const key = 'conversation:' + c.conversation_id;
  const changed = plain(c);
  changed.completeness.pending_questions = questions.slice(2);
  await h.api.vault.put(key, changed);
  const reduced = await h.read(c);
  assertPending(reduced, questions.slice(2));
  assert.equal(reduced.report.report_id, c.report.report_id);
  assert.equal(reduced.report.version, c.report.version + 1);
  assert.deepEqual(plain(reduced.analysis_sources), plain(c.analysis_sources));
  assert.deepEqual(plain(reduced.turns), plain(c.turns));
  const legacy = plain(reduced);
  delete legacy.report.pending_questions;
  legacy.report.sections.forEach(section => { section.lines = section.lines.filter(line => !line.candidate_question); });
  await h.api.vault.put(key, legacy);
  const migrated = await h.read(c);
  assertPending(migrated, questions.slice(2));
  const mislabeled = plain(migrated);
  candidates(mislabeled)[0].tags = ['患者阳性'];
  await h.api.vault.put(key, mislabeled);
  const repaired = await h.read(c);
  assertPending(repaired, questions.slice(2));
  assert.doesNotMatch(repaired.report.body, /患者阳性/);
  const misplaced = plain(repaired);
  const candidate = candidates(misplaced)[0];
  misplaced.report.sections.find(section => section.key === 'verification').lines =
    misplaced.report.sections.find(section => section.key === 'verification').lines.filter(line => !line.candidate_question);
  misplaced.report.sections.unshift({ key: 'chief_complaint', title: '主要不适', lines: [
    { ...candidate, source_turn_ids: [c.turns.find(turn => turn.role === 'elder').turn_id] },
  ] });
  await h.api.vault.put(key, misplaced);
  const confined = await h.read(c);
  assertPending(confined, questions.slice(2));
  assert.deepEqual(plain(confined.turns), plain(c.turns));
  await h.api.vault.put(key, confined);
  assert.equal((await h.read(c)).report.version, confined.report.version, 'Current pending cache is reused');
  assert.equal(h.calls.length, calls);
});

test('edited source versions or missing bindings cannot reuse old pending candidates as current analysis', async () => {
  const h = await harness(), c = await twoPending(h), calls = h.calls.length;
  const key = 'conversation:' + c.conversation_id;
  for (const change of ['version', 'quote', 'missing-binding']) {
    const changed = plain(c);
    const elder = changed.turns.find(turn => turn.role === 'elder');
    if (change === 'version') elder.version += 1;
    if (change === 'quote') elder.text = '纯虚构：头晕，原说法已纠正。';
    if (change === 'missing-binding') delete changed.analysis_sources;
    await h.api.vault.put(key, changed);
    const current = await h.read(c);
    assert.equal(current.completeness, null, change);
    assert.deepEqual(plain(current.report.pending_questions), [], change);
    assert.equal(candidates(current).length, 0, change);
    assert.deepEqual(plain(current.controller.followup_questions), questions, 'Stored candidate history is not a current patient fact');
    assert.ok(current.report.transcript.some(turn => turn.text === elder.text && turn.version === elder.version));
  }
  assert.equal(h.calls.length, calls);
});

test('a selected background version change invalidates pending questions before a new model reply', async () => {
  const h = await harness();
  const entry = (await h.request('/api/health-context', { fields: { conditions: ['纯虚构：已确认旧背景'] } })).health_context.entries[0];
  let c = await h.start();
  c = (await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [entry.context_id] })).conversation;
  h.setResponse(payload => reply(payload, questions));
  c = await h.say(c, '纯虚构：咳嗽三天。');
  assertPending(c, questions);
  const calls = h.calls.length;
  await h.request('/api/health-context', { fields: { conditions: ['纯虚构：已确认新背景'] } });
  const changed = await h.read(c);
  assert.equal(changed.completeness, null);
  assert.equal(candidates(changed).length, 0);
  assert.deepEqual(plain(changed.report.pending_questions), []);
  assert.equal(h.calls.length, calls);
});

test('untrusted candidate strings are bounded, deduplicated and confined to unanswered metadata', async () => {
  const h = await harness(), safe = '是否记得上次描述的时间？';
  const invalid = [null, { text: questions[1] }, '<script>alert(1)</script>？', '第一项？第二项？',
    '您应该服用两片药吗？', 'x'.repeat(160) + '？', '是否\u0000记得？', '是否\u200b记得？', '无问号'];
  h.setResponse(payload => ({ ...reply(payload, [], 'finish'),
    completeness: { clinical_state: {}, pending_questions: [safe, safe, ...invalid], contradictions: [] } }));
  let c = await h.say(await h.start(), '纯虚构：今天不舒服，情况待核对。');
  assert.deepEqual(plain(c.report.pending_questions), [safe]);
  assert.deepEqual(plain(candidates(c).map(line => line.text)), [safe]);
  assert.doesNotMatch(c.report.body, /<script>|服用两片|第一项|患者阳性/);
  const source = plain(c);
  source.completeness.pending_questions = Array(13).fill(safe);
  await h.api.vault.put('conversation:' + c.conversation_id, source);
  c = await h.read(c);
  assert.deepEqual(plain(c.report.pending_questions), [], 'Oversized metadata fails closed');
  assert.equal(candidates(c).length, 0);
});
