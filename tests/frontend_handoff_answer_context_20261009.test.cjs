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
const questions = ['这几天有没有发烧？', '这几天有没有喘不上气？', '这几天有没有胸口不舒服？'];
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

function reply(payload, pending, action = 'ask') {
  return { provider: 'SavedSyntheticProvider', model_id: 'offline-fixture', action,
    assistant_text: action === 'ask' ? pending[0] : '原话已保留，未回答的问题留待核实。',
    question_category: action === 'ask' ? 'associated_symptoms' : null,
    controller: { ...payload.controller, followup_questions: questions },
    completeness: { clinical_state: {}, pending_questions: pending, contradictions: [], relevant_context_ids: [] } };
}
async function initial(h) {
  h.setResponse(p => reply(p, questions));
  return h.say(await h.start(), '纯虚构：咳嗽三天，晚上明显。');
}
const coverage = c => c.report.question_coverage;
const shortPairs = c => lines(c).filter(line => line.answer_context_answer);
const patientTexts = c => lines(c).filter(line => !line.answer_context_question && !line.candidate_question).map(line => line.text).join('\n');
function assertPending(c, expected) {
  assert.deepEqual(plain(c.report.pending_questions), expected);
  assert.deepEqual(plain(candidates(c).map(line => line.text)), expected);
  assert.deepEqual(plain(coverage(c).pending_questions), expected);
  assert.equal(coverage(c).kind, 'assistant_question_coverage_not_clinical_facts');
  for (const line of candidates(c)) {
    assert.equal(line.kind, 'check');
    assert.match(line.source_label, /不是.*患者/);
    assert.equal(line.source_versions, undefined);
    assert.equal(line.source_turn_ids, undefined);
  }
}
async function feverNo(h, c) {
  h.setResponse(p => reply(p, questions.slice(1)));
  return h.say(c, '没有。');
}

test('three actual short answers print their actual assistant questions and patient IDs/versions/full quotes', async () => {
  const h = await harness();
  let c = await initial(h);
  for (let index = 0; index < questions.length; index++) {
    h.setResponse(p => {
      const result = reply(p, questions.slice(index + 1), index === 2 ? 'finish' : 'ask');
      result.completeness.clinical_state.associated_symptoms = { status: 'known', summary: Array(index + 1).fill('没有。').join('；'),
        evidence_turn_ids: p.turns.filter(turn => turn.text === '没有。').map(turn => turn.turn_id), context_ids: [] };
      return result;
    });
    c = await h.say(c, '没有。');
    assert.equal(lines(c).some(line => line.kind === 'summary' && /^(?:没有。[；]?)+$/.test(line.text)), false,
      'Single and combined short answers are presented only with their actual questions');
  }
  assertPending(c, []);
  assert.equal(c.completeness.clinical_state.associated_symptoms.summary, '没有。；没有。；没有。', 'Backend state is retained as received');
  assert.equal(lines(c).some(line => line.kind === 'summary' && line.text === '没有。'), false,
    'A short No is presented with its question rather than as a standalone summary');
  assert.doesNotMatch(c.report.sections.find(section => section.key === 'verification').lines
    .filter(line => !line.candidate_question).map(line => line.text).join('\n'), /尚未问清：[^。]*是否同时出现其他身体变化/,
  'Suppressing a short summary is display-only and does not undo the grounded backend category');
  const pairs = shortPairs(c);
  assert.equal(pairs.length, 3);
  for (const [index, pair] of pairs.entries()) {
    const source = c.turns.find(turn => turn.turn_id === pair.source_turn_ids[0]);
    const actual = c.turns.find(turn => turn.turn_id === source.responding_to.turn_id);
    assert.deepEqual(plain(pair.source_versions), [{ turn_id: source.turn_id, version: 1, quote: '没有。' }]);
    assert.equal(pair.text, source.text);
    assert.deepEqual(plain(pair.question_source), { turn_id: actual.turn_id, version: actual.version, quote: actual.text });
    assert.equal(actual.text, questions[index]);
    assert.equal(pair.question_binding_current, true);
    assert.ok(c.report.body.includes(questions[index]), 'Normal report sections are used for print');
    assert.match(pair.source_label, /对应助手问题/);
    const q = lines(c).find(line => line.answer_context_question && line.question_source.turn_id === actual.turn_id);
    assert.match(q.tags[0], /助手实际问题.*非患者陈述/);
    assert.equal(q.source_turn_ids, undefined);
  }
  assert.doesNotMatch(patientTexts(c), /没有发烧|没有喘不上气|没有胸口不舒服/);
  const calls = h.calls.length;
  const handoff = (await h.request('/api/handoffs', {})).handoff.conversation_reports[0];
  assert.deepEqual(plain(handoff.report.sections), plain(c.report.sections));
  assert.equal(h.calls.length, calls);
});

