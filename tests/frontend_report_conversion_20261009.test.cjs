// Fictional patient, saved actual replies: local conversion only; no provider.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js'), safety = require('../frontend/safety.js');
const saved = require('./fixtures/noreset-natural-report.synthetic.json');
const copy = value => JSON.parse(JSON.stringify(value));
const lines = (c, key) => c.report.sections.find(section => section.key === key)?.lines || [];
async function harness() {
  const elements = new Map(), calls = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  const context = vm.createContext({ HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null }, fetch: async path => { calls.push(path); throw new Error('No network in saved report regression'); } });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal; await api.vault.setup('synthetic-report-conversion-pass');
  const ready = api.initialise(); await new Promise(setImmediate);
  element('vaultPassphrase').value = 'synthetic-report-conversion-pass'; await element('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const read = async c => { await api.vault.put('conversation:' + c.conversation_id, c); return (await api.request('/api/conversations/' + c.conversation_id)).j.conversation; };
  return { api, read, calls };
}
function assertActualReport(c) {
  const expected = saved.completeness.clinical_state.symptom_character, source = saved.analysis_sources.turns[3];
  const line = lines(c, 'symptoms_impact').find(line => line.kind === 'summary' && line.text === expected.summary);
  assert.ok(line, 'Current symptom summary must retain the complete contiguous correction excerpt');
  assert.deepEqual(copy(line.source_versions), [source]);
  assert.equal(lines(c, 'verification').some(line => line.text.includes('具体感觉和严重程度')), false);
  assert.ok(lines(c, 'verification').some(line => line.text.includes('是否同时出现其他身体变化')));
  assert.ok(lines(c, 'background_actions').some(line => line.text === '我没量体温。'));
  assert.equal(c.report.status, 'auto_unreviewed');
  assert.match(c.report.disclaimer, /不是诊断/);
  assert.deepEqual(copy(c.turns), saved.turns);
  assert.deepEqual(copy(c.controller), saved.controller);
  assert.deepEqual(copy(c.report.source_versions), saved.analysis_sources.turns);
}
test('actual saved five-source corrected result retains multi-clause symptom summary in current report', async () => {
  const h = await harness(), c = await h.read({ ...copy(saved), report: null });
  assertActualReport(c); assert.equal(h.calls.length, 0);
});
test('public GET rebuilds actual old v5 omitted-summary cache, preserves identity and reuses complete cache', async () => {
  const h = await harness(), original = copy(saved), c = await h.read(original);
  assertActualReport(c); assert.equal(c.report.report_id, original.report.report_id);
  assert.equal(c.report.version, original.report.version + 1);
  // GET does not mutate a restored archive; a normal saved returned object can reuse its report.
  assert.deepEqual(await h.api.vault.get('conversation:' + original.conversation_id), original);
  const repeated = await h.read(copy(c));
  assert.deepEqual(copy(repeated.report), copy(c.report)); assert.equal(h.calls.length, 0);
});
function singleSource(text, summary) {
  const c = copy(saved), turn = copy(c.turns.find(turn => turn.role === 'elder'));
  turn.text = text; c.turns = [turn]; c.report = null; c.controller = null; c.health_context = []; c.selected_context_ids = [];
  c.analysis_sources = { turns: [{ turn_id: turn.turn_id, version: turn.version, quote: text }], selected_context_ids: [], context_version: 0, context: [] };
  c.completeness = { clinical_state: { symptom_character: { status: 'known', summary, evidence_turn_ids: [turn.turn_id], context_ids: [] } }, contradictions: [] };
  return c;
}
test('continuous complete clauses can be quoted without dropping qualifiers or accepting partial boundary clauses', async () => {
  const h = await harness();
  const valid = await h.read(singleSource('没有发热，晚上明显。我还没有记录时间。', '没有发热，晚上明显。'));
  assert.ok(lines(valid, 'symptoms_impact').some(line => line.kind === 'summary' && line.text === '没有发热，晚上明显。'));
  for (const [text, summary] of [
    ['没有发热，晚上明显。我还没有记录时间。', '发热，晚上明显。'],
    ['如果发热，再记录。我还没有记录时间。', '发热，再记录。'],
    ['好像手麻，偶尔明显。我还没有记录时间。', '手麻，偶尔明显。'],
    ['手麻，晚上明显些。我还没有记录时间。', '手麻，晚上明显'],
    ['发热，咳嗽，我不确定有没有这些症状。', '发热，咳嗽'],
    ['如果发热，咳嗽会加重，晚上尤其明显。', '咳嗽会加重，晚上尤其明显。'],
  ]) {
    const c = await h.read(singleSource(text, summary));
    assert.equal(c.report.sections.flatMap(section => section.lines).some(line => line.kind === 'summary'), false, summary);
    assert.equal(c.report.source_versions[0].quote, text);
  }
  assert.equal(h.calls.length, 0);
});
test('unknown missing and declined states cannot reuse the formerly known symptom summary', async () => {
  const h = await harness(), known = await h.read({ ...copy(saved), report: null });
  for (const status of ['unknown', 'missing', 'declined']) {
    const changed = copy(known); changed.completeness.clinical_state.symptom_character.status = status;
    const c = await h.read(changed);
    assert.equal(lines(c, 'symptoms_impact').some(line => line.text === saved.completeness.clinical_state.symptom_character.summary), false, status);
    assert.deepEqual(copy(c.turns), saved.turns);
    assert.equal(c.completeness.clinical_state.symptom_character.status, status);
  }
  assert.equal(h.calls.length, 0);
});
