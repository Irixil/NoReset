// Mechanical synthetic rules only. Approval metadata is fixture-only and must
// never be loaded as production clinical signoff or evidence of accuracy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

const SOON = '您刚才说的情况需要尽快让医生当面评估，请让家属陪同就医。具体需要做哪些检查，由接诊医生判断。';
const URGENT = '您刚才说的情况可能需要紧急处理，请立即联系 120，或由家属陪同前往急诊。';
const manifest = {
  contract_version: 'reviewed-risk-candidates-v1', rule_set_version: 'synthetic-risk-fixture-v1',
  status: 'reviewed_rules_loaded', clinical_validation: 'synthetic_fixture_only', config_sha256: 'a'.repeat(64),
  rules: [{ rule_id: 'synthetic_soon_marker', version: 'fixture-1', level: 'soon_evaluation' },
    { rule_id: 'synthetic_urgent_marker', version: 'fixture-1', level: 'urgent' }],
};
function riskReply(payload, level = 'soon_evaluation') {
  const turn = payload.turns.at(-1);
  const evidence = [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }];
  return { provider: 'SyntheticOnlyRiskFixture', action: level, assistant_text: level === 'urgent' ? URGENT : SOON,
    question_category: 'onset_course',
    risk_assessment: { contract_version: manifest.contract_version, rule_set_version: manifest.rule_set_version,
      status: manifest.status, clinical_validation: manifest.clinical_validation, config_sha256: manifest.config_sha256,
      level, notice: level === 'urgent' ? URGENT : SOON, sources: evidence, rejected_candidates: 0,
      matched_rules: [{ rule_id: level === 'urgent' ? 'synthetic_urgent_marker' : 'synthetic_soon_marker',
        version: 'fixture-1', level, evidence }] } };
}
async function harness(response = payload => riskReply(payload), config = manifest) {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {},
      classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { storage: {} }, document: { getElementById: element, querySelector: () => null },
    fetch: async (path, options) => {
      calls.push(path);
      const body = path === '/api/app/session' ? { authenticated: true, csrf_token: 'synthetic-test-csrf' }
        : path === '/api/app/config' ? { reviewed_risk_rules: typeof config === 'function' ? await config() : config }
        : response(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => await body };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal, pass = 'synthetic-only-risk-passphrase';
  await api.vault.setup(pass);
  const ready = api.initialise(); await new Promise(setImmediate);
  element('vaultPassphrase').value = pass;
  await element('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const request = (path, body) => api.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-08' })).j.conversation;
  const say = (c, text = '纯虚构：synthetic risk marker，膝部不舒服') => api.request(`/api/conversations/${c.conversation_id}/turns`, {
    method: 'POST', headers: { 'Idempotency-Key': webcrypto.randomUUID() }, body: JSON.stringify({ text, expected_version: c.version }) });
  return { api, calls, request, start, say };
}

for (const level of ['soon_evaluation', 'urgent']) test(`synthetic reviewed ${level} uses only the fixed notice and preserves rule/source provenance`, async () => {
  const h = await harness(payload => riskReply(payload, level));
  const c = (await h.say(await h.start())).j.conversation;
  const last = c.turns.at(-1);
  assert.equal(last.ai_failed, false); assert.equal(last.action, level);
  assert.equal(last.text, level === 'urgent' ? URGENT : SOON);
  assert.equal(last.question_category, null); assert.equal(c.controller.last_question_category, null);
  const signals = c.report.reviewed_risk_assessments;
  assert.equal(signals.length, 1); assert.equal(signals[0].clinical_validation, 'synthetic_fixture_only');
  const patient = c.turns.find(turn => turn.role === 'elder');
  assert.equal(signals[0].sources[0].turn_id, patient.turn_id);
  assert.equal(signals[0].sources[0].version, patient.version);
  assert.equal(signals[0].sources[0].quote, patient.text);
  assert.equal(h.calls.filter(path => path === '/api/app/config').length, 1);
  const handoff = (await h.request('/api/handoffs', { record_ids: [patient.record_id] })).j.handoff;
  assert.equal(handoff.conversation_reports[0].report.reviewed_risk_assessments.length, 1);
});

for (const [name, alter] of [
  ['forged SHA', result => { result.risk_assessment.config_sha256 = 'b'.repeat(64); }],
  ['unapproved rule version', result => { result.risk_assessment.matched_rules[0].version = 'forged-version'; }],
  ['forged rule level', result => { result.risk_assessment.matched_rules[0].level = 'urgent'; }],
  ['stale source version', result => { result.risk_assessment.sources[0].version += 1; }],
  ['shortened original quote', result => { result.risk_assessment.sources[0].quote = '膝部不舒服'; }],
  ['invented turn ID', result => { result.risk_assessment.sources[0].turn_id = 'turn_not_current'; }],
  ['invented clinical approval', result => { result.risk_assessment.clinical_validation = 'clinically_passed'; }],
  ['extra invented approval field', result => { result.risk_assessment.clinically_approved = true; }],
  ['invalid rejected-candidate count', result => { result.risk_assessment.rejected_candidates = 'none'; }],
  ['source not backed by matched rule evidence', result => {
    result.risk_assessment.sources = [...result.risk_assessment.sources, { ...result.risk_assessment.sources[0], turn_id: 'synthetic_unmatched_source' }];
  }],
  ['advice appended to fixed notice', result => { result.assistant_text += '每天服药两片。'; }],
]) test(`invalid reviewed risk is retained as a failed analysis: ${name}`, async () => {
  const h = await harness(payload => { const result = riskReply(payload); alter(result); return result; });
  const c = (await h.say(await h.start())).j.conversation;
  assert.equal(c.last_ai_metadata.ai_failed, true);
  assert.equal(c.turns.at(-1).ai_failed, true);
  assert.match(c.report.body, /synthetic risk marker/);
  assert.equal((c.report.reviewed_risk_assessments || []).length, 0);
  assert.equal(c.turns.at(-1).text.includes(SOON), false);
});