test('current danger resolves its literal saved topic only and keeps the other two questions visible without clinical analysis', async () => {
  const h = await harness(), c = await initial(h), calls = h.calls.length;
  const urgent = await h.say(c, '我现在喘不上气，结束吧。');
  assert.equal(urgent.turns.at(-1).action, 'urgent');
  assert.equal(urgent.completeness, null);
  assert.equal(urgent.analysis_sources, null);
  assertPending(urgent, [questions[0], questions[2]]);
  assert.deepEqual(plain(coverage(urgent).resolved_questions.map(item => item.question)), [questions[1]]);
  assert.equal(h.calls.length, calls, 'Local danger calls no HTTP/provider');
  assert.ok(urgent.report.sections.find(section => section.key === 'verification').lines.some(line => line.kind === 'alert'));
  assert.ok(urgent.report.body.includes(questions[0]) && urgent.report.body.includes(questions[2]));
  assert.equal(lines(urgent).some(line => line.kind === 'summary'), false, 'No stale clinical summary is revived');
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  const exclaimed = await h.say(c, '我现在喘不上气！结束吧。');
  assertPending(exclaimed, [questions[0], questions[2]]);
  assert.equal(coverage(exclaimed).resolved_questions[0].answer_source.quote, '我现在喘不上气！结束吧。');
  assert.equal(h.calls.length, calls);
});

test('actual fever No then current danger leaves only chest; editing that answer to unknown v2 reopens fever', async () => {
  const h = await harness();
  let c = await feverNo(h, await initial(h));
  const no = c.turns.find(turn => turn.role === 'elder' && turn.text === '没有。');
  const nomination = plain(coverage(c).candidates[0].nomination);
  const calls = h.calls.length;
  c = await h.say(c, '我现在喘不上气，结束吧。');
  assertPending(c, [questions[2]]);
  c = (await h.request(`/api/conversations/${c.conversation_id}/turns/${no.turn_id}/edit`, { text: '不知道。', expected_version: no.version, expected_conversation_version: c.version })).conversation;
  assert.equal(c.turns.find(turn => turn.turn_id === no.turn_id).version, 2);
  assert.equal(c.completeness, null);
  assertPending(c, [questions[0], questions[2]]);
  assert.deepEqual(plain(coverage(c).candidates[0].nomination), nomination, 'Answer edits do not rebind nomination anchors');
  assert.deepEqual(plain(coverage(c).resolved_questions.map(item => item.question)), [questions[1]]);
  assert.equal(coverage(c).sources.turns.find(turn => turn.turn_id === no.turn_id).quote, '不知道。');
  assert.equal(shortPairs(c).find(pair => pair.source_turn_ids.includes(no.turn_id)).text, '不知道。');
  assert.equal(h.calls.length, calls);
});

