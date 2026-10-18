// Source-grounded current report vs chronological originals. Synthetic-only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js'), safety = require('../frontend/safety.js');
async function harness() {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  let response = payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '我已保留原话。' }), reground = null;
  const calls = [], context = vm.createContext({ HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, TextEncoder, FormData, Blob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null }, fetch: async (path, options) => {
      calls.push(path); const body = path === '/api/app/session' ? { authenticated: true, csrf_token: 'synthetic-only' }
        : path === '/api/reports/reground' ? await reground?.(JSON.parse(options.body)) || { ok: false }
          : await response(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => body };
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal; await api.vault.setup('synthetic-text-report-pass'); const ready = api.initialise(); await new Promise(setImmediate);
  element('vaultPassphrase').value = 'synthetic-text-report-pass'; await element('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const request = (path, body, method = 'POST') => api.request(path, body === undefined ? {} : { method, headers: { 'Idempotency-Key': webcrypto.randomUUID() }, body: JSON.stringify(body) });
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-08' })).j.conversation;
  const say = async (c, text) => (await request(`/api/conversations/${c.conversation_id}/turns`, { text, expected_version: c.version })).j.conversation;
  return { api, request, start, say, calls, setResponse(fn) { response = fn; }, setReground(fn) { reground = fn; } };
}
function known(summary, refs) { return { status: 'known', summary, evidence_turn_ids: refs, context_ids: [] }; }
function sections(c, key) { return c.report.sections.find(section => section.key === key)?.lines || []; }
const CLINICAL_CATEGORIES = ['main_complaint', 'onset_course', 'symptom_character', 'aggravating_relieving', 'associated_symptoms', 'functional_impact', 'relevant_history', 'prior_actions_results'];
const stableJson = value => {
  const stable = item => item && typeof item === 'object'
    ? Array.isArray(item) ? item.map(stable) : Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return JSON.stringify(stable(value));
};
async function digest(value) { return Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex'); }
async function currentController(payload, markers = []) {
  const anchor = payload.turns[0].turn_id;
  return { ...(payload.controller || {}), session_anchor_turn_id: anchor,
    session_id: await digest(`conversation-source-v1\0${payload.subject_id}\0${anchor}`),
    session_turn_ids: payload.turns.map(turn => turn.turn_id), non_health_sources: markers };
}
async function markedNonHealth(payload, { includeExisting = true } = {}) {
  const source = payload.turns.at(-1), anchor = payload.turns[0].turn_id;
  const sessionId = await digest(`conversation-source-v1\0${payload.subject_id}\0${anchor}`);
  const markers = includeExisting ? [...(payload.controller.non_health_sources || [])] : [];
  markers.push({ turn_id: source.turn_id, version: source.version, text_sha256: await digest(source.text),
    responding_to_sha256: await digest(stableJson(source.responding_to)), session_id: sessionId });
  return { ...(payload.controller || {}), session_anchor_turn_id: anchor, session_id: sessionId,
    session_turn_ids: payload.turns.map(turn => turn.turn_id), non_health_sources: markers };
}
async function nonHealthReply(payload, options) {
  return { provider: 'SyntheticReportFixture', action: 'reply', stop_reason: 'non_health_input',
    assistant_text: '好的，我明白了。您想继续说身体不舒服的事时，随时可以接着告诉我。',
    controller: await markedNonHealth(payload, options), completeness: {
      clinical_state: Object.fromEntries(CLINICAL_CATEGORIES.map(category => [category,
        { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] }])),
      contradictions: [], relevant_context_ids: [],
    } };
}
async function savedSynthetic(h, name) {
  const fixture = require('./fixtures/noreset-saved-memory-report.synthetic.json')[name];
  const c = structuredClone(fixture.conversation);
  for (const turn of c.turns || []) {
    if (turn.role !== 'elder' || turn.source_kind !== 'audio_transcript' || turn.superseded) continue;
    const subjectId = c.subject_id || 'subject_self', mediaId = turn.media_id || `media_report_${turn.turn_id}`;
    const sourceVersion = turn.audio_source_version || 1, mediaVersion = turn.audio_source_media_version || 1;
    turn.media_id = mediaId;
    Object.assign(turn, { audio_source_reviewed: true, audio_source_version: sourceVersion,
      audio_source_media_version: mediaVersion, audio_source_conversation_id: c.conversation_id,
      audio_source_conversation_version: c.version });
    await h.api.vault.put(`event:${turn.record_id}`, { record_id: turn.record_id, subject_id: subjectId,
      source_kind: 'audio_transcript', raw_text: turn.text, state: 'inbox', version: sourceVersion,
      source_review: { method: 'original_comparison', record_id: turn.record_id, text: turn.text, confirmed_at: '2026-10-12T00:00:00Z' } });
    await h.api.vault.put(`media:${mediaId}`, { media_id: mediaId, subject_id: subjectId, kind: 'audio', version: mediaVersion,
      recognition_status: 'succeeded', recognition: { text: turn.text, is_mock: false }, event_link: { record_id: turn.record_id } });
    await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([1, 2, 3]).buffer, {});
  }
  await h.api.vault.put('health-context:current', { version: c.health_context_version || 0, subject_id: 'subject_self', entries: c.health_context || [] });
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  return c;
}

test('pure report display normalization removes only source-and-date-bound repeated clauses', async () => {
  const h = await harness(), normalize = h.api.normalizeReportDisplay;
  const turn = { turn_id: 'turn_same', version: 2, quote: '夜间不适，影响睡眠。合成其他原话。' };
  const summary = (text, turn_id = turn.turn_id, version = turn.version) => ({ kind: 'summary', text, tags: ['待核对'],
    source_turn_ids: [turn_id], source_versions: [{ turn_id, version, quote: turn.quote }] });
  const context = (id, date, text = '合成历史背景') => ({ kind: 'context', text, tags: ['本人已确认陈述'],
    source_context_ids: [id], source_context: { context_id: id, temporal_status: 'historical', occurred_on: date, recorded_at: '2026-10-01' },
    source_label: '本人确认 · 本人陈述' });
  const old = { report_id: 'old-v5', transcript: [{ turn_id: 'turn_same', version: 2, text: turn.quote }], sections: [
    { key: 'symptoms_impact', title: '症状特点与生活影响', lines: [summary('夜间不适，影响睡眠。', turn.turn_id), summary('夜间不适，影响睡眠。', turn.turn_id), summary('夜间不适，影响睡眠。', turn.turn_id, 1), summary('夜间不适，影响睡眠。', 'turn_other')] },
    { key: 'background_actions', title: '相关背景与已做处理', lines: [context('ctx_a', '2022-04-12'),
      { kind: 'summary', text: '合成历史背景', tags: ['历史背景 · 发生日期 2022-04-12 · 待核对'], source_context_ids: ['ctx_a'], source_label: '历史背景 · 发生日期 2022-04-12 · 本人未核对' },
      context('ctx_b', '2023-05-13'), context('ctx_c', '2023-05-13')] },
    { key: 'verification', title: '尚待医生核实', lines: [{ kind: 'check', text: '未知项保留。' }, { kind: 'alert', text: '风险提醒保留。' }] },
  ] };
  const before = JSON.stringify(old), view = normalize(old);
  const symptomLines = view.sections[0].lines;
  assert.equal(symptomLines.length, 3, 'same turn/version duplicate collapses; a different version and turn remain');
  assert.equal(symptomLines.filter(line => line.text === '夜间不适，影响睡眠。').length, 3);
  const backgrounds = view.sections[1].lines.filter(line => line.text === '合成历史背景');
  assert.equal(backgrounds.length, 3, 'confirmed source and same-dated summary show once; other source/date do not merge');
  assert.match(backgrounds[0].source_label, /背景来源：.*本人确认.*本报告关联尚待核对：.*本人未核对/);
  assert.deepEqual(Array.from(view.sections[2].lines, line => line.text), ['未知项保留。', '风险提醒保留。']);
  assert.deepEqual(view.transcript, old.transcript);
  assert.equal(JSON.stringify(old), before, 'view normalization never rewrites a saved v5 report');
});
test('explicit report refresh is source-only, version-bound, idempotent and retains prior report', async () => {
  const h = await harness();
  h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '已保留原话。', completeness: {
    clinical_state: Object.fromEntries(CLINICAL_CATEGORIES.map(category => [category,
      category === 'main_complaint' ? known('手腕疼', [payload.turns[0].turn_id]) : { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] }])),
    contradictions: [], relevant_context_ids: [], unknowns: [], evidence_turn_ids: [payload.turns[0].turn_id],
  } }));
  let conversation = await h.say(await h.start(), '纯虚构：左手腕疼，抬高时明显。');
  conversation = { ...conversation, saved_audio_trial: { state: 'completed', grant_id: 'synthetic-closed-audio-trial' },
    trial_control: { state: 'stopped', turn_id: 'synthetic-closed-trial-turn' },
    controller: { ...conversation.controller, synthetic_control_marker: 'preserve' },
    selected_context_ids: [], health_context: [], health_context_version: 0 };
  await h.api.vault.put('conversation:' + conversation.conversation_id, conversation);
  const initialReport = structuredClone(conversation.report), initialCalls = h.calls.length;
  h.setReground(payload => ({ ok: true, source_only: true, algorithm_version: 'literal-report-v129', clinical_state: {
    ...payload.completeness.clinical_state,
    main_complaint: known('左手腕疼', [payload.turns[0].turn_id]),
  } }));
  const body = { expected_conversation_version: conversation.version, expected_subject_id: conversation.subject_id,
    expected_subject_version: 1, expected_context_version: 0 };
  let result = await h.request(`/api/conversations/${conversation.conversation_id}/refresh-report`, body);
  assert.equal(result.r.status, 200); assert.equal(result.j.changed, true);
  conversation = result.j.conversation;
  assert.equal(sections(conversation, 'chief_complaint')[0].text, '左手腕疼');
  for (const key of ['saved_audio_trial', 'trial_control', 'controller', 'completeness', 'health_context', 'selected_context_ids']) {
    assert.equal(JSON.stringify(conversation[key]), JSON.stringify((await h.api.vault.get('conversation:' + conversation.conversation_id))[key]), `${key} survives changed response`);
  }
  assert.equal(conversation.saved_audio_trial.state, 'completed', 'closed saved-audio trial marker remains present to keep composer gated');
  assert.equal(conversation.trial_control.state, 'stopped');
  let saved = await h.api.vault.get('conversation:' + conversation.conversation_id);
  assert.equal(saved.report_history.length, 1);
  assert.equal(JSON.stringify(saved.report_history[0]), JSON.stringify(initialReport));
  assert.deepEqual(conversation.turns, result.j.conversation.turns);
  const savedVersion = conversation.version, savedReportVersion = conversation.report.version;
  result = await h.request(`/api/conversations/${conversation.conversation_id}/refresh-report`, {
    ...body, expected_conversation_version: savedVersion,
  });
  assert.equal(result.r.status, 200); assert.equal(result.j.changed, false);
  assert.equal(result.j.conversation.version, savedVersion); assert.equal(result.j.conversation.report.version, savedReportVersion);
  saved = await h.api.vault.get('conversation:' + conversation.conversation_id);
  for (const key of ['saved_audio_trial', 'trial_control', 'controller', 'completeness', 'health_context', 'selected_context_ids']) {
    assert.equal(JSON.stringify(result.j.conversation[key]), JSON.stringify(saved[key]), `${key} survives unchanged response`);
  }
  assert.equal(saved.report_history.length, 1);
  assert.equal(h.calls.filter(path => path === '/api/reports/reground').length, 2);
  assert.equal(h.calls.slice(initialCalls).some(path => path === '/api/ai/conversation-turn'), false);
});
test('report refresh rejects stale conversation or subject bindings before contacting the re-ground endpoint', async () => {
  const h = await harness();
  h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '已保留原话。', completeness: {
    clinical_state: Object.fromEntries(CLINICAL_CATEGORIES.map(category => [category,
      category === 'main_complaint' ? known('手腕疼', [payload.turns[0].turn_id]) : { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] }])),
    contradictions: [], relevant_context_ids: [], unknowns: [], evidence_turn_ids: [payload.turns[0].turn_id],
  } }));
  const conversation = await h.say(await h.start(), '纯虚构：左手腕疼。');
  h.setReground(() => { throw new Error('must not call endpoint'); });
  const result = await h.request(`/api/conversations/${conversation.conversation_id}/refresh-report`, {
    expected_conversation_version: conversation.version - 1, expected_subject_id: conversation.subject_id,
    expected_subject_version: 1, expected_context_version: 0,
  });
  assert.equal(result.r.status, 409); assert.equal(result.j.error, 'report_source_changed');
  assert.equal(h.calls.includes('/api/reports/reground'), false);
  const saved = await h.api.vault.get('conversation:' + conversation.conversation_id);
  assert.equal(JSON.stringify(saved.report), JSON.stringify(conversation.report)); assert.equal(saved.report_history, undefined);
});
test('report refresh rejects a response that changes source bindings or loses a source during the request', async () => {
  const h = await harness();
  h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '已保留原话。', completeness: {
    clinical_state: Object.fromEntries(CLINICAL_CATEGORIES.map(category => [category,
      category === 'main_complaint' ? known('手腕疼', [payload.turns[0].turn_id]) : { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] }])),
    contradictions: [], relevant_context_ids: [], unknowns: [], evidence_turn_ids: [payload.turns[0].turn_id],
  } }));
  const conversation = await h.say(await h.start(), '纯虚构：左手腕疼。');
  const before = await h.api.vault.get('conversation:' + conversation.conversation_id);
  h.setReground(async payload => {
    const changed = await h.api.vault.get('conversation:' + conversation.conversation_id);
    await h.api.vault.put('conversation:' + conversation.conversation_id, { ...changed, version: changed.version + 1 });
    return { ok: true, source_only: true, algorithm_version: 'literal-report-v129', clinical_state: payload.completeness.clinical_state };
  });
  const result = await h.request(`/api/conversations/${conversation.conversation_id}/refresh-report`, {
    expected_conversation_version: conversation.version, expected_subject_id: conversation.subject_id,
    expected_subject_version: 1, expected_context_version: 0,
  });
  assert.equal(result.r.status, 409); assert.equal(result.j.error, 'report_source_changed');
  const after = await h.api.vault.get('conversation:' + conversation.conversation_id);
  assert.equal(JSON.stringify(after.report), JSON.stringify(before.report)); assert.equal(after.report_history, undefined);
});
test('report refresh rejects a changed status or evidence ID even when the proposed summary sounds plausible', async () => {
  const h = await harness();
  h.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'reply', assistant_text: '已保留原话。', completeness: {
    clinical_state: Object.fromEntries(CLINICAL_CATEGORIES.map(category => [category,
      category === 'main_complaint' ? known('手腕疼', [payload.turns[0].turn_id]) : { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] }])),
    contradictions: [], relevant_context_ids: [], unknowns: [], evidence_turn_ids: [payload.turns[0].turn_id],
  } }));
  const conversation = await h.say(await h.start(), '纯虚构：左手腕疼。');
  h.setReground(payload => {
    const clinical_state = structuredClone(payload.completeness.clinical_state);
    clinical_state.associated_symptoms = { ...clinical_state.associated_symptoms, status: 'known', summary: '没有其他症状', evidence_turn_ids: [payload.turns[0].turn_id] };
    return { ok: true, source_only: true, algorithm_version: 'literal-report-v129', clinical_state };
  });
  const result = await h.request(`/api/conversations/${conversation.conversation_id}/refresh-report`, {
    expected_conversation_version: conversation.version, expected_subject_id: conversation.subject_id,
    expected_subject_version: 1, expected_context_version: 0,
  });
  assert.equal(result.r.status, 422); assert.equal(result.j.error, 'report_update_rejected');
  const saved = await h.api.vault.get('conversation:' + conversation.conversation_id);
  assert.equal(saved.version, conversation.version); assert.equal(saved.report_history, undefined);
});
test('saved actual N03 cached report relabels historical-only sources without touching originals or calling a provider', async () => {
  const h = await harness(), before = await savedSynthetic(h, 'N03'), calls = h.calls.length;
  const c = (await h.request('/api/conversations/' + before.conversation_id)).j.conversation;
  const history = sections(c, 'background_actions').find(line => line.kind === 'summary');
  assert.match(history.tags.join(' '), /历史背景.*2022-04-12/);
  assert.match(history.source_label, /历史背景.*2022-04-12/);
  assert.doesNotMatch(history.source_label, /当前原话/);
  assert.equal(JSON.stringify(c.turns), JSON.stringify(before.turns));
  assert.equal(JSON.stringify(c.analysis_sources), JSON.stringify(before.analysis_sources));
  assert.equal(JSON.stringify(c.completeness), JSON.stringify(before.completeness));
  assert.equal(JSON.stringify(c.saved_audio_trial), JSON.stringify(before.saved_audio_trial));
  assert.equal(c.report.version, before.report.version + 1);
  assert.equal(h.calls.length, calls);
  const again = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(again.report.version, c.report.version, 'date-label migration is idempotent');
});
test('saved actual N01 correction survives current report, handoff and encrypted restore with no ASR/model call', async () => {
  const h = await harness(), before = await savedSynthetic(h, 'N01'), calls = h.calls.length;
  const c = (await h.request('/api/conversations/' + before.conversation_id)).j.conversation;
  assert.equal(sections(c, 'onset_course')[0].text, '三天');
  assert.ok(c.report.transcript.some(turn => turn.text === '我咳嗽两天了，晚上明显些。'));
  const handoff = (await h.request('/api/handoffs', { record_ids: c.turns.filter(t => t.role === 'elder').map(t => t.record_id) })).j.handoff;
  assert.equal(handoff.conversation_reports[0].report.sections.find(s => s.key === 'onset_course').lines[0].text, '三天');
  const archive = await h.api.vault.exportArchive();
  await h.api.restoreBackup({ archive }, 'synthetic-text-report-pass');
  const restored = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(sections(restored, 'onset_course')[0].text, '三天');
  assert.equal(JSON.stringify(restored.turns), JSON.stringify(before.turns));
  assert.equal(h.calls.length, calls);
});
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
test('saved pending-correction report stays neutral, preserves current risk and source versions, and reopens without version churn', async () => {
  const h = await harness();
  let c = await h.say(await h.start(), '左手腕抬高会疼。晚上睡觉暂时还没受什么影响。');
  c = await h.say(c, '你刚才说的是什么意思？请解释一下，先不要问新的问题。');
  const patientTurns = c.turns.filter(turn => turn.role === 'elder' && !turn.superseded);
  const assistantTurns = c.turns.filter(turn => turn.role === 'assistant');
  const oldText = patientTurns[0].text;
  const currentText = '我左手腕这几天有点疼，大概是四五天前开始的。那天没有摔着，也没做什么特别的事，就是慢慢觉得不舒服。手腕往上抬、拧毛巾，或者拿重一点的东西时会疼得明显些；放下来歇一会儿会好一点，但没有完全消失。最近端碗和开门都得慢一点，有时会换另一只手。昨晚翻身时左手腕疼醒过一次。有没有发烧我不确定，家里没有量过体温。以前左手腕有没有这样过，我记不太清，印象里没有特别明显的一次。我还没去看医生，也没做别的处理，先把这些告诉你。';
  const explanation = '你刚才说的是什么意思？请解释一下，先不要问新的问题。';
  const target = { ...patientTurns[0], text: currentText, version: 2, local_safety: { danger_detected: true },
    versions: [{ version: 1, text: oldText, record_id: patientTurns[0].record_id || null }] };
  const currentQuestion = { ...patientTurns[1], text: explanation };
  const nonHealthReply = assistantTurns.at(-1);
  nonHealthReply.text = '好的，我明白你是在解释刚才的内容。';
  nonHealthReply.action = 'reply'; nonHealthReply.stop_reason = 'non_health_input';
  c.turns = c.turns.map(turn => turn.turn_id === target.turn_id ? target
    : turn.turn_id === currentQuestion.turn_id ? currentQuestion : turn);
  c.turns.push({ turn_id: 'synthetic-superseded-correction', role: 'elder', source_kind: 'elder',
    text: '更正一下，刚才说晚上睡觉没受影响不准确，昨晚翻身时左手腕疼醒过一次。', version: 1, superseded: true });
  c.version += 1; c.completeness = null; c.analysis_sources = null; c.relevant_health_context = [];
  c.controller = { ...c.controller, followup_questions: [], pending_followups: [] };
  c.manual_correction_analysis_pending = true;
  c.manual_corrections = [{ correction_turn_id: 'synthetic-superseded-correction', correction_version: 1,
    correction_text: '更正一下，刚才说晚上睡觉没受影响不准确，昨晚翻身时左手腕疼醒过一次。',
    target_turn_id: target.turn_id, target_version_before: 1, target_version_after: 2,
    old_quote: '晚上睡觉暂时还没受什么影响。', new_quote: '昨晚翻身时左手腕疼醒过一次。',
    target_text_before: oldText, target_text_after: currentText, confirmed_at: '2026-10-17T00:00:00.000Z' }];
  const selected = [...(c.selected_context_ids || [])].sort();
  const coverageSources = { turns: patientTurns.map(turn => ({ turn_id: turn.turn_id, version: turn.turn_id === target.turn_id ? 2 : turn.version,
    quote: turn.turn_id === target.turn_id ? currentText : turn.text,
    responding_to: turn.responding_to ? { turn_id: turn.responding_to.turn_id, text: turn.responding_to.text } : null,
    responding_to_version: turn.responding_to_version ?? null })),
    selected_context_ids: selected, context_version: selected.length ? c.health_context_version ?? null : 0,
    context: [], questions: c.turns.filter(turn => turn.role === 'assistant').map(turn => ({ turn_id: turn.turn_id,
      version: turn.version, quote: turn.text, action: turn.action, superseded: Boolean(turn.superseded), ai_failed: Boolean(turn.ai_failed) })),
    episode: c.active_episode_start_turn_id || null };
  const oldQuestionCoverage = { format_version: 1, kind: 'assistant_question_coverage_not_clinical_facts',
    conversation_id: c.conversation_id, sources: coverageSources, candidates: [], resolved_questions: [],
    historical_scope_questions: [], pending_questions: [] };
  const oldReport = { ...c.report, report_id: 'synthetic-pending-report-v7', format_version: 5, version: 7,
    source_turn_ids: [target.turn_id, currentQuestion.turn_id],
    source_versions: [{ turn_id: target.turn_id, version: 2, quote: currentText },
      { turn_id: currentQuestion.turn_id, version: currentQuestion.version, quote: explanation }],
    question_coverage: oldQuestionCoverage, pending_questions: [],
    reviewed_risk_assessments: [], sections: [
      { key: 'onset_course', title: '起病与变化（原话历史 · 待核对）', lines: [{ kind: 'quote', text: explanation,
        tags: ['开始与变化'], source_turn_ids: [currentQuestion.turn_id],
        source_versions: [{ turn_id: currentQuestion.turn_id, version: currentQuestion.version, quote: explanation }] }] },
      { key: 'verification', title: '尚待医生核实', lines: [{ kind: 'check',
        text: '尚未问清：对走路、睡眠、进食或自理的影响。', tags: ['信息未完整'] }] },
    ] };
  c.report = oldReport;
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  const beforeCalls = h.calls.length;
  const read = async () => (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  const refreshed = await read();
  const currentLines = sections(refreshed, 'correction_pending_sources');
  assert.equal(refreshed.report.version, 8, 'a stored old pending report is refreshed once');
  assert.equal(refreshed.report.manual_correction_analysis_pending, true);
  assert.deepEqual(Array.from(currentLines, line => line.text), [currentText, explanation]);
  assert.ok(currentLines.every(line => line.kind === 'quote' && line.tags.includes('当前原话 · 待整理')));
  assert.ok(currentLines.every(line => line.source_versions?.[0]?.quote === line.text));
  assert.equal(sections(refreshed, 'onset_course').length, 0);
  assert.equal(sections(refreshed, 'patient_questions').length, 0);
  assert.ok(sections(refreshed, 'answer_context').every(line => !line.answer_context_answer
    || line.question_binding_current === false || line.tags?.some(tag => tag.includes('历史'))),
  'source-bound answers remain visible only with their historical/invalidated status');
  assert.equal(refreshed.report.pending_questions.length, 0);
  assert.doesNotMatch(refreshed.report.body, /尚未问清|起病与变化|开始与变化/);
  assert.ok(sections(refreshed, 'verification').some(line => line.text.includes('本机紧急提醒')),
    'a risk attached to the current source remains visible');
  assert.ok(sections(refreshed, 'correction_history').some(line => line.text.includes('昨晚翻身时左手腕疼醒过一次')));
  assert.ok(refreshed.report.transcript.some(turn => turn.text === nonHealthReply.text && turn.role === 'assistant'));
  assert.deepEqual(JSON.parse(JSON.stringify(refreshed.report.source_versions)), [
    { turn_id: target.turn_id, version: 2, quote: currentText },
    { turn_id: currentQuestion.turn_id, version: currentQuestion.version, quote: explanation },
  ]);
  const again = await read();
  assert.equal(again.report.version, refreshed.report.version, 'repeated reads of the saved old report do not accumulate versions');
  assert.deepEqual(sections(again, 'correction_pending_sources'), currentLines);
  await h.api.vault.put('conversation:' + c.conversation_id, refreshed);
  const reopened = await read();
  assert.equal(reopened.report.version, refreshed.report.version);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.report.source_versions)), JSON.parse(JSON.stringify(refreshed.report.source_versions)));
  assert.deepEqual(JSON.parse(JSON.stringify(sections(reopened, 'correction_pending_sources'))), JSON.parse(JSON.stringify(currentLines)));
  assert.equal(h.calls.length, beforeCalls, 'local report refresh and reopening do not call a provider');
});
test('pending correction preserves source-bound short answers and labels the old assistant candidate as historical', async () => {
  const h = await harness(), c = await h.start();
  const oldSource = { turn_id: 'synthetic-old-source', role: 'elder', source_kind: 'elder', text: '左手腕疼。', version: 1 };
  const currentSource = { ...oldSource, text: '左手腕疼，昨晚疼醒。', version: 2,
    versions: [{ version: 1, text: oldSource.text }] };
  const question = { turn_id: 'synthetic-old-question', role: 'assistant', action: 'ask', version: 1,
    text: '最近睡眠是否受到影响？', superseded: true };
  const answer = { turn_id: 'synthetic-short-answer', role: 'elder', source_kind: 'elder', text: '没有。', version: 1,
    responding_to: { turn_id: question.turn_id, text: question.text }, responding_to_version: question.version };
  const explanation = { turn_id: 'synthetic-explanation', role: 'elder', source_kind: 'elder',
    text: '你刚才说的是什么意思？请解释一下，先不要问新的问题。', version: 1 };
  c.turns = [c.turns[0], currentSource, question, answer, explanation];
  c.controller = { ...c.controller, followup_questions: [question.text] };
  c.completeness = null; c.analysis_sources = null; c.relevant_health_context = [];
  c.manual_correction_analysis_pending = true;
  const nomination = { assistant_source: { turn_id: question.turn_id, version: question.version, quote: question.text },
    patient_sources: [{ turn_id: oldSource.turn_id, version: oldSource.version, quote: oldSource.text }],
    selected_context_ids: [], context_version: 0, context: [], episode: null, origin_verified: true };
  c.report = { report_id: 'synthetic-old-pending-cache', format_version: 5, version: 4,
    question_coverage: { format_version: 1, kind: 'assistant_question_coverage_not_clinical_facts',
      conversation_id: c.conversation_id, sources: {}, candidates: [{ question: question.text, nomination }],
      resolved_questions: [], historical_scope_questions: [], pending_questions: [question.text] }, pending_questions: [question.text],
    source_turn_ids: [], source_versions: [], sections: [] };
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  const refreshed = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  const answerLines = sections(refreshed, 'answer_context');
  assert.ok(answerLines.some(line => line.text === question.text && line.tags.includes('助手历史问题 · 已失效 · 非患者陈述')));
  assert.ok(answerLines.some(line => line.text === answer.text && line.question_binding_current === false));
  assert.ok(sections(refreshed, 'correction_pending_sources').some(line => line.text === answer.text));
  const pending = sections(refreshed, 'verification').find(line => line.candidate_question === true);
  assert.equal(pending?.text, question.text);
  assert.ok(pending?.tags.includes('助手历史候选 · 范围需重新核实'));
  assert.ok(!pending?.tags.includes('患者陈述'));
  assert.ok(refreshed.report.question_coverage.historical_scope_questions.includes(question.text));
  await h.api.vault.put('conversation:' + c.conversation_id, refreshed);
  const reopened = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(reopened.report.version, refreshed.report.version);
  assert.ok(sections(reopened, 'answer_context').some(line => line.text === answer.text && line.question_binding_current === false));
  assert.ok(sections(reopened, 'verification').some(line => line.candidate_question === true && line.text === question.text));
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
test('question-only sources do not remain known facts after reopening; mixed statements and declarative unknowns remain', async () => {
  const question = '你还记得我之前膝盖疼的那段记录吗？请说说当时是哪天、怎样缓解的，也告诉我那段话是谁提供的。';
  const h = await harness();
  const first = await h.say(await h.start(), question), source = first.turns.find(turn => turn.role === 'elder');
  const legacy = structuredClone(first);
  const clinicalState = { main_complaint: known('膝盖疼', [source.turn_id]),
    onset_course: known('当时是哪天', [source.turn_id]),
    aggravating_relieving: known('怎样缓解', [source.turn_id]) };
  legacy.completeness = { clinical_state: clinicalState, contradictions: [], relevant_context_ids: [] };
  legacy.analysis_sources = { turns: [{ turn_id: source.turn_id, version: source.version, quote: source.text }],
    selected_context_ids: [], context_version: 0, context: [] };
  legacy.report = { ...legacy.report, format_version: 5, version: 2, sections: [...legacy.report.sections,
    ...Object.entries(clinicalState).map(([category, item]) => ({ key: category === 'main_complaint' ? 'chief_complaint'
      : category === 'onset_course' ? 'onset_course' : 'symptoms_impact', title: '旧缓存摘要', lines: [{ kind: 'summary',
        text: item.summary, tags: ['当前整理 · 待核对'], clinical_categories: [category], source_turn_ids: [source.turn_id],
        source_versions: [{ turn_id: source.turn_id, version: source.version, quote: source.text }] }] }))] };
  await h.api.vault.put('conversation:' + first.conversation_id, legacy);
  const calls = h.calls.length, rebuilt = (await h.request('/api/conversations/' + first.conversation_id)).j.conversation;
  assert.equal(rebuilt.report.version, legacy.report.version + 1);
  assert.ok(rebuilt.report.sections.flatMap(section => section.lines).every(line => line.kind !== 'summary'));
  assert.equal(rebuilt.completeness.clinical_state.onset_course.status, 'missing');
  assert.ok(sections(rebuilt, 'patient_questions').some(line => line.text === question));
  assert.ok(rebuilt.report.transcript.some(turn => turn.text === question));
  assert.equal(h.calls.length, calls);

  const h2 = await harness(), mixed = '我咳嗽三天了，怎么办？';
  const mixedConversation = await h2.say(await h2.start(), mixed), mixedTurn = mixedConversation.turns.find(turn => turn.role === 'elder');
  mixedConversation.completeness = { clinical_state: { main_complaint: known('咳嗽', [mixedTurn.turn_id]),
    onset_course: known('三天', [mixedTurn.turn_id]) }, contradictions: [], relevant_context_ids: [] };
  mixedConversation.analysis_sources = { turns: [{ turn_id: mixedTurn.turn_id, version: mixedTurn.version, quote: mixedTurn.text }],
    selected_context_ids: [], context_version: 0, context: [] };
  await h2.api.vault.put('conversation:' + mixedConversation.conversation_id, mixedConversation);
  const currentMixed = (await h2.request('/api/conversations/' + mixedConversation.conversation_id)).j.conversation;
  assert.ok(sections(currentMixed, 'chief_complaint').some(line => line.kind === 'summary' && line.text === '咳嗽'));
  assert.ok(sections(currentMixed, 'onset_course').some(line => line.kind === 'summary' && line.text === '三天'));
  assert.ok(sections(currentMixed, 'patient_questions').some(line => line.text === mixed));
  assert.ok(currentMixed.report.transcript.some(turn => turn.text === mixed));

  for (const [text, summary] of [['怎么也睡不好。', '睡不好'], ['什么都吃不下。', '吃不下']]) {
    const hFact = await harness(), c = await hFact.say(await hFact.start(), text);
    const turn = c.turns.find(item => item.role === 'elder');
    c.completeness = { clinical_state: { functional_impact: known(summary, [turn.turn_id]) }, contradictions: [], relevant_context_ids: [] };
    c.analysis_sources = { turns: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
      selected_context_ids: [], context_version: 0, context: [] };
    await hFact.api.vault.put('conversation:' + c.conversation_id, c);
    const current = (await hFact.request('/api/conversations/' + c.conversation_id)).j.conversation;
    assert.equal(current.completeness.clinical_state.functional_impact.status, 'known', text);
    assert.ok(sections(current, 'symptoms_impact').some(line => line.kind === 'summary' && line.text === summary), text);
  }

  const declarativeUnknown = '什么时候开始我也不记得了。', h3 = await harness();
  const unknown = await h3.say(await h3.start(), declarativeUnknown);
  assert.ok(unknown.report.transcript.some(turn => turn.text === declarativeUnknown));
  assert.equal(sections(unknown, 'patient_questions').some(line => line.text === declarativeUnknown), false);
});

test('stale analysis after a bound short answer does not relabel the original symptom or clear unrelated unknowns', async () => {
  const h = await harness();
  h.setResponse(payload => {
    const turnId = payload.turns[0].turn_id;
    const missing = () => ({ status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] });
    return { provider: 'SyntheticReportFixture', action: 'ask',
      assistant_text: '咳嗽两天、晚上更明显，这个情况我记下了。 咳嗽的时候有痰吗？',
      completeness: { clinical_state: {
        main_complaint: known('我咳嗽两天了，', [turnId]),
        onset_course: known('我咳嗽两天了；晚上明显些。', [turnId]),
        symptom_character: missing(), aggravating_relieving: known('晚上明显些。', [turnId]),
        associated_symptoms: missing(), functional_impact: missing(), relevant_history: missing(), prior_actions_results: missing(),
      }, contradictions: [], relevant_context_ids: [] } };
  });
  let conversation = await h.say(await h.start(), '我咳嗽两天了，晚上明显些。');
  const source = conversation.turns.find(turn => turn.role === 'elder');
  assert.ok(conversation.analysis_sources?.turns.some(turn => turn.turn_id === source.turn_id));
  assert.ok(sections(conversation, 'symptoms_impact').some(line => line.kind === 'summary' && line.text === '晚上明显些。'));
  await h.api.vault.put('trial-control:voice', { review_required: true, state: 'stopped', source_kind: 'elder',
    conversation_id: 'synthetic-other-conversation', turn_id: 'synthetic-closed-stop', turn_version: 1, media_id: null });
  const answer = await h.say(conversation, '没有。');
  assert.equal(answer.new_text_trial?.state, 'saved_only');
  assert.equal(answer.turns.find(turn => turn.role === 'elder' && turn.turn_id !== source.turn_id)?.responding_to?.text,
    '咳嗽两天、晚上更明显，这个情况我记下了。 咳嗽的时候有痰吗？');
  const savedLines = answer.report.sections.flatMap(section => section.lines);
  assert.ok(savedLines.some(line => line.text === source.text && line.tags.includes('未分类 · 待整理')),
    'the first save after source changes keeps the original without keyword classification');
  assert.ok(savedLines.some(line => line.answer_context_answer && line.text === '没有。'),
    'the short answer stays bound to its actual prior question');
  assert.ok(savedLines.some(line => line.answer_context_question && line.text.includes('咳嗽的时候有痰吗')));
  assert.ok(savedLines.some(line => line.text.startsWith('尚未问清：') && line.text.includes('是否同时出现其他身体变化')));
  const projected = await h.request(`/api/conversations/${conversation.conversation_id}`);
  const current = projected.j.conversation, lines = current.report.sections.flatMap(section => section.lines);
  assert.equal(current.completeness, null, 'the prior analysis was invalidated because a new elder source was added');
  assert.equal(current.turns.find(turn => turn.turn_id === source.turn_id).text, '我咳嗽两天了，晚上明显些。');
  assert.equal(lines.some(line => line.source_turn_ids?.includes(source.turn_id) && line.tags?.includes('同时出现')), false,
    'a bare core symptom word is not evidence of another concurrent symptom');
  assert.ok(lines.some(line => line.kind === 'check' && line.text.includes('尚未问清') && line.text.includes('是否同时出现其他身体变化')),
    'the short answer to sputum does not resolve the broader associated-symptoms unknown');
  assert.equal(h.calls.filter(path => path === '/api/ai/conversation-turn').length, 1,
    'the only model fixture was the original turn; the short answer used no provider call');
});
test('unbound report source projections are idempotent across conversation, current and list reads', async () => {
  async function assertStable(h, conversation, label) {
    const readConversation = () => h.request(`/api/conversations/${conversation.conversation_id}`, undefined, 'GET');
    const readCurrent = () => h.request('/api/conversations/current?local_date=2026-10-08', undefined, 'GET');
    const readList = () => h.request('/api/conversations', undefined, 'GET');
    const first = (await readConversation()).j.conversation.report;
    for (const [name, read] of [['conversation', readConversation], ['current', readCurrent], ['list', readList]]) {
      const response = (await read()).j;
      const projected = name === 'current' ? response.conversation?.report
        : name === 'list' ? response.conversations.find(item => item.conversation_id === conversation.conversation_id)?.report
          : response.conversation?.report;
      assert.ok(projected, `${label}: ${name} projection exists`);
      assert.equal(projected.version, first.version, `${label}: ${name} read does not bump report version`);
      assert.equal(stableJson(projected), stableJson(first), `${label}: ${name} report stays stable`);
    }
  }

  const questionHarness = await harness(); questionHarness.setResponse(() => { throw new Error('synthetic unavailable'); });
  const question = await questionHarness.say(await questionHarness.start(), '我担心会不会很严重？');
  assert.ok(sections(question, 'patient_questions').some(line => line.text === '我担心会不会很严重？'));
  assert.equal(sections(question, 'source_record').length, 0, 'a pure question remains in the question section only');
  await assertStable(questionHarness, question, 'pure question');

  const shortHarness = await harness(), shortStart = await shortHarness.start();
  await shortHarness.api.vault.put('trial-control:voice', { review_required: true, state: 'stopped', source_kind: 'elder',
    conversation_id: 'synthetic-unrelated-conversation', turn_id: 'synthetic-stop', turn_version: 1, media_id: null });
  const short = await shortHarness.say(shortStart, '没有。');
  assert.equal(short.new_text_trial?.state, 'saved_only');
  await assertStable(shortHarness, short, 'pure short answer');

  const mixedHarness = await harness();
  mixedHarness.setResponse(payload => ({ provider: 'SyntheticReportFixture', action: 'ask',
    assistant_text: '咳嗽的时候有痰吗？', completeness: { clinical_state: {
      main_complaint: known('咳嗽', [payload.turns[0].turn_id]), associated_symptoms: { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] },
    }, contradictions: [], relevant_context_ids: [] } }));
  let mixed = await mixedHarness.say(await mixedHarness.start(), '我这几天一直咳嗽。');
  await mixedHarness.api.vault.put('trial-control:voice', { review_required: true, state: 'stopped', source_kind: 'elder',
    conversation_id: 'synthetic-other-conversation', turn_id: 'synthetic-stop', turn_version: 1, media_id: null });
  mixed = await mixedHarness.say(mixed, '没有。');
  assert.ok(sections(mixed, 'answer_context').some(line => line.answer_context_answer && line.text === '没有。'));
  assert.ok(sections(mixed, 'source_record').some(line => line.text === '我这几天一直咳嗽。'));
  await assertStable(mixedHarness, mixed, 'mixed source and short answer');

  const normalHarness = await harness(); normalHarness.setResponse(() => { throw new Error('synthetic unavailable'); });
  const normal = await normalHarness.say(await normalHarness.start(), '纯虚构：昨晚睡得不太好。');
  assert.ok(sections(normal, 'source_record').some(line => line.text === '纯虚构：昨晚睡得不太好。'));
  await assertStable(normalHarness, normal, 'normal sentence');
});
test('family-attributed statements remain facts while a particle-led request stays a question', async () => {
  for (const text of ['妈妈告诉我去年膝盖疼过。', '我妈妈告诉我去年膝盖疼过。']) {
    const h = await harness(), c = await h.say(await h.start(), text), turn = c.turns.find(item => item.role === 'elder');
    const item = known('去年膝盖疼过', [turn.turn_id]);
    c.completeness = { clinical_state: { relevant_history: item }, contradictions: [], relevant_context_ids: [] };
    c.analysis_sources = { turns: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
      selected_context_ids: [], context_version: 0, context: [] };
    await h.api.vault.put('conversation:' + c.conversation_id, c);
    const reopened = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
    assert.equal(reopened.completeness.clinical_state.relevant_history.status, 'known', text);
    assert.ok(sections(reopened, 'background_actions').some(line => line.kind === 'summary' && line.text === '去年膝盖疼过'), text);
  }

  const text = '也告诉我那段话是谁提供的。', h = await harness(), c = await h.say(await h.start(), text);
  const turn = c.turns.find(item => item.role === 'elder');
  c.completeness = { clinical_state: { relevant_history: known('那段话是谁提供的', [turn.turn_id]) },
    contradictions: [], relevant_context_ids: [] };
  c.analysis_sources = { turns: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
    selected_context_ids: [], context_version: 0, context: [] };
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  const reopened = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(reopened.completeness.clinical_state.relevant_history.status, 'missing');
  assert.ok(sections(reopened, 'patient_questions').some(line => line.text === text));
  assert.ok(reopened.report.transcript.some(item => item.text === text));
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

test('failed model replies retain current versioned originals for both historical and patient-question quotes', async () => {
  for (const text of ['纯虚构：今天手麻，其他身体变化我不清楚。', '纯虚构：我担心记错时间，不知道要不要告诉医生。']) {
    const h = await harness(); h.setResponse(() => { throw new Error('synthetic model unavailable'); });
    let c = await h.say(await h.start(), '纯虚构：昨天膝痛。');
    const elder = c.turns.find(turn => turn.role === 'elder');
    c = (await h.request(`/api/conversations/${c.conversation_id}/turns/${elder.turn_id}`, {
      text, expected_version: elder.version, expected_conversation_version: c.version,
    })).j.conversation;
    const current = c.turns.find(turn => turn.turn_id === elder.turn_id);
    assert.equal(current.version, 2); assert.equal(c.last_ai_metadata.ai_failed, true);
    assert.equal(c.completeness, null);
    const quotes = c.report.sections.flatMap(section => section.lines).filter(line => line.kind === 'quote'
      && line.source_turn_ids?.includes(current.turn_id));
    assert.ok(quotes.some(line => line.text === text));
    assert.ok(quotes.some(line => JSON.stringify(line.source_versions) === JSON.stringify([{ turn_id: current.turn_id, version: 2, quote: text }])));
    if (text.includes('身体变化我不清楚')) {
      assert.ok(quotes.some(line => line.tags.includes('未分类 · 待整理')));
      assert.equal(quotes.some(line => line.tags.some(tag => ['其他身体变化未明确', '同时出现'].includes(tag))), false);
      assert.match(sections(c, 'verification').map(line => line.text).join('\n'), /是否同时出现其他身体变化/);
    }
    const handoff = (await h.request('/api/handoffs', { record_ids: [current.record_id] })).j.handoff;
    const handoffQuote = handoff.conversation_reports[0].report.sections.flatMap(section => section.lines).find(line => line.kind === 'quote');
    assert.equal(JSON.stringify(handoffQuote.source_versions), JSON.stringify(quotes[0].source_versions));
    assert.ok(handoff.conversation_reports[0].report.sections.flatMap(section => section.lines).every(line => line.kind !== 'summary'));
  }
});

test('legacy version-5 failed quote cache rebuilds locally with stable report identity and current source version', async () => {
  const h = await harness(); h.setResponse(() => { throw new Error('synthetic model unavailable'); });
  let c = await h.say(await h.start(), '纯虚构：昨天膝痛。');
  const elder = c.turns.find(turn => turn.role === 'elder');
  c = (await h.request(`/api/conversations/${c.conversation_id}/turns/${elder.turn_id}`, {
    text: '纯虚构：今天手麻，其他情况不清楚。', expected_version: elder.version, expected_conversation_version: c.version,
  })).j.conversation;
  const current = c.turns.find(turn => turn.turn_id === elder.turn_id), calls = h.calls.length;
  const legacy = JSON.parse(JSON.stringify({ ...c, trial_control: { state: 'stopped', turn_id: current.turn_id } }));
  for (const line of legacy.report.sections.flatMap(section => section.lines)) if (line.kind === 'quote') delete line.source_versions;
  await h.api.vault.put('conversation:' + c.conversation_id, legacy);
  const read = async () => (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  const rebuilt = await read(), again = await read();
  assert.equal(rebuilt.report.report_id, legacy.report.report_id);
  assert.equal(rebuilt.report.version, legacy.report.version + 1);
  assert.equal(again.report.version, rebuilt.report.version, 'Repeated reads of the stored legacy report do not accumulate versions');
  const quote = rebuilt.report.sections.flatMap(section => section.lines).find(line => line.kind === 'quote');
  assert.equal(JSON.stringify(quote.source_versions), JSON.stringify([{ turn_id: current.turn_id, version: 2, quote: current.text }]));
  assert.equal(JSON.stringify(rebuilt.turns), JSON.stringify(legacy.turns));
  assert.equal(rebuilt.version, legacy.version); assert.equal(rebuilt.trial_control.state, 'stopped');
  assert.equal((await h.api.vault.get('conversation:' + c.conversation_id)).report.version, legacy.report.version, 'A read does not mutate the vault');
  await h.api.vault.put('conversation:' + c.conversation_id, rebuilt);
  assert.equal((await read()).report.version, rebuilt.report.version, 'A complete returned cache is reused');
  assert.equal(h.calls.length, calls, 'Report reconstruction makes no model request');
});

test('versioned legacy quote cache cannot hide explicitly unknown accompanying symptoms', async () => {
  const h = await harness(); h.setResponse(() => { throw new Error('synthetic model unavailable'); });
  const c = await h.say(await h.start(), '完全虚构。我咳嗽两天，晚上明显，别的变化我不清楚。');
  const legacy = JSON.parse(JSON.stringify(c));
  const quote = legacy.report.sections.flatMap(section => section.lines).find(line => line.kind === 'quote');
  quote.tags = quote.tags.map(tag => tag === '其他身体变化未明确' ? '同时出现' : tag);
  for (const line of legacy.report.sections.find(section => section.key === 'verification').lines)
    line.text = line.text.replace('是否同时出现其他身体变化、', '');
  await h.api.vault.put('conversation:' + c.conversation_id, legacy);
  const calls = h.calls.length;
  const rebuilt = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(rebuilt.report.report_id, legacy.report.report_id);
  assert.equal(rebuilt.report.version, legacy.report.version + 1);
  assert.match(sections(rebuilt, 'verification').map(line => line.text).join('\n'), /是否同时出现其他身体变化/);
  const rebuiltQuote = rebuilt.report.sections.flatMap(section => section.lines).find(line => line.kind === 'quote');
  assert.ok(rebuiltQuote.tags.includes('未分类 · 待整理'));
  assert.equal(rebuiltQuote.tags.some(tag => ['其他身体变化未明确', '同时出现'].includes(tag)), false);
  assert.equal(JSON.stringify(rebuiltQuote.source_versions), JSON.stringify(quote.source_versions));
  assert.equal(h.calls.length, calls);
});

test('exact current non-health marker keeps original and reply while omitting synthetic medical unknowns after reopen', async () => {
  const h = await harness(); h.setResponse(nonHealthReply);
  const original = '纯虚构：周末看了纪录片。';
  const started = await h.start(), sent = await h.request(`/api/conversations/${started.conversation_id}/turns`, { text: original, expected_version: started.version });
  assert.ok(sent.j.conversation, JSON.stringify(sent.j));
  const c = sent.j.conversation;
  const source = c.report.sections.find(section => section.key === 'source_record');
  assert.equal(source.title, '原话记录');
  assert.ok(source.lines.some(line => line.text === original && line.tags.includes('未作为健康事实')));
  assert.ok(source.lines.some(line => line.text === '好的，我明白了。您想继续说身体不舒服的事时，随时可以接着告诉我。'
    && line.tags.includes('助手回复')));
  assert.equal(sections(c, 'verification').some(line => line.text.startsWith('尚未问清：')), false);
  assert.equal(c.report.pending_questions.length, 0);
  const beforeCalls = h.calls.length;
  await h.api.vault.put('conversation:' + c.conversation_id, c);
  const reopened = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(reopened.report.version, c.report.version);
  assert.equal(sections(reopened, 'verification').some(line => line.text.startsWith('尚未问清：')), false);
  assert.ok(sections(reopened, 'source_record').some(line => line.text === original));
  const reopenedAgain = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  assert.equal(reopenedAgain.report.version, reopened.report.version, 'two normal GET rebuild checks keep the report version stable');
  assert.ok(sections(reopenedAgain, 'source_record').some(line => line.text === '好的，我明白了。您想继续说身体不舒服的事时，随时可以接着告诉我。'));
  assert.equal(h.calls.length, beforeCalls, 'report reopening does not call a provider');
});

test('reopening rebuilds altered or extra saved non-health source lines without a provider call', async () => {
  const h = await harness(); h.setResponse(nonHealthReply);
  const original = '纯虚构：周末听了爵士乐。', c = await h.say(await h.start(), original);
  const altered = structuredClone(c), section = altered.report.sections.find(item => item.key === 'source_record');
  const replyLine = section.lines.find(line => line.tags.includes('助手回复'));
  replyLine.text = '过期的助手回复';
  section.lines.push({ kind: 'context', text: '伪造背景', tags: ['额外内容'] });
  await h.api.vault.put('conversation:' + c.conversation_id, altered);
  const calls = h.calls.length;
  const reopened = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
  const current = sections(reopened, 'source_record');
  assert.equal(reopened.report.version, c.report.version + 1);
  assert.ok(current.some(line => line.text === '好的，我明白了。您想继续说身体不舒服的事时，随时可以接着告诉我。'));
  assert.equal(current.some(line => line.text === '过期的助手回复' || line.text === '伪造背景'), false);
  assert.equal(current.length, 2);
  assert.equal(h.calls.length, calls, 'rebuilding source lines is local-only');
});

test('missing, stale, malformed or wrongly bound non-health markers fail closed', async () => {
  const mutations = [
    controller => { controller.non_health_sources = []; },
    controller => { controller.non_health_sources[0].version += 1; },
    controller => { controller.non_health_sources[0].text_sha256 = 'a'.repeat(64); },
    controller => { controller.non_health_sources[0].responding_to_sha256 = 'b'.repeat(64); },
    controller => { controller.non_health_sources[0].session_id = 'c'.repeat(64); },
    controller => { controller.non_health_sources[0].unexpected = true; },
  ];
  for (const mutate of mutations) {
    const h = await harness(); h.setResponse(nonHealthReply);
    const c = await h.say(await h.start(), '纯虚构：听了一张新唱片。'), changed = structuredClone(c);
    mutate(changed.controller);
    await h.api.vault.put('conversation:' + c.conversation_id, changed);
    const reopened = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
    assert.equal(sections(reopened, 'source_record').length, 0);
    assert.ok(sections(reopened, 'verification').some(line => line.text.startsWith('尚未问清：')));
  }
});

test('mixed health and non-health turns retain real clinical summaries and unknowns', async () => {
  const h = await harness();
  h.setResponse(async payload => {
    const source = payload.turns.at(-1);
    if (payload.turns.length === 1) return { provider: 'SyntheticReportFixture', action: 'ask', assistant_text: '还伴有其他变化吗？',
      controller: await currentController(payload), completeness: { clinical_state: {
        main_complaint: known('纯虚构：膝盖疼。', [source.turn_id]), ...Object.fromEntries(CLINICAL_CATEGORIES.slice(1).map(category => [category,
          { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] }])) }, contradictions: [], relevant_context_ids: [] } };
    const result = await nonHealthReply(payload);
    result.completeness.clinical_state.main_complaint = known('纯虚构：膝盖疼。', [payload.turns[0].turn_id]);
    return result;
  });
  let c = await h.say(await h.start(), '纯虚构：膝盖疼。');
  c = await h.say(c, '纯虚构：周末看了纪录片。');
  assert.equal(sections(c, 'source_record').length, 0);
  assert.ok(sections(c, 'chief_complaint').some(line => line.kind === 'summary' && line.text === '纯虚构：膝盖疼。'));
  assert.ok(sections(c, 'verification').some(line => line.text.startsWith('尚未问清：')));
});

test('edited source, selected health context and review safety each retain the clinical checklist', async () => {
  const h = await harness(); h.setResponse(nonHealthReply);
  const c = await h.say(await h.start(), '纯虚构：听了一张新唱片。');
  const source = c.turns.find(turn => turn.role === 'elder');
  const corrected = await h.request(`/api/conversations/${c.conversation_id}/turns/${source.turn_id}`, {
    text: '纯虚构：现在膝盖疼。', expected_version: source.version, expected_conversation_version: c.version,
  });
  assert.equal(corrected.j.conversation.report.sections.flatMap(section => section.lines).some(line => line.kind === 'summary'), false);
  assert.ok(sections(corrected.j.conversation, 'verification').some(line => line.text.startsWith('尚未问清：')));

  for (const mutate of [
    conversation => { conversation.selected_context_ids = ['context_unverified_12345678']; },
    conversation => { conversation.turns.find(turn => turn.role === 'elder').local_safety = { clinical_review_required: true }; },
  ]) {
    const reopened = structuredClone(c); mutate(reopened);
    await h.api.vault.put('conversation:' + c.conversation_id, reopened);
    const current = (await h.request('/api/conversations/' + c.conversation_id)).j.conversation;
    assert.equal(current.report.sections.flatMap(section => section.lines).some(line => line.kind === 'summary'), false);
    assert.ok(sections(current, 'verification').some(line => line.text.startsWith('尚未问清：')));
  }
});
