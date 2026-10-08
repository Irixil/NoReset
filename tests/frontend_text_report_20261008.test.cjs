// Source-grounded current report vs chronological originals. Synthetic-only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js'), safety = require('../frontend/safety.js');
async function harness() {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  let response = payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '我已保留原话。' });
  const calls = [], context = vm.createContext({ HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null }, fetch: async (path, options) => {
      calls.push(path); const body = path === '/api/app/session' ? { authenticated: true, csrf_token: 'synthetic-only' } : response(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => body };
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal; await api.vault.setup('synthetic-text-report-pass'); const ready = api.initialise(); await new Promise(setImmediate);
  element('vaultPassphrase').value = 'synthetic-text-report-pass'; await element('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const request = (path, body, method = 'POST') => api.request(path, body === undefined ? {} : { method, headers: { 'Idempotency-Key': webcrypto.randomUUID() }, body: JSON.stringify(body) });
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-08' })).j.conversation;
  const say = async (c, text) => (await request(`/api/conversations/${c.conversation_id}/turns`, { text, expected_version: c.version })).j.conversation;
  return { api, request, start, say, calls, setResponse(fn) { response = fn; } };
}
function known(summary, refs) { return { status: 'known', summary, evidence_turn_ids: refs, context_ids: [] }; }
function sections(c, key) { return c.report.sections.find(section => section.key === key)?.lines || []; }
async function correction(h) {
  let c = await h.say(await h.start(), '纯虚构：膝痛一周，晚上明显。');
  h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '我已记下更正。',
    completeness: { clinical_state: {
      main_complaint: known('膝痛', [payload.turns[0].turn_id]),
      onset_course: known('十天', [payload.turns[1].turn_id]),
      aggravating_relieving: known('晚上明显', [payload.turns[0].turn_id]),
      associated_symptoms: { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] },
    }, contradictions: [], relevant_context_ids: [] } }));
  return h.say(c, '纯虚构：刚才说错了，不是一周，是十天。我担心记错时间。');
}
test('corrected current report uses grounded summaries and keeps old duration only in chronological sources', async () => {
  const h = await harness(), c = await correction(h), elder = c.turns.filter(t => t.role === 'elder');
  assert.equal(sections(c, 'chief_complaint')[0].text, '膝痛');
  assert.equal(sections(c, 'chief_complaint')[0].kind, 'summary');
  assert.equal(sections(c, 'onset_course')[0].text, '十天');
  assert.ok(sections(c, 'onset_course')[0].source_versions.some(item => item.turn_id === elder[1].turn_id && item.version === elder[1].version));
  assert.equal(sections(c, 'symptoms_impact')[0].text, '晚上明显');
  assert.match(c.report.body, /原话.*历史|历史.*原话/);
  assert.ok(c.report.transcript.some(item => item.text === elder[0].text && item.version === 1));
  assert.equal(c.report.status, 'auto_unreviewed');
  const handoff = (await h.request('/api/handoffs', { record_ids: elder.map(t => t.record_id) })).j.handoff;
  assert.equal(handoff.conversation_reports[0].report.report_id, c.report.report_id);
  assert.equal(handoff.conversation_reports[0].report.sections.find(section => section.key === 'onset_course').lines[0].text, '十天');
});
test('existing version-4 report migrates locally without any new model call', async () => {
  const h = await harness(), c = await correction(h), beforeCalls = h.calls.length;
  await h.api.vault.put('conversation:' + c.conversation_id, { ...c, report: { ...c.report, format_version: 4, body: '旧当前摘要：膝痛一周' } });
  const migrated = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(migrated.report.format_version, 5); assert.equal(migrated.report.version, c.report.version + 1);
  assert.equal(sections(migrated, 'onset_course')[0].text, '十天'); assert.equal(h.calls.length, beforeCalls);
  assert.ok(migrated.report.transcript.some(item => item.text.includes('膝痛一周')));
});
test('invented, missing or unknown-source summary cannot become a current doctor fact', async () => {
  const h = await harness(); h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '我已保留原话。', completeness: { clinical_state: {
    main_complaint: known('确诊肺炎', [payload.turns[0].turn_id]), onset_course: known('十天', ['turn_not_in_conversation']),
    associated_symptoms: known('发热', []),
  }, contradictions: [] } }));
  const c = await h.say(await h.start(), '纯虚构：膝痛，开始时间不记得。');
  assert.ok(c.report.sections.flatMap(section => section.lines).every(line => line.kind !== 'summary'));
  assert.doesNotMatch(c.report.body, /确诊肺炎|十天|发热/); assert.match(c.report.body, /膝痛/);
  assert.ok(c.report.transcript.some(item => item.text === '纯虚构：膝痛，开始时间不记得。'));
});
test('a cached summary referencing an older turn version is rebuilt against current wording', async () => {
  const h = await harness(), c = await correction(h), old = c.turns.find(t => t.role === 'elder');
  const turns = c.turns.map(t => t.turn_id === old.turn_id ? { ...t, text: '纯虚构：手麻，晚上明显。', version: 2 } : t);
  await h.api.vault.put('conversation:' + c.conversation_id, { ...c, turns });
  const current = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(sections(current, 'chief_complaint').some(line => line.kind === 'summary' && line.text === '膝痛'), false);
  assert.ok(current.report.transcript.some(item => item.turn_id === old.turn_id && item.version === 2));
  assert.ok(current.report.sections.flatMap(section => section.lines).filter(line => line.kind === 'summary').every(line => line.source_versions.every(source => turns.some(t => t.turn_id === source.turn_id && t.version === source.version))));
  assert.equal(current.completeness, null, 'Source change invalidates old analysis, not just its cache');
});
test('literal old duration inside a negation or correction cannot validate a current summary', async () => {
  const h = await harness(); h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '我已保留更正原话。', completeness: {
    clinical_state: { onset_course: known('两天', [payload.turns[0].turn_id]) }, contradictions: [] } }));
  const c = await h.say(await h.start(), '纯虚构：刚才说错了，不是两天，是三天。');
  assert.ok(sections(c, 'onset_course').every(line => line.kind !== 'summary'));
  assert.match(c.report.body, /不是两天，是三天/);
});
test('a literal fragment cannot remove its negative, conditional or uncertain qualifier', async () => {
  for (const text of ['纯虚构：没有发热。', '纯虚构：如果发热，再记录。', '纯虚构：好像发热。']) {
    const h = await harness(); h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '我已保留原话。', completeness: {
      clinical_state: { associated_symptoms: known('发热', [payload.turns[0].turn_id]) }, contradictions: [] } }));
    const c = await h.say(await h.start(), text);
    assert.ok(c.report.sections.flatMap(section => section.lines).every(line => line.kind !== 'summary'), text);
    assert.ok(c.report.transcript.some(turn => turn.text === text));
  }
});
test('a context selection change or edited selected context invalidates prior grounded analysis without calling AI', async () => {
  const h = await harness();
  const context = (await h.request('/api/health-context', { fields: { conditions: ['纯虚构：旧背景原话'] } })).j.health_context.entries[0];
  let c = await h.start(); c = (await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [context.context_id] })).j.conversation;
  h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '我已记录原话。', completeness: {
    clinical_state: { main_complaint: known('膝痛', [payload.turns[0].turn_id]), relevant_history: { status: 'known', summary: '旧背景原话', evidence_turn_ids: [], context_ids: [context.context_id] } }, contradictions: [] } }));
  c = await h.say(c, '纯虚构：膝痛。'); assert.ok(sections(c, 'background_actions').some(line => line.kind === 'summary'));
  const calls = h.calls.length;
  const deselected = (await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [] })).j.conversation;
  assert.equal(deselected.completeness, null); assert.ok(deselected.report.sections.flatMap(section => section.lines).every(line => line.kind !== 'summary')); assert.equal(h.calls.length, calls);
  // A separate existing analysis must also be rejected after global text edits.
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  await h.request('/api/health-context', { fields: { conditions: ['纯虚构：新背景原话'] } });
  const edited = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(edited.completeness, null); assert.ok(edited.report.sections.flatMap(section => section.lines).every(line => line.kind !== 'summary')); assert.equal(h.calls.length, calls);
});
test('source bindings remain encrypted, survive backup restore and are removed with their conversation', async () => {
  const h = await harness(), c = await correction(h), calls = h.calls.length;
  assert.ok(c.analysis_sources.turns.some(source => source.quote.includes('膝痛一周')));
  const archive = await h.api.vault.exportArchive();
  assert.equal(JSON.stringify(archive).includes('膝痛一周'), false);
  await h.api.restoreBackup({ archive }, 'synthetic-text-report-pass');
  const restored = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(JSON.stringify(restored.analysis_sources), JSON.stringify(c.analysis_sources));
  assert.equal(sections(restored, 'onset_course')[0].text, '十天'); assert.equal(h.calls.length, calls);
  const removed = await h.request('/api/conversations/' + c.conversation_id, { expected_version: restored.version, delete_scope_confirmed: true }, 'DELETE');
  assert.equal(removed.r.status, 200);
  assert.equal(await h.api.vault.get('conversation:' + c.conversation_id), undefined);
  assert.ok((await h.api.vault.driver.listDocs()).every(doc => !JSON.stringify(doc).includes('膝痛一周')));
});