test('mixed unknown and current danger are handled per saved topic; unknown/decline/history/third-person/meta do not become No', async () => {
  const h = await harness(), start = await initial(h);
  const c = await h.say(start, '发烧我不知道，但我现在喘不上气，结束吧。');
  assertPending(c, [questions[0], questions[2]]);
  assert.deepEqual(plain(coverage(c).resolved_questions.map(item => item.question)), [questions[1]]);
  assert.doesNotMatch(patientTexts(c), /没有发烧|没有胸口/);
  for (const text of ['我不知道。', '我不想说发烧。', '以前我喘不上气。', '我妈妈发烧，喘不上气。',
    '还没告诉您有没有发烧。', '你为什么问我发烧？', '如果我现在喘不上气怎么办？']) {
    const original = plain(start);
    await h.api.vault.put('conversation:' + original.conversation_id, original);
    h.setResponse(p => reply(p, questions));
    const got = await h.say(original, text);
    assert.deepEqual(plain(coverage(got).resolved_questions), [], text);
    assertPending(got, questions);
  }
});

test('unknown answer then danger retains fever/chest and never rewrites unknown into a denial', async () => {
  const h = await harness();
  let c = await initial(h);
  h.setResponse(p => reply(p, questions));
  c = await h.say(c, '不知道。');
  c = await h.say(c, '我现在喘不上气，结束吧。');
  assertPending(c, [questions[0], questions[2]]);
  assert.equal(shortPairs(c)[0].text, '不知道。');
  assert.doesNotMatch(patientTexts(c), /没有发烧|信息已完整|一切正常/);
});

test('current danger does not reopen a real fever answer because another clause is third-person or historical unknown', async () => {
  const h = await harness(), start = await feverNo(h, await initial(h));
  const calls = h.calls.length;
  for (const text of ['我现在喘不上气，家人发烧我不知道。', '我现在喘不上气，以前发烧时我不知道怎么办。',
    '我现在喘不上气，但我现在不清楚妈妈有没有发烧。', '我现在喘不上气，但我现在不知道以前有没有发烧。']) {
    await h.api.vault.put('conversation:' + start.conversation_id, start);
    const got = await h.say(start, text);
    assert.equal(got.turns.at(-1).action, 'urgent');
    assertPending(got, [questions[2]]);
    assert.deepEqual(plain(coverage(got).resolved_questions.map(item => item.question)), questions.slice(0, 2));
    assert.equal(coverage(got).resolved_questions[0].answer_source.quote, '没有。');
    assert.equal(got.completeness, null);
  }
  assert.equal(h.calls.length, calls);
});

test('paired source binding rejects forged/missing/duplicate/edited questions and cache rechecks both sides', async () => {
  const h = await harness(), c = await feverNo(h, await initial(h)), key = 'conversation:' + c.conversation_id;
  const noIndex = c.turns.findIndex(turn => turn.role === 'elder' && turn.text === '没有。');
  for (const mutation of ['wrong-id', 'wrong-text', 'missing', 'duplicate', 'edited-assistant', 'question-version', 'mock', 'superseded']) {
    const changed = plain(c), no = changed.turns[noIndex], assistant = changed.turns[noIndex - 1];
    changed.completeness = null;
    if (mutation === 'wrong-id') no.responding_to.turn_id = 'turn_forged';
    if (mutation === 'wrong-text') no.responding_to.text = questions[2];
    if (mutation === 'missing') delete no.responding_to;
    if (mutation === 'duplicate') changed.turns.unshift({ ...assistant });
    if (mutation === 'edited-assistant') { assistant.text = questions[2]; assistant.version += 1; }
    if (mutation === 'question-version') assistant.version += 1;
    if (mutation === 'mock') assistant.is_mock = true;
    if (mutation === 'superseded') assistant.superseded = true;
    await h.api.vault.put(key, changed);
    const got = await h.read(c);
    assert.ok(got.report.version > c.report.version, mutation);
    assert.equal(coverage(got).resolved_questions.some(item => item.answer_source.turn_id === no.turn_id), false, mutation);
    if (mutation === 'superseded') {
      assert.equal(shortPairs(got)[0].question_binding_current, false);
      assert.match(lines(got).find(line => line.answer_context_question).tags[0], /历史.*已失效/);
    } else assert.equal(shortPairs(got).length, 0, mutation);
  }
  await h.api.vault.put(key, c);
  const cached = await h.read(c);
  assert.equal(cached.report.version, c.report.version);
});