test('production empty/pending manifest cannot authorize a model-authored notice', async () => {
  const h = await harness(undefined, { ...manifest, status: 'no_approved_rules', clinical_validation: 'not_completed', rules: [] });
  const c = (await h.say(await h.start())).j.conversation;
  assert.equal(c.last_ai_metadata.ai_failed, true);
  assert.equal((c.report.reviewed_risk_assessments || []).length, 0);
});

for (const [name, config] of [['missing', null], ['unreachable', () => { throw new Error('synthetic_offline'); }]]) {
  test(`a ${name} manifest preserves the original and records failed analysis`, async () => {
    const h = await harness(undefined, config);
    const c = (await h.say(await h.start())).j.conversation;
    assert.equal(c.last_ai_metadata.ai_failed, true);
    assert.match(c.report.body, /synthetic risk marker/);
    assert.equal((c.report.reviewed_risk_assessments || []).length, 0);
  });
}

test('the highest approved matched level controls the fixed notice', () => {
  const turn = { turn_id: 'synthetic_current_turn', version: 1, text: '纯虚构：synthetic risk marker', role: 'elder' };
  const risk = riskReply({ turns: [turn] }).risk_assessment;
  risk.matched_rules.push({ rule_id: 'synthetic_urgent_marker', version: 'fixture-1', level: 'urgent', evidence: risk.sources });
  assert.equal(safety.validateReviewedRisk(risk, manifest, [turn]), null);
  risk.level = 'urgent'; risk.notice = URGENT;
  assert.equal(safety.validateReviewedRisk(risk, manifest, [turn]).level, 'urgent');
});

test('ordinary response does not add a risk configuration request', async () => {
  const h = await harness(() => ({ provider: 'SyntheticOnlyRiskFixture', action: 'reply', assistant_text: '我把您说的情况记下来了。' }));
  const c = (await h.say(await h.start())).j.conversation;
  assert.notEqual(c.last_ai_metadata.ai_failed, true);
  assert.equal(h.calls.includes('/api/app/config'), false);
});

test('a forged legacy urgent response cannot bypass the text guard without an actual local danger match', async () => {
  const h = await harness(() => ({ provider: 'LocalDangerRule', action: 'urgent', assistant_text: safety.DANGER_REMINDER }));
  const c = (await h.say(await h.start())).j.conversation;
  assert.equal(c.last_ai_metadata.ai_failed, true);
  assert.equal(c.turns.at(-1).text.includes(safety.DANGER_REMINDER), false);
});

test('source changed while risk manifest loads cannot authorize or overwrite an outdated risk', async () => {
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness(undefined, async () => { entered(); await gate; return manifest; });
  const original = await h.start();
  const sending = h.say(original);
  await waiting;
  const current = await h.api.vault.get('conversation:' + original.conversation_id);
  const patient = current.turns.find(turn => turn.role === 'elder');
  const updated = { ...current, version: current.version + 1,
    turns: current.turns.map(turn => turn.turn_id === patient.turn_id ? { ...turn, version: turn.version + 1, text: '纯虚构：更正后的原话' } : turn) };
  await h.api.vault.put('conversation:' + original.conversation_id, updated);
  release();
  const result = await sending;
  assert.equal(result.j.result_discarded, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.j.conversation)), updated,
    'discarding an obsolete risk reply must not append a failure or revise the newer source');
  assert.equal(result.j.conversation.turns.find(turn => turn.role === 'elder').text, '纯虚构：更正后的原话');
  assert.equal((result.j.conversation.report.reviewed_risk_assessments || []).length, 0);
});

test('report rebuilding excludes an accepted risk after its source is corrected', async () => {
  const h = await harness();
  const c = (await h.say(await h.start())).j.conversation;
  const patient = c.turns.find(turn => turn.role === 'elder');
  await h.api.vault.put('conversation:' + c.conversation_id, { ...c, version: c.version + 1,
    turns: c.turns.map(turn => turn.turn_id === patient.turn_id ? { ...turn, version: turn.version + 1, text: '纯虚构：来源已更正' } : turn) });
  const latest = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(latest.report.reviewed_risk_assessments.length, 0);
  assert.equal(latest.report.body.includes(SOON), false);
});