test('changed nomination complaint or selected context retains labeled historical questions and no clinical state', async () => {
  const h = await harness();
  const entry = (await h.request('/api/health-context', { fields: { similar_episodes: ['纯虚构：曾有相似经历'] } })).health_context.entries[0];
  let c = await h.start();
  c = (await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [entry.context_id] })).conversation;
  h.setResponse(p => reply(p, questions));
  c = await h.say(c, '纯虚构：咳嗽三天。');
  const origin = plain(coverage(c).candidates[0].nomination);
  await h.request('/api/health-context', { fields: { similar_episodes: ['纯虚构：背景已改'] } });
  const got = await h.read(c);
  assert.equal(got.completeness, null);
  assertPending(got, questions);
  assert.deepEqual(plain(coverage(got).candidates[0].nomination), origin);
  assert.deepEqual(plain(coverage(got).historical_scope_questions), questions);
  assert.ok(candidates(got).every(line => /历史/.test(line.tags[0]) && /未确认与当前主诉相关/.test(line.source_label)));
  const chief = c.turns.find(turn => turn.role === 'elder');
  h.setResponse(() => { throw new Error('Synthetic offline model unavailable after source edit'); });
  const edited = (await h.request(`/api/conversations/${c.conversation_id}/turns/${chief.turn_id}/edit`, { text: '纯虚构：主诉已改，原说法作废。', expected_version: chief.version, expected_conversation_version: c.version })).conversation;
  assertPending(edited, questions);
  assert.equal(edited.completeness, null);
  assert.ok(candidates(edited).every(line => /历史/.test(line.tags[0])));
});

test('AES vault refresh/lock/export/fresh restore preserve urgent coverage and actual paired sources with zero external calls', async () => {
  const h = await harness();
  let c = await feverNo(h, await initial(h));
  c = await h.say(c, '我现在喘不上气，结束吧。');
  const expected = plain(c), calls = h.calls.length;
  assert.deepEqual(plain(await h.read(c)), expected);
  h.api.lock();
  await assert.rejects(h.api.vault.get('conversation:' + c.conversation_id), /vault_locked/);
  await h.unlock();
  assert.deepEqual(plain(await h.read(c)), expected);
  const archive = await h.api.vault.exportArchive();
  assert.equal(JSON.stringify(archive).includes(questions[0]), false);
  const fresh = await harness(), file = new Blob([JSON.stringify(archive)]);
  await fresh.api.restoreBackup(await fresh.api.previewBackup(file, password), password);
  const got = await fresh.read(c);
  assert.deepEqual(plain(got), expected);
  assertPending(got, [questions[2]]);
  const handoff = (await fresh.request('/api/handoffs', {})).handoff.conversation_reports[0];
  assert.deepEqual(plain(handoff.report), expected.report);
  assert.equal(fresh.calls.length, 0);
  assert.equal(h.calls.length, calls);
});

test('literal coverage uses arbitrary saved question topics and rejects cross-conversation receipts', async () => {
  const h = await harness(), generic = ['有没有红色方块？', '有没有圆形按钮？'];
  h.setResponse(p => ({ ...reply(p, generic), controller: { ...p.controller, followup_questions: generic } }));
  let c = await h.say(await h.start(), '纯虚构：屏幕需要核实。');
  h.setResponse(p => ({ ...reply(p, generic.slice(1)), controller: { ...p.controller, followup_questions: generic } }));
  c = await h.say(c, '没有。');
  assert.equal(coverage(c).resolved_questions[0].question, generic[0]);
  const changed = plain(c);
  changed.completeness = null;
  changed.controller.followup_questions = [];
  changed.report.question_coverage.conversation_id = 'conversation_other';
  await h.api.vault.put('conversation:' + c.conversation_id, changed);
  const got = await h.read(c);
  assert.deepEqual(plain(got.report.pending_questions), []);
  assert.equal(coverage(got).candidates.length, 0);
  assert.equal(got.report.body.includes(generic[1]), false, 'Another conversation receipt is not adopted');
});

test('synthetic legacy urgent data without a nomination receipt stays explicitly unverified history, not reauthenticated clinical state', async () => {
  const h = await harness();
  const c = plain(await h.say(await initial(h), '我现在喘不上气，结束吧。'));
  delete c.report.question_coverage;
  assert.equal(c.report.question_coverage, undefined);
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  const calls = h.calls.length;
  const got = await h.read(c);
  assert.equal(got.completeness, null);
  assert.equal(got.analysis_sources, null);
  assert.deepEqual(plain(coverage(got).resolved_questions), []);
  assert.equal(coverage(got).candidates.length, 3);
  assert.ok(coverage(got).candidates.every(item => item.nomination.origin_verified === false));
  assert.ok(candidates(got).every(line => /历史/.test(line.tags[0]) && /来源范围已变或未确认/.test(line.source_label)));
  assert.deepEqual(plain(got.turns), c.turns, 'Synthetic legacy raw/IDs/questions remain unchanged');
  assert.equal(h.calls.length, calls);
});

test('damaged nomination anchors fail closed without breaking GET; superseded or duplicate origins cannot authenticate coverage', async () => {
  const h = await harness(), c = await feverNo(h, await initial(h));
  const key = 'conversation:' + c.conversation_id;
  for (const mutation of ['null-anchor', 'empty-anchors', 'duplicate-anchor', 'future-anchor', 'superseded-origin',
    'duplicate-origin', 'unsafe-question', 'oversized-history']) {
    const changed = plain(c);
    changed.completeness = null;
    const origin = changed.report.question_coverage.candidates[0].nomination;
    if (mutation === 'null-anchor') origin.patient_sources.push(null);
    if (mutation === 'empty-anchors') origin.patient_sources = [];
    if (mutation === 'duplicate-anchor') origin.patient_sources.push({ ...origin.patient_sources[0] });
    if (mutation === 'future-anchor') {
      const no = changed.turns.find(turn => turn.role === 'elder' && turn.text === '没有。');
      origin.patient_sources = [{ turn_id: no.turn_id, version: no.version, quote: no.text }];
    }
    if (mutation === 'superseded-origin') changed.turns.find(turn => turn.turn_id === origin.assistant_source.turn_id).superseded = true;
    if (mutation === 'duplicate-origin') changed.turns.unshift({ ...changed.turns.find(turn => turn.turn_id === origin.assistant_source.turn_id) });
    if (mutation === 'unsafe-question') changed.report.question_coverage.candidates[0].question = '<script>bad()</script>？';
    if (mutation === 'oversized-history') changed.report.question_coverage.candidates = Array(13).fill(changed.report.question_coverage.candidates[0]);
    await h.api.vault.put(key, changed);
    const got = await h.read(c);
    assert.equal(got.completeness, null, mutation);
    assert.equal(coverage(got).resolved_questions.some(item => item.question === questions[0]), false, mutation);
    assert.ok(got.report.pending_questions.includes(questions[0]), mutation);
    assert.ok(candidates(got).find(line => line.text === questions[0]).tags[0].includes('历史'), mutation);
    assert.doesNotMatch(got.report.body, /<script>|bad\(\)/);
  }
});

test('duplicate patient IDs or invalid current versions cannot reduce pending; duplicate candidate history is deduplicated', async () => {
  const h = await harness(), c = await h.say(await initial(h), '我现在喘不上气，结束吧。');
  const key = 'conversation:' + c.conversation_id;
  for (const change of ['duplicate-patient', 'invalid-version', 'duplicate-candidate']) {
    const bad = plain(c), danger = bad.turns.find(turn => turn.role === 'elder' && turn.text.includes('我现在喘不上气'));
    if (change === 'duplicate-patient') bad.turns.push({ ...danger });
    if (change === 'invalid-version') danger.version = 0;
    if (change === 'duplicate-candidate') bad.report.question_coverage.candidates.push({ ...bad.report.question_coverage.candidates[0] });
    await h.api.vault.put(key, bad);
    const got = await h.read(c);
    assertPending(got, change === 'duplicate-candidate' ? [questions[0], questions[2]] : questions);
    assert.equal(coverage(got).candidates.length, 3);
  }
});
