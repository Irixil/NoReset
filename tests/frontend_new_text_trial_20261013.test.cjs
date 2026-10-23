// Synthetic encrypted-store integration tests. Every backend/provider call is stubbed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');
const appSource = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');

async function harness(existingDriver = null, sharedResponses = null, sharedCalls = null) {
  const driver = existingDriver || new core.MemoryDocumentStore(), calls = sharedCalls || [], responses = sharedResponses || new Map(), elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  let context, api;
  const fetch = async (path, options = {}) => {
    calls.push({ path, ...options });
    let value = responses.has(path) ? responses.get(path) : null;
    if (typeof value === 'function') value = await value({ path, options, context, api });
    if (value == null) value = path === '/api/app/session' ? { authenticated: true, csrf_token: 'synthetic-csrf' }
      : path === '/api/app/config' ? { text_trial: null }
        : { action: 'reply', assistant_text: '已按您刚才说的保留这段原话。', provider: 'SyntheticMechanicalFixture' };
    return { ok: !(value.__status >= 400), status: value.__status || 200, json: async () => value };
  };
  context = vm.createContext({ HealthLocalCore: { ...core, IndexedDbDocumentStore: class { constructor() { return driver; } } },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController,
    TextEncoder, TextDecoder, setTimeout, clearTimeout, navigator: { storage: {} }, document: { getElementById: el, querySelector: () => null }, fetch });
  const source = fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8')
    .replace('  globalThis.HealthLocal = {', '  globalThis.__testBuildConversationModelPayload = conversationModelPayload;\n  globalThis.__testMayUseFreshTextTrial = mayUseFreshTextTrial;\n  globalThis.__testLegacyReorganizationCandidate = legacyReorganizationOutputCandidate;\n  globalThis.HealthLocal = {')
    .replace('    if (!await newTextTrialDispatchAllowed(owner, wire))', '    if (globalThis.__testAfterTextTrialClaim) await globalThis.__testAfterTextTrialClaim();\n    if (!await newTextTrialDispatchAllowed(owner, wire))');
  vm.runInContext(source, context);
  api = context.HealthLocal;
  const password = 'synthetic-new-text-trial';
  if (!existingDriver) await api.vault.setup(password);
  const ready = api.initialise(); await new Promise(setImmediate);
  el('vaultPassphrase').value = password;
  await el('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const request = (path, body, headers = {}) => api.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers });
  const currentLocalDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
  const start = () => request('/api/conversations/start', { mode: 'new', local_date: currentLocalDate() });
  return { driver, calls, responses, api, context, request, start,
    reopen: async () => { api.lock(); return harness(driver, responses, calls); } };
}

const rawText = '今天下午走路时膝盖不舒服，坐下休息后好一些。';
const oldStop = (conversationId = null, state = 'stopped') => ({ review_required: true, state, source_kind: 'elder',
  conversation_id: conversationId, turn_id: 'synthetic-old-stop', turn_version: 1, media_id: null });
const hash = value => createHash('sha256').update(value).digest('hex');
const rootOperatorEvidence=path.resolve(__dirname,'../.dz/evidence/goal-acceptance-2026-10-11/corrected-live-v118-20261017/root-operator');
async function installCapturedConversation(h,conversation){
  await h.api.vault.put(`conversation:${conversation.conversation_id}`,conversation);
  for(const turn of conversation.turns||[])if(turn.role==='elder'&&!turn.superseded&&turn.record_id){
    await h.api.vault.put(`event:${turn.record_id}`,{record_id:turn.record_id,subject_id:conversation.subject_id,
      source_kind:'elder',raw_text:turn.text,version:turn.version,state:'inbox'});
  }
}
function portableLegacyConversation(){
  const confirmedAt='2026-10-17T10:00:00.000Z',target={turn_id:'portable-target',role:'elder',version:2,
    text:'虚构测试中的更正原话。',created_at:'2026-10-17T09:00:00.000Z',edited_at:confirmedAt};
  const correction={turn_id:'portable-correction',role:'elder',version:1,text:'虚构的手工更正。',superseded:true,
    created_at:'2026-10-17T09:59:00.000Z'};
  const reply={turn_id:'portable-legacy-reply',role:'assistant',version:1,text:'虚构的旧版整理操作回复。',
    created_at:'2026-10-17T10:01:00.000Z',action:'reply',is_mock:false};
  return {conversation_id:'conversation_portable_legacy_review',subject_id:'subject_self',local_date:'2026-10-17',last_local_date:'2026-10-17',
    created_at:'2026-10-17T09:00:00.000Z',updated_at:'2026-10-17T10:01:00.000Z',status:'paused',version:4,turns:[target,correction,reply],
    manual_corrections:[{correction_turn_id:correction.turn_id,target_turn_id:target.turn_id,target_version_after:target.version,
      target_text_after:target.text,confirmed_at:confirmedAt}],manual_correction_analysis_pending:false,
    manual_correction_reorganization:{state:'completed',scope_id:'a'.repeat(64),body_sha256:'b'.repeat(64)},
    last_ai_metadata:{trace_id:'portable-trace',provider:'PortableFixture'},health_context:[],selected_context_ids:[],health_context_version:0,
    report:{format_version:5,version:2,generated_at:'2026-10-17T10:01:00.000Z',source_turn_ids:[target.turn_id],
      source_versions:[{turn_id:target.turn_id,version:target.version,quote:target.text}],source_context_ids:[],sections:[],
      reviewed_risk_assessments:[],transcript:[{turn_id:target.turn_id,role:'elder',text:target.text,version:target.version},
        {turn_id:reply.turn_id,role:'assistant',text:reply.text,version:reply.version}]}};
}

async function setupFreshConversation(h, stop = oldStop()) {
  const started = await h.start(); assert.equal(started.r.ok, true);
  const conversation = started.j.conversation;
  await h.api.vault.put('trial-control:voice', stop);
  return { conversation, stop };
}
async function submit(h, conversation, text = rawText, key = `synthetic-text:${webcrypto.randomUUID()}`) {
  return h.request(`/api/conversations/${conversation.conversation_id}/turns`, { text, source_kind: 'elder', expected_version: conversation.version },
    { 'Idempotency-Key': key });
}
function llmCalls(h) { return h.calls.filter(call => call.path === '/api/ai/conversation-turn'); }
async function pendingCorrectionCase(h) {
  const { conversation } = await setupFreshConversation(h);
  const saved = await submit(h, conversation, '这是一条虚构的、更正后待整理原话。');
  const current = { ...saved.j.conversation,new_text_trial:{...(saved.j.conversation.new_text_trial||{}),state:'completed'}, manual_correction_analysis_pending: true,
    report: { ...(saved.j.conversation.report || {}), manual_correction_analysis_pending: true } };
  await h.api.vault.put(`conversation:${conversation.conversation_id}`, current);
  return current;
}
async function pendingOrdinaryCorrectionCase(h) {
  const started=await h.start(),created=await submit(h,started.j.conversation,'这是普通路径的虚构原话。');
  const current={...created.j.conversation,manual_correction_analysis_pending:true,
    report:{...(created.j.conversation.report||{}),manual_correction_analysis_pending:true}};
  await h.api.vault.put(`conversation:${current.conversation_id}`,current);
  return current;
}
async function correctionSnapshot(h, conversation) {
  const [context, registry] = await Promise.all([h.request('/api/health-context'), h.request('/api/health-subjects')]);
  return { expected_conversation_version: conversation.version, expected_subject_id: conversation.subject_id,
    expected_subject_version: registry.j.version, expected_context_version: context.j.health_context.version };
}
function correctionPath(conversation) { return `/api/conversations/${conversation.conversation_id}/reorganize-corrected`; }

async function configureBodyBoundGrant(h, mutate = grant => grant) {
  const grantId = 'synthetic-text-grant-91';
  let grant;
  h.responses.set('/api/app/config', async ({ context, api }) => {
    const conversations = await api.vault.list('conversation:');
    const conversation = conversations.find(item => item.new_text_trial?.state === 'saved_only' || item.new_text_trial?.state === 'sending');
    if (!conversation) return { text_trial: null };
    const payload = await context.__testBuildConversationModelPayload(conversation);
    if (!grant) grant = mutate({ grant_id: grantId, receipt_id: 'synthetic-receipt-91', receipt_sha256: 'a'.repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(), http_payload_sha256: hash(JSON.stringify(payload)),
      remaining_requests: 1, kind: 'llm', retries: 0 });
    return { text_trial: grant };
  });
  return () => grant;
}
async function firstSendSnapshot(h, conversation, turn) {
  const [event, context, registry] = await Promise.all([
    h.request(`/api/events/${turn.record_id}`), h.request('/api/health-context'), h.request('/api/health-subjects'),
  ]);
  assert.equal(event.r.ok, true); assert.equal(context.r.ok, true); assert.equal(registry.r.ok, true);
  return { expected_conversation_version: conversation.version, expected_turn_version: turn.version,
    expected_event_version: event.j.event.version, expected_context_version: context.j.health_context.version,
    expected_subject_id: conversation.subject_id, expected_subject_version: registry.j.version };
}
async function savedOnlyAfterReopen() {
  const first = await harness(), { conversation, stop } = await setupFreshConversation(first);
  const result = await submit(first, conversation); assert.equal(result.j.text_trial.state, 'saved_only');
  const reopened = await first.reopen(), read = await reopened.request(`/api/conversations/${conversation.conversation_id}`);
  const turn = read.j.conversation.turns.find(item => item.role === 'elder' && item.turn_id === result.j.turn_id);
  return { reopened, conversation: read.j.conversation, turn, stop };
}
function appResumeHarness(reopened, localDate = (()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`})()) {
  const statuses = [], elements = new Map(); let context;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  context = vm.createContext({
    HealthLocal: reopened.api, activeConversation: null, localMode: true, conversationLoading: false, conversationLoadSequence: 0,
    activeHealthSubjectId:'subject_self',healthSubjectsVersion:1,healthSubjectUiEpoch:0,healthSubjectSwitchBusy: false,healthSubjectChanged:false,pendingAudioReview: null, pendingAudioReviewCandidates: [],
    conversationEditingTurnId: null, saveBusy: false, ensureHealthSubjectReady: async () => true,
    api: (path, options) => reopened.api.request(path, options), localDateValue: () => localDate,
    pendingAudioRecoveryRequestId: 0,
    syncConversation: conversation => { context.activeConversation = conversation; }, setVoiceComposerEnabled() {},
    setVoiceStatus: (text, tone) => statuses.push({ text, tone }), renderVoiceConversation() {},
    renderConversationReport() {}, loadEvents: async () => {}, findPendingAudioReviewCandidates: async () => ({ ok: true, candidates: [] }),
    conversationHasPendingReply: () => false, document: { querySelector: () => null }, $: element,
    isMockContent: turn => Boolean(turn?.is_mock), escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, ''),
  });
  for (const [start, end] of [
    ['function audioDurationLabel(', 'function naturalCorrectionTargets('],
    ['function assistantFailureCopy(', 'function voiceTurnHtml('],
    ['function legacyAudioNeedsExplicitRecovery(', 'function literalRecordTitle('],
    ['function trialVoiceMessage(', 'async function continueTrialVoice('],
    ['function canShowSavedTextFirstSend(', 'function renderVoiceConversation('],
    ['async function loadConversation(', 'async function sendSavedTextFirst('],
    ['async function startConversation(', 'async function startSeparateConversation('],
  ]) {
    const from = appSource.indexOf(start), to = appSource.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing app slice ${start}`);
    vm.runInContext(appSource.slice(from, to), context);
  }
  return { context, statuses,
    load: () => vm.runInContext('loadConversation()', context),
    start: mode => vm.runInContext(`startConversation(${JSON.stringify(mode)})`, context),
    turnHtml: id => vm.runInContext(`voiceTurnHtml(activeConversation.turns.find(turn => turn.turn_id === ${JSON.stringify(id)}))`, context) };
}

test('cross-day continue restores a valid saved-only first-send action without changing the question or old stop', async () => {
  const first = await harness(), stop = oldStop(), { conversation } = await setupFreshConversation(first, stop);
  const saved = await submit(first, conversation), reopened = await first.reopen();
  assert.equal(saved.j.text_trial.state, 'saved_only');
  const key = `conversation:${conversation.conversation_id}`;
  const stored = await reopened.api.vault.get(key);
  await reopened.api.vault.put(key, { ...stored, status: 'paused', last_local_date: '2026-10-18' });
  const before = await reopened.api.vault.get(key);
  const choice = await reopened.request('/api/conversations/current?local_date=2026-10-19');
  assert.equal(choice.j.resume_choice_required, true);
  const ui = appResumeHarness(reopened, '2026-10-19');
  assert.equal(await ui.start('continue'), true);
  assert.ok(ui.statuses.some(item => /把这段话发给小零/.test(item.text)));
  const continued = ui.context.activeConversation;
  assert.equal(continued.conversation_id, conversation.conversation_id);
  assert.equal(continued.new_text_trial.state, 'saved_only');
  assert.equal(continued.new_text_trial.first_send_available, true);
  assert.equal(continued.turns.find(turn => turn.turn_id === saved.j.turn_id).text, rawText);
  assert.deepEqual(continued.turns, before.turns, 'the actual prior assistant question and every turn remain byte-for-byte equivalent');
  assert.ok(ui.turnHtml(saved.j.turn_id).includes('data-voice-first-send'));
  assert.deepEqual(await reopened.api.trialVoiceState(), stop, 'continuation does not consume or replace the old closed stop');
  assert.equal(llmCalls(reopened).length, 0, 'cross-day continuation does not make a model request');
});

test('cross-day continue never restores first-send eligibility for terminal or already-claimed text trials', async t => {
  for (const state of ['failed', 'completed', 'sending', 'discarded']) await t.test(state, async () => {
    const first = await harness(), { conversation } = await setupFreshConversation(first, oldStop());
    const saved = await submit(first, conversation), reopened = await first.reopen();
    const key = `conversation:${conversation.conversation_id}`;
    const stored = await reopened.api.vault.get(key);
    await reopened.api.vault.put(key, { ...stored, status: 'paused', last_local_date: '2026-10-18',
      new_text_trial: { ...stored.new_text_trial, state } });
    const continued = await reopened.request('/api/conversations/start', { mode: 'continue', local_date: '2026-10-19' });
    assert.equal(continued.j.conversation.new_text_trial.state, state);
    assert.notEqual(continued.j.conversation.new_text_trial.first_send_available, true);
    assert.equal(continued.j.conversation.turns.find(turn => turn.turn_id === saved.j.turn_id).text, rawText);
    assert.equal(llmCalls(reopened).length, 0);
  });

  await t.test('spent grant claim', async () => {
    const first = await harness(), { conversation } = await setupFreshConversation(first, oldStop());
    const saved = await submit(first, conversation), reopened = await first.reopen();
    const key = `conversation:${conversation.conversation_id}`;
    const stored = await reopened.api.vault.get(key);
    await reopened.api.vault.put(key, { ...stored, status: 'paused', last_local_date: '2026-10-18' });
    await reopened.api.vault.put(`new-text-trial-grant:${hash('synthetic-spent-grant')}`, {
      grant_id: 'synthetic-spent-grant', conversation_id: conversation.conversation_id, turn_id: saved.j.turn_id, state: 'failed' });
    const continued = await reopened.request('/api/conversations/start', { mode: 'continue', local_date: '2026-10-19' });
    assert.equal(continued.j.conversation.new_text_trial.first_send_available, false);
    assert.equal(llmCalls(reopened).length, 0);
  });
});

test('cross-day continue under another family member creates their own empty conversation', async () => {
  const first = await harness(), { conversation } = await setupFreshConversation(first, oldStop());
  const saved = await submit(first, conversation), reopened = await first.reopen();
  const registry = (await reopened.request('/api/health-subjects')).j;
  const added = await reopened.request('/api/health-subjects', { label: '虚构测试家属', relationship: 'family', expected_version: registry.version });
  const family = added.j.subjects.find(subject => subject.relationship === 'family');
  assert.ok(family);
  await reopened.request('/api/health-subjects/active', { subject_id: family.subject_id, expected_version: added.j.version });
  const continued = await reopened.request('/api/conversations/start', { mode: 'continue', local_date: '2026-10-19' });
  assert.notEqual(continued.j.conversation.conversation_id, conversation.conversation_id);
  assert.equal(continued.j.conversation.subject_id, family.subject_id);
  assert.equal(continued.j.conversation.turns.some(turn => turn.role === 'elder' && turn.text === rawText), false);
  assert.equal(continued.j.conversation.new_text_trial?.turn_id, undefined);
  assert.equal(llmCalls(reopened).length, 0);
  assert.equal((await reopened.api.vault.get(`conversation:${conversation.conversation_id}`)).turns.some(turn => turn.turn_id === saved.j.turn_id), true);
});

test('unrelated stopped marker permits encrypted local text, but no fresh grant means no model and no resume', async () => {
  const h = await harness(), { conversation, stop } = await setupFreshConversation(h);
  const result = await submit(h, conversation);
  assert.equal(result.r.status, 202);
  assert.equal(result.j.text_trial.state, 'saved_only');
  assert.equal(result.j.conversation.turns.at(-1).text, rawText);
  assert.equal(result.j.conversation.new_text_trial.turn_id, result.j.turn_id);
  assert.equal(result.j.conversation.new_text_trial.state, 'saved_only');
  assert.deepEqual(await h.api.trialVoiceState(), stop, 'the old global stop is byte-for-byte unchanged');
  assert.equal((await h.api.vault.list('event:')).at(-1).raw_text, rawText);
  assert.equal(JSON.stringify(await h.driver.listDocs()).includes(rawText), false, 'plaintext stays out of the encrypted store');
  assert.equal(llmCalls(h).length, 0);
  await h.api.vault.put('trial-control:voice', { ...stop, state: 'completed' });
  await h.request(`/api/conversations/${conversation.conversation_id}/resume-assistant`, {});
  assert.equal(llmCalls(h).length, 0);
});

test('fresh exact-body grant dispatches once with its dedicated header and leaves the prior stop untouched', async () => {
  const h = await harness(), { conversation, stop } = await setupFreshConversation(h);
  await configureBodyBoundGrant(h);
  const key = 'synthetic-text:single-use';
  const result = await submit(h, conversation, rawText, key);
  assert.equal(result.r.status, 201, JSON.stringify(result.j));
  assert.equal(result.j.text_trial.state, 'completed');
  assert.equal(llmCalls(h).length, 1);
  assert.equal(llmCalls(h)[0].headers['X-NoReset-Text-Trial'], 'synthetic-text-grant-91');
  assert.equal(llmCalls(h)[0].headers['X-NoReset-Saved-Audio-Trial'], undefined);
  assert.equal(JSON.parse(llmCalls(h)[0].body).turns.at(-1).text, rawText);
  assert.deepEqual(await h.api.trialVoiceState(), stop);
  const claims = await h.api.vault.list('new-text-trial-grant:');
  assert.equal(claims.length, 1); assert.equal(claims[0].state, 'completed');
  assert.equal(claims[0].body_sha256, hash(llmCalls(h)[0].body));
  const replay = await submit(h, conversation, rawText, key);
  assert.equal(replay.j.created, false); assert.equal(llmCalls(h).length, 1);
});

test('expired or mismatched one-shot grants save locally and never reach the model', async t => {
  for (const [name, mutate] of [
    ['expired', grant => ({ ...grant, expires_at: new Date(Date.now() - 1000).toISOString() })],
    ['wrong body hash', grant => ({ ...grant, http_payload_sha256: '0'.repeat(64) })],
    ['retryable grant', grant => ({ ...grant, retries: 1 })],
  ]) await t.test(name, async () => {
    const h = await harness(), { conversation } = await setupFreshConversation(h);
    await configureBodyBoundGrant(h, mutate);
    const result = await submit(h, conversation);
    assert.equal(result.j.text_trial.state, 'saved_only');
    assert.equal(result.j.conversation.turns.some(turn => turn.role === 'elder' && turn.text === rawText), true);
    assert.equal(llmCalls(h).length, 0);
    assert.equal((await h.api.vault.list('new-text-trial-grant:')).length, 0);
  });
});

test('in-progress old trial blocks a fresh grant but still preserves unrelated plain text locally', async t => {
  for (const stop of [oldStop(null, 'continuing'), oldStop(null, 'processing')]) await t.test(stop.state, async () => {
    const h = await harness(), { conversation } = await setupFreshConversation(h, stop);
    await configureBodyBoundGrant(h);
    const result = await submit(h, conversation);
    assert.equal(result.j.text_trial.state, 'saved_only');
    assert.equal(llmCalls(h).length, 0);
    assert.deepEqual(await h.api.trialVoiceState(), stop);
  });
});

test('retained N03 ASR review marker with media_id permits a truly text-only new conversation without changing old controls', async () => {
  const h = await harness();
  const retainedStop = { review_required: true, state: 'review_required', media_id: 'media_9f654f4fddad4cd5bb5b282f5cbdeff2', conversation_id: null };
  const { conversation } = await setupFreshConversation(h, retainedStop);
  await configureBodyBoundGrant(h);
  const result = await submit(h, conversation);
  assert.equal(result.j.text_trial.state, 'completed');
  assert.equal(llmCalls(h).length, 1);
  assert.equal(llmCalls(h)[0].headers['X-NoReset-Text-Trial'], 'synthetic-text-grant-91');
  assert.deepEqual(await h.api.trialVoiceState(), retainedStop);
  assert.equal(result.j.conversation.turns.filter(turn => turn.role === 'elder').every(turn => turn.source_kind === 'elder' && !turn.media_id), true);
});

test('failed one-shot grant is durably consumed and cannot be manually resumed for the same source', async () => {
  const h = await harness(), { conversation, stop } = await setupFreshConversation(h);
  await configureBodyBoundGrant(h);
  h.responses.set('/api/ai/conversation-turn', { __status: 503, error: 'provider_unavailable' });
  const key = 'synthetic-text:failed-once', result = await submit(h, conversation, rawText, key);
  assert.equal(result.r.status, 202);
  assert.equal(result.j.text_trial.state, 'failed');
  assert.equal(result.j.ai_failed, true);
  assert.deepEqual(await h.api.trialVoiceState(), stop);
  assert.equal((await h.api.vault.list('new-text-trial-grant:'))[0].state, 'failed');
  assert.equal(llmCalls(h).length, 1);
  await h.api.vault.put('trial-control:voice', { ...stop, state: 'completed' });
  await h.request(`/api/conversations/${conversation.conversation_id}/resume-assistant`, {});
  assert.equal(llmCalls(h).length, 1);
  const replay = await submit(h, conversation, rawText, key);
  assert.equal(replay.j.created, false); assert.equal(llmCalls(h).length, 1);
});

test('same-conversation owner and audio-linked conversation cannot use fresh text grants', async () => {
  const h = await harness(), started = await h.start(), conversation = started.j.conversation;
  const stop = oldStop(conversation.conversation_id);
  await h.api.vault.put('trial-control:voice', stop);
  await configureBodyBoundGrant(h);
  const result = await submit(h, conversation);
  assert.equal(result.r.status, 409);
  assert.equal(llmCalls(h).length, 0);
  assert.deepEqual(await h.api.trialVoiceState(), stop);
  const audioLinked = { ...conversation, turns: [...conversation.turns, { turn_id: 'synthetic-audio-turn', role: 'elder',
    text: '旧录音识别文字', original_text: '旧录音识别文字', source_kind: 'audio_transcript', media_id: 'old-audio',
    record_id: 'old-record', version: 1, created_at: new Date().toISOString() }], version: conversation.version + 1 };
  assert.equal(h.context.__testMayUseFreshTextTrial({ ...oldStop(), media_id: 'old-audio' }, audioLinked), false);
});

test('late Memory change between encrypted save and grant read aborts without a request', async () => {
  const h = await harness(), { conversation } = await setupFreshConversation(h);
  h.responses.set('/api/app/config', async ({ api, context }) => {
    const contexts = await api.vault.get('health-context:current');
    await api.vault.put('health-context:current', { ...(contexts || { version: 0, entries: [] }), version: 9, updated_at: 'synthetic-change' });
    const saved = (await api.vault.list('conversation:')).find(item => item.new_text_trial?.state === 'saved_only');
    const payload = await context.__testBuildConversationModelPayload(saved);
    return { text_trial: { grant_id: 'synthetic-memory-race', receipt_id: 'synthetic-receipt', receipt_sha256: 'b'.repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(), http_payload_sha256: hash(JSON.stringify(payload)), remaining_requests: 1, kind: 'llm', retries: 0 } };
  });
  const result = await submit(h, conversation);
  assert.equal(result.j.text_trial.state, 'saved_only');
  assert.equal(result.j.conversation.turns.some(turn => turn.role === 'elder' && turn.text === rawText), true);
  assert.equal(llmCalls(h).length, 0);
  assert.equal((await h.api.vault.list('new-text-trial-grant:')).length, 0);
});

test('saved-only text can be manually sent once after AES lock and new-realm reopen with a preinstalled exact grant', async () => {
  const firstRealm = await harness();
  const retainedStop = { review_required: true, state: 'review_required', media_id: 'media_9f654f4fddad4cd5bb5b282f5cbdeff2', conversation_id: null };
  const { conversation, stop } = await setupFreshConversation(firstRealm, retainedStop);
  const first = await submit(firstRealm, conversation);
  assert.equal(first.j.text_trial.state, 'saved_only');
  const savedTurn = first.j.conversation.turns.find(turn => turn.role === 'elder' && turn.turn_id === first.j.turn_id);
  assert.ok(savedTurn);
  const reopened = await firstRealm.reopen();
  const read = await reopened.request(`/api/conversations/${conversation.conversation_id}`);
  assert.equal(read.j.conversation.new_text_trial.state, 'saved_only');
  assert.equal(read.j.conversation.turns.filter(turn => turn.role === 'elder').length, 1);
  assert.equal(read.j.conversation.new_text_trial.first_send_available, true);
  const frozenPayload = await reopened.context.__testBuildConversationModelPayload(read.j.conversation);
  const fixedGrant = { grant_id: 'synthetic-static-after-reopen', receipt_id: 'synthetic-receipt-static',
    receipt_sha256: 'd'.repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString(),
    http_payload_sha256: hash(JSON.stringify(frozenPayload)), remaining_requests: 1, kind: 'llm', retries: 0 };
  let configReads = 0;
  reopened.responses.set('/api/app/config', () => { configReads += 1; return { text_trial: fixedGrant }; });
  assert.equal(configReads, 0, 'grant is statically installed after reopen, not generated by a later GET');
  const expected = await firstSendSnapshot(reopened, read.j.conversation, savedTurn);
  const actionPath = `/api/conversations/${conversation.conversation_id}/turns/${savedTurn.turn_id}/first-send`;
  assert.equal(configReads, 0, 'snapshot reads after installing the grant do not generate or fetch a new grant');
  const results = await Promise.all([reopened.request(actionPath, expected), reopened.request(actionPath, expected)]);
  const sent = results.find(item => item.r.ok);
  assert.equal(sent.r.ok, true, JSON.stringify(sent.j));
  assert.equal(sent.j.text_trial.state, 'completed');
  assert.equal(llmCalls(reopened).length, 1);
  assert.equal(llmCalls(reopened)[0].headers['X-NoReset-Text-Trial'], fixedGrant.grant_id);
  assert.equal(sent.j.conversation.turns.filter(turn => turn.role === 'elder').length, 1, 'no duplicate elder turn is created');
  assert.deepEqual(await reopened.api.trialVoiceState(), stop, 'retained media stop remains unchanged');
  assert.ok(configReads > 0, 'manual action reads the statically installed current grant');
  assert.equal(llmCalls(reopened).length, 1, 'simultaneous taps cannot dispatch twice');
  const afterRestart = await reopened.reopen();
  const completed = await afterRestart.request(`/api/conversations/${conversation.conversation_id}`);
  assert.equal(completed.j.conversation.new_text_trial.state, 'completed');
  assert.equal(completed.j.conversation.new_text_trial.first_send_available, false);
  const repeated = await afterRestart.request(actionPath, expected);
  assert.equal(repeated.r.ok, false);
  assert.equal(llmCalls(afterRestart).length, 1, 'completed turn cannot be replayed after restart');
});

test('manual first-send with no grant keeps the text and leaves the action available', async () => {
  const { reopened, conversation, turn } = await savedOnlyAfterReopen();
  const snapshot = await firstSendSnapshot(reopened, conversation, turn);
  const attempted = await reopened.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}/first-send`, snapshot);
  assert.equal(attempted.r.ok, true);
  assert.equal(attempted.j.text_trial.state, 'saved_only');
  assert.equal(attempted.j.conversation.new_text_trial.first_send_available, true);
  assert.equal(llmCalls(reopened).length, 0);
  assert.equal((await reopened.api.vault.get(`event:${turn.record_id}`)).raw_text, turn.text);
});

test('correcting a saved-only source stays local, then first-send uses the corrected same turn', async () => {
  const { reopened, conversation, turn } = await savedOnlyAfterReopen(), correctedText = `${turn.text} 已由本人更正。`;
  const edited = await reopened.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}`, {
    text: correctedText, expected_version: turn.version, expected_conversation_version: conversation.version,
  });
  assert.equal(edited.r.ok, true); assert.equal(edited.j.text_trial.state, 'saved_only');
  assert.equal(edited.j.conversation.new_text_trial.first_send_available, true);
  assert.equal(edited.j.conversation.turns.filter(item => item.role === 'elder').length, 1);
  assert.equal(edited.j.conversation.turns.at(-1).text, correctedText);
  assert.equal(edited.j.conversation.turns.at(-1).original_text, correctedText);
  assert.equal(llmCalls(reopened).length, 0, 'correction does not trigger an ordinary hidden reply');
  const saved = await reopened.request(`/api/conversations/${conversation.conversation_id}`);
  const currentTurn = saved.j.conversation.turns.find(item => item.role === 'elder' && item.turn_id === turn.turn_id);
  const payload = await reopened.context.__testBuildConversationModelPayload(saved.j.conversation);
  const fixedGrant = { grant_id: 'synthetic-corrected-first-send', receipt_id: 'synthetic-corrected-receipt',
    receipt_sha256: '1'.repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString(),
    http_payload_sha256: hash(JSON.stringify(payload)), remaining_requests: 1, kind: 'llm', retries: 0 };
  reopened.responses.set('/api/app/config', { text_trial: fixedGrant });
  const result = await reopened.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}/first-send`,
    await firstSendSnapshot(reopened, saved.j.conversation, currentTurn));
  assert.equal(result.j.text_trial.state, 'completed');
  assert.equal(llmCalls(reopened).length, 1);
  assert.equal(JSON.parse(llmCalls(reopened)[0].body).turns.at(-1).text, correctedText);
  assert.equal(result.j.conversation.turns.filter(item => item.role === 'elder').length, 1);
});

test('manual first-send rejects stale context, subject, event, and conversation snapshots before reading the grant', async t => {
  for (const stale of ['context', 'subject', 'event', 'conversation']) await t.test(stale, async () => {
    const { reopened, conversation, turn } = await savedOnlyAfterReopen();
    const snapshot = await firstSendSnapshot(reopened, conversation, turn);
    const payload = await reopened.context.__testBuildConversationModelPayload(conversation);
    const fixedGrant = { grant_id: `synthetic-stale-${stale}`, receipt_id: 'synthetic-receipt-stale',
      receipt_sha256: 'e'.repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString(),
      http_payload_sha256: hash(JSON.stringify(payload)), remaining_requests: 1, kind: 'llm', retries: 0 };
    let configReads = 0; reopened.responses.set('/api/app/config', () => { configReads += 1; return { text_trial: fixedGrant }; });
    if (stale === 'context') {
      await reopened.api.vault.put('health-context:current', { subject_id: snapshot.expected_subject_id,
        version: snapshot.expected_context_version + 1, entries: [] });
    } else if (stale === 'subject') snapshot.expected_subject_version += 1;
    else if (stale === 'event') snapshot.expected_event_version += 1;
    else snapshot.expected_conversation_version += 1;
    const attempted = await reopened.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}/first-send`, snapshot);
    assert.equal(attempted.r.ok, false);
    assert.equal(configReads, 0);
    assert.equal(llmCalls(reopened).length, 0);
    assert.equal((await reopened.api.vault.get(`event:${turn.record_id}`)).raw_text, turn.text);
    assert.equal((await reopened.api.vault.get(`conversation:${conversation.conversation_id}`)).new_text_trial.state, 'saved_only');
  });
});

test('existing grant or scope claim hides and blocks the saved-only action', async () => {
  const { reopened, conversation, turn } = await savedOnlyAfterReopen();
  await reopened.api.vault.put('new-text-trial-scope:synthetic-existing', { grant_id: 'synthetic-existing',
    conversation_id: conversation.conversation_id, turn_id: turn.turn_id, scope_id: 'synthetic-existing', state: 'failed' });
  const read = await reopened.request(`/api/conversations/${conversation.conversation_id}`);
  assert.equal(read.j.conversation.new_text_trial.first_send_available, false);
  const snapshot = await firstSendSnapshot(reopened, conversation, turn);
  const attempted = await reopened.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}/first-send`, snapshot);
  assert.equal(attempted.r.ok, false);
  assert.equal(llmCalls(reopened).length, 0);
});

test('a context change after the one-shot claim keeps the claim and sending state without dispatch', async () => {
  const first = await harness(), { conversation, stop } = await setupFreshConversation(first);
  const saved = await submit(first, conversation); assert.equal(saved.j.text_trial.state, 'saved_only');
  const reopened = await first.reopen(), read = await reopened.request(`/api/conversations/${conversation.conversation_id}`);
  const turn = read.j.conversation.turns.find(item => item.role === 'elder' && item.turn_id === saved.j.turn_id);
  const snapshot = await firstSendSnapshot(reopened, read.j.conversation, turn);
  const payload = await reopened.context.__testBuildConversationModelPayload(read.j.conversation);
  reopened.responses.set('/api/app/config', { text_trial: { grant_id: 'synthetic-post-claim-race', receipt_id: 'synthetic-race-receipt',
    receipt_sha256: 'f'.repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString(),
    http_payload_sha256: hash(JSON.stringify(payload)), remaining_requests: 1, kind: 'llm', retries: 0 } });
  reopened.context.__testAfterTextTrialClaim = async () => {
    await reopened.api.vault.put('health-context:current', { subject_id: snapshot.expected_subject_id,
      version: snapshot.expected_context_version + 1, entries: [] });
  };
  const attempted = await reopened.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}/first-send`, snapshot);
  assert.equal(attempted.r.ok, true);
  assert.equal(attempted.j.text_trial.state, 'sending');
  assert.equal(attempted.j.conversation.new_text_trial.first_send_available, false);
  assert.equal(attempted.j.conversation.new_text_trial.state, 'sending');
  assert.equal(llmCalls(reopened).length, 0);
  assert.equal((await reopened.api.vault.list('new-text-trial-scope:')).at(-1).state, 'sending');
  assert.equal((await reopened.api.vault.list('new-text-trial-grant:')).at(-1).state, 'sending');
  assert.deepEqual(await reopened.api.trialVoiceState(), stop);
  assert.match(appSource, /state==='sending'\?'原话仍保存在本机；刚才的处理结果还不能确认。请重新打开对话核对当前状态。'/);
});

test('elder conversation shows the manual action only for the current untouched saved-only turn', () => {
  const start = appSource.indexOf('function canShowSavedTextFirstSend(');
  const end = appSource.indexOf('\nfunction voiceTurnHtml', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ isMockContent: turn => Boolean(turn.is_mock) });
  vm.runInContext(`${appSource.slice(start, end)}\nglobalThis.check = canShowSavedTextFirstSend;`, context);
  const turn = { turn_id: 'turn_saved', role: 'elder', source_kind: 'elder', text: '合成原话', original_text: '合成原话', version: 1 };
  const conversation = { turns: [turn], new_text_trial: { turn_id: turn.turn_id, state: 'saved_only', first_send_available: true } };
  assert.equal(context.check(conversation, turn), true);
  for (const state of ['sending', 'completed', 'failed', 'discarded']) {
    assert.equal(context.check({ ...conversation, new_text_trial: { ...conversation.new_text_trial, state } }, turn), false);
  }
  assert.equal(context.check({ ...conversation, trial_control: { state: 'review_required' } }, turn), false);
  assert.equal(context.check({ ...conversation, new_text_trial: { ...conversation.new_text_trial, first_send_available: false } }, turn), false);
  assert.equal(context.check({ ...conversation, turns: [turn, { turn_id: 'turn_later', role: 'elder' }] }, turn), false);
  assert.equal(context.check(conversation, { ...turn, original_text: '旧文字' }), false);
});

test('same-day reopen keeps saved-only text visible and independent from a retained audio stop', async () => {
  const first = await harness();
  const retainedStop = { review_required: true, state: 'review_required', source_kind: 'elder',
    conversation_id: null, turn_id: 'synthetic-retained-audio-stop', turn_version: 1, media_id: 'media_synthetic_retained' };
  const { conversation } = await setupFreshConversation(first, retainedStop);
  const saved = await submit(first, conversation);
  assert.equal(saved.j.text_trial.state, 'saved_only');
  const reopened = await first.reopen();
  const d=new Date(),localDate=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const current = await reopened.request('/api/conversations/current?local_date='+localDate);
  const direct = await reopened.request(`/api/conversations/${conversation.conversation_id}`);
  assert.equal(current.r.status, 200);
  assert.equal(direct.r.status, 200);

  const statuses = [], elements = new Map(), el = id => elements.get(id) || {};
  let context;
  context = vm.createContext({
    HealthLocal: reopened.api, activeConversation: null, localMode: true, conversationLoading: false, conversationLoadSequence: 0,
    activeHealthSubjectId:'subject_self',healthSubjectsVersion:1,healthSubjectUiEpoch:0,healthSubjectSwitchBusy: false,healthSubjectChanged:false,pendingAudioReview: null, pendingAudioReviewCandidates: [],
    conversationEditingTurnId: null, saveBusy: false, ensureHealthSubjectReady: async () => true,
    api: (path, options) => reopened.api.request(path, options), localDateValue: () => localDate,
    syncConversation: conversation => { context.activeConversation = conversation; },
    setVoiceComposerEnabled() {}, setVoiceStatus: (text, tone) => statuses.push({ text, tone }),
    renderVoiceConversation() {}, renderConversationReport() {}, loadEvents: async () => {},
    findPendingAudioReviewCandidates: async () => ({ ok: true, candidates: [] }),
    conversationHasPendingReply: () => false, document: { querySelector: () => null }, $: el,
    isMockContent: turn => Boolean(turn?.is_mock), escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, ''),
  });
  for (const [start, end] of [
    ['function audioDurationLabel(', 'function naturalCorrectionTargets('],
    ['function trialVoiceMessage(', 'async function continueTrialVoice('],
    ['function canShowSavedTextFirstSend(', 'function renderVoiceConversation('],
    ['async function loadConversation(', 'async function sendSavedTextFirst('],
  ]) {
    const from = appSource.indexOf(start), to = appSource.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing app slice ${start}`);
    vm.runInContext(appSource.slice(from, to), context);
  }
  await vm.runInContext('loadConversation()', context);
  const turn = context.activeConversation.turns.find(item => item.turn_id === saved.j.turn_id);
  const html = vm.runInContext('voiceTurnHtml(activeConversation.turns.find(item => item.turn_id === ' + JSON.stringify(saved.j.turn_id) + '))', context);
  const actual = {
    currentFirstSendAvailable: current.j.conversation.new_text_trial.first_send_available === true,
    directFirstSendAvailable: direct.j.conversation.new_text_trial.first_send_available === true,
    savedTextStatus: statuses.some(item => /原话已加密保存在本机/.test(item.text) && /把这段话发给小零/.test(item.text)),
    oldAudioPromptShown: statuses.some(item => /语音已转成文字/.test(item.text)),
    firstSendButtonShown: html.includes('data-voice-first-send'),
    textTrialState: turn?.source_kind === 'elder' && context.activeConversation.new_text_trial?.state === 'saved_only',
  };
  assert.deepEqual(actual, {
    currentFirstSendAvailable: true, directFirstSendAvailable: true, savedTextStatus: true,
    oldAudioPromptShown: false, firstSendButtonShown: true, textTrialState: true,
  });
  assert.deepEqual(await reopened.api.trialVoiceState(), retainedStop, 'the old global audio stop remains unchanged');
  assert.equal(reopened.calls.some(call => call.path === '/api/ai/conversation-turn'), false, 'reopen never dispatches a model request');
});

test('claimed and terminal text trials stay text-specific on reopen without replay, while actual audio control still gates', async () => {
  const first = await harness();
  const retainedStop = { review_required: true, state: 'review_required', source_kind: 'elder',
    conversation_id: null, turn_id: 'synthetic-retained-audio-stop', turn_version: 1, media_id: 'media_synthetic_retained' };
  const { conversation } = await setupFreshConversation(first, retainedStop);
  const saved = await submit(first, conversation); assert.equal(saved.j.text_trial.state, 'saved_only');
  const reopened = await first.reopen(), conversationKey = `conversation:${conversation.conversation_id}`;
  const expected = {
    sending: /文字.*(结果|回复).*无法确认|文字.*处理中/,
    completed: /文字.*回复已保存在本机/,
    failed: /文字.*回复未完成/,
    discarded: /文字.*旧回复未写入/,
  };
  for (const [state, statusPattern] of Object.entries(expected)) {
    const current = await reopened.api.vault.get(conversationKey);
    await reopened.api.vault.put(conversationKey, { ...current,
      new_text_trial: { ...current.new_text_trial, state, first_send_available: false } });
    const ui = appResumeHarness(reopened), callStart = reopened.calls.length;
    await ui.load();
    const status = ui.statuses.at(-1)?.text || '', html = ui.turnHtml(saved.j.turn_id);
    const paths = reopened.calls.slice(callStart).map(call => call.path);
    assert.match(status, statusPattern, state);
    assert.doesNotMatch(status, /语音已转成文字/, state);
    assert.doesNotMatch(html, /data-voice-first-send/, state);
    assert.equal(paths.some(path => path.endsWith('/resume-assistant')), false, `${state} is not automatically resumed`);
    assert.equal(paths.includes('/api/ai/conversation-turn'), false, `${state} does not call the model`);
    assert.deepEqual(await reopened.api.trialVoiceState(), retainedStop, `${state} leaves the old audio stop unchanged`);
  }

  const current = await reopened.api.vault.get(conversationKey);
  const actualAudioControl = { review_required: true, state: 'review_required', source_kind: 'audio_transcript',
    conversation_id: conversation.conversation_id, turn_id: 'synthetic-same-conversation-audio', turn_version: 1, media_id: 'media_synthetic_same_conversation' };
  await reopened.api.vault.put(conversationKey, { ...current, trial_control: actualAudioControl,
    new_text_trial: { ...current.new_text_trial, state: 'saved_only', first_send_available: true } });
  const ui = appResumeHarness(reopened), callStart = reopened.calls.length;
  await ui.load();
  const status = ui.statuses.at(-1)?.text || '', paths = reopened.calls.slice(callStart).map(call => call.path);
  assert.match(status, /语音已转成文字.*对照录音核对/);
  assert.doesNotMatch(status, /把这段话发给小零/);
  assert.doesNotMatch(ui.turnHtml(saved.j.turn_id), /data-voice-first-send/);
  assert.equal(paths.some(path => path.endsWith('/resume-assistant')), false);
  assert.equal(paths.includes('/api/ai/conversation-turn'), false);
  assert.deepEqual(await reopened.api.trialVoiceState(), retainedStop, 'actual conversation control does not mutate the old global stop');
});

test('an unrelated or unbound global audio marker is not presented as the current conversation transcript', async t => {
  const run = async (family, state = 'review_required') => {
    const h = await harness();
    const self = (await h.start()).j.conversation;
    const retained = { review_required: true, state,
      media_id: 'media_synthetic_old_self', conversation_id: self.conversation_id };
    await h.api.vault.put('trial-control:voice', retained);
    if (family) {
      const registry = (await h.request('/api/health-subjects')).j;
      const created = await h.request('/api/health-subjects', { label: '虚构妈妈', relationship: 'family', expected_version: registry.version });
      const mother = created.j.subjects.find(subject => subject.relationship === 'family');
      await h.request('/api/health-subjects/active', { subject_id: mother.subject_id, expected_version: created.j.version });
      const current = (await h.start()).j.conversation;
      assert.equal(current.turns.filter(turn => turn.role === 'elder').length, 0);
      assert.equal((await h.api.vault.list('media:')).length, 0);
    } else {
      retained.conversation_id = null;
      await h.api.vault.put('trial-control:voice', retained);
      const current = (await h.api.request(`/api/conversations/${self.conversation_id}`)).j.conversation;
      assert.equal(current.turns.filter(turn => turn.role === 'elder').length, 0);
      assert.equal((await h.api.vault.list('media:')).length, 0);
    }
    const ui = appResumeHarness(h);
    await ui.load();
    return ui.statuses.map(status => status.text).join('\n');
  };
  await t.test('empty new self conversation with unbound media stop', async () => {
    const status = await run(false);
    assert.doesNotMatch(status, /语音已转成文字/);
  });
  await t.test('empty mother conversation with prior self media stop', async () => {
    const status = await run(true);
    assert.doesNotMatch(status, /语音已转成文字/);
  });
  await t.test('unbound processing marker uses a generic wait status', async () => {
    const status = await run(false, 'processing');
    assert.match(status, /另一段处理还未结束/);
    assert.doesNotMatch(status, /语音已转成文字/);
  });
  await t.test('same-conversation global marker remains visible', async () => {
    const h = await harness(), conversation = (await h.start()).j.conversation;
    await h.api.vault.put('trial-control:voice', { review_required: true, state: 'review_required',
      media_id: 'media_synthetic_current', conversation_id: conversation.conversation_id });
    const ui = appResumeHarness(h);
    await ui.load();
    assert.match(ui.statuses.map(status => status.text).join('\n'), /语音已转成文字/);
  });
});

test('text and ASR config requests use only headers allowed by the cross-origin OPTIONS contract', async () => {
  const source = fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8');
  const server = fs.readFileSync(require.resolve('../backend/server.py'), 'utf8');
  const match = server.match(/Access-Control-Allow-Headers','([^']+)'/);
  assert.ok(match, 'server OPTIONS allow-header declaration exists');
  const allowed = new Set(match[1].split(',').map(header => header.trim().toLowerCase()));
  const requests = [], context = vm.createContext({
    onlineSession: async () => 'synthetic-csrf',
    cloudFetch: async (path, options) => {
      requests.push({ path, options });
      return { r: { ok: true }, j: { text_trial: null, asr_trial: null } };
    },
  });
  for (const [name, start, end] of [
    ['currentTextTrial', 'async function currentTextTrial(', 'function validTextTrial('],
    ['currentAsrTrial', 'async function currentAsrTrial(', 'function validAsrTrial('],
  ]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `missing ${name} source`);
    vm.runInContext(source.slice(from, to), context);
    await context[name]();
    const request = requests.at(-1);
    assert.equal(request.path, '/api/app/config');
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.headers['X-CSRF-Token'], 'synthetic-csrf');
    const clientHeaders = [...new Set(['Content-Type', ...Object.keys(request.options.headers)])]
      .map(header => header.toLowerCase());
    assert.deepEqual(clientHeaders.filter(header => !allowed.has(header)), [], `${name} OPTIONS headers are allowed`);
  }
});

test('corrected reorganization without an exact current grant stays local and preserves the pending source', async () => {
  const h = await harness(), conversation = await pendingCorrectionCase(h);
  const result = await h.request(correctionPath(conversation), await correctionSnapshot(h, conversation));
  assert.equal(result.r.ok, true); assert.equal(result.j.dispatched, false);
  assert.equal(result.j.conversation.manual_correction_analysis_pending, true);
  assert.equal((await h.api.vault.get(`event:${conversation.turns.at(-1).record_id}`)).raw_text, conversation.turns.at(-1).text);
  assert.equal(llmCalls(h).length, 0);
});

test('corrected reorganization rejects a wrong-payload grant and a grant already claimed by first-send', async () => {
  const run=async used=>{
    const h=await harness(),conversation=await pendingCorrectionCase(h),payload=await h.context.__testBuildConversationModelPayload(conversation);
    const grant={grant_id:used?'synthetic-used-text-grant':'synthetic-wrong-payload-grant',receipt_id:'synthetic-receipt',receipt_sha256:'8'.repeat(64),
      expires_at:new Date(Date.now()+60_000).toISOString(),http_payload_sha256:used?hash(JSON.stringify(payload)):'0'.repeat(64),remaining_requests:1,kind:'llm',retries:0};
    h.responses.set('/api/app/config',{text_trial:grant});
    if(used)await h.api.vault.put(`new-text-trial-grant:${hash(grant.grant_id)}`,{state:'completed'});
    const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
    assert.equal(result.j.dispatched,false);assert.equal(llmCalls(h).length,0);
    assert.equal(result.j.conversation.manual_correction_analysis_pending,true);
  };
  await run(false);await run(true);
});

test('a grant revoked between authorization reads is rejected before the model call', async () => {
  const h=await harness(),conversation=await pendingCorrectionCase(h),payload=await h.context.__testBuildConversationModelPayload(conversation);
  const grant={grant_id:'synthetic-revoked-correction-grant',receipt_id:'synthetic-revoked-receipt',receipt_sha256:'7'.repeat(64),
    expires_at:new Date(Date.now()+60_000).toISOString(),http_payload_sha256:hash(JSON.stringify(payload)),remaining_requests:1,kind:'llm',retries:0};
  let reads=0;h.responses.set('/api/app/config',()=>({text_trial:++reads<3?grant:null,text_trial_required:true}));
  const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
  assert.equal(llmCalls(h).length,0);assert.equal(reads,3);assert.equal(result.j.dispatched,false);
  const after=(await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.equal(after.manual_correction_analysis_pending,true);
  assert.equal(after.turns.length,conversation.turns.length);
});

test('a corrected source event revised or deleted outside the cached conversation blocks reorganization', async t => {
  for(const state of ['revised','deleted'])await t.test(state,async()=>{
    const h=await harness(),conversation=await pendingCorrectionCase(h),turn=conversation.turns.find(item=>item.role==='elder');
    const key=`event:${turn.record_id}`,event=await h.api.vault.get(key);
    if(state==='deleted')await h.api.vault.remove(key);
    else await h.api.vault.put(key,{...event,raw_text:'外部修改后的虚构来源',version:event.version+1});
    h.responses.set('/api/app/config',{text_trial_required:false,text_trial:null});
    const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
    assert.equal(result.j.dispatched,false);assert.equal(llmCalls(h).length,0);
  });
});

test('ordinary pending correction may use the normal path only when backend explicitly says no trial gate is installed', async () => {
  const h=await harness(),conversation=await pendingOrdinaryCorrectionCase(h);
  const turn=conversation.turns.find(item=>item.role==='elder'),event=await h.api.vault.get(`event:${turn.record_id}`);
  assert.equal(event.raw_text,turn.text);assert.equal(event.state,'inbox');assert.equal(await h.api.trialVoiceState(),null);
  h.responses.set('/api/app/config',{text_trial:null,text_trial_required:false});
  h.responses.set('/api/ai/conversation-turn',{action:'reply',assistant_text:'按已保存原话重新整理。',provider:'SyntheticOrdinaryFixture',trace_id:'synthetic-ordinary-reorg-trace',
    completeness:{clinical_state:{},relevant_context_ids:[],contradictions:[],unknowns:[],evidence_turn_ids:[]}});
  const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
  assert.equal(result.r.ok,true,JSON.stringify(result.j));assert.equal(result.j.reason,'completed');
  assert.equal(llmCalls(h).length,2,'one earlier ordinary reply plus one explicit reorganization');
  assert.equal(llmCalls(h).at(-1).headers['X-NoReset-Text-Trial'],undefined);
  assert.equal(result.j.conversation.manual_correction_analysis_pending,false);
});

test('a missing text-trial mode field fails closed even for an ordinary conversation', async () => {
  const h=await harness(),conversation=await pendingOrdinaryCorrectionCase(h);
  h.responses.set('/api/app/config',{text_trial:null});
  const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
  assert.equal(result.j.dispatched,false);assert.equal(llmCalls(h).length,1,'only the earlier ordinary turn ran');
  assert.equal(result.j.conversation.manual_correction_analysis_pending,true);
});

test('corrected reorganization consumes routine ask analysis without adding an assistant turn or replaying the old trial', async () => {
  const h = await harness(), conversation = await pendingCorrectionCase(h), stop = await h.api.trialVoiceState();
  const payload = await h.context.__testBuildConversationModelPayload(conversation);
  const grant = { grant_id:'synthetic-correction-grant',receipt_id:'synthetic-correction-receipt',receipt_sha256:'e'.repeat(64),
    expires_at:new Date(Date.now()+60_000).toISOString(),http_payload_sha256:hash(JSON.stringify(payload)),remaining_requests:1,kind:'llm',retries:0 };
  h.responses.set('/api/app/config',{text_trial:grant});
  h.responses.set('/api/ai/conversation-turn',{action:'ask',assistant_text:'请问还有其他症状吗？',provider:'SyntheticFixture',trace_id:'synthetic-correction-ask-trace',
    completeness:{clinical_state:{},relevant_context_ids:[],contradictions:[],unknowns:[],evidence_turn_ids:[]}});
  const attempted = await h.request(correctionPath(conversation), await correctionSnapshot(h, conversation));
  assert.equal(attempted.r.ok,true,JSON.stringify(attempted.j));
  assert.equal(attempted.j.reason,'completed');
  assert.equal(attempted.j.conversation.manual_correction_analysis_pending,false);
  assert.equal(attempted.j.conversation.manual_correction_reorganization.operation_kind,'corrected_reorganization');
  assert.equal(attempted.j.conversation.manual_correction_reorganization.trace_id,'synthetic-correction-ask-trace');
  assert.equal(attempted.j.conversation.manual_correction_reorganization.provider,'SyntheticFixture');
  assert.equal(attempted.j.conversation.manual_correction_reorganization.result_provenance,'operation_analysis_only_v1');
  assert.equal(attempted.j.conversation.turns.length,conversation.turns.length,'operation ask text is analysis metadata, never a chat turn');
  assert.equal(attempted.j.conversation.turns.some(turn=>turn.text==='请问还有其他症状吗？'),false);
  assert.equal(attempted.j.conversation.turns.filter(turn=>turn.role==='elder').length,1);
  assert.equal(llmCalls(h).length,1);
  assert.equal(llmCalls(h)[0].headers['X-NoReset-Text-Trial'],grant.grant_id);
  assert.equal((await h.api.vault.list('correction-reorganization-grant:')).length,1);
  assert.deepEqual(await h.api.trialVoiceState(),stop);
  const replay=await h.request(correctionPath(conversation),await correctionSnapshot(h,attempted.j.conversation));
  assert.equal(replay.r.ok,false);assert.equal(llmCalls(h).length,1);
});

test('nonroutine reorganization result remains pending for review and never enters the transcript',async()=>{
  const h=await harness(),conversation=await pendingOrdinaryCorrectionCase(h);
  h.responses.set('/api/app/config',{text_trial:null,text_trial_required:false});
  h.responses.set('/api/ai/conversation-turn',{action:'urgent',assistant_text:'紧急提醒不应被当作普通整理结果。',
    provider:'SyntheticFixture',trace_id:'synthetic-risk-trace',risk_level:'urgent',
    completeness:{clinical_state:{},relevant_context_ids:[],contradictions:[],unknowns:[],evidence_turn_ids:[]}});
  const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
  assert.equal(result.j.reason,'needs_review');
  assert.equal(result.j.conversation.manual_correction_analysis_pending,true);
  assert.equal(result.j.conversation.turns.length,conversation.turns.length);
  assert.equal(result.j.conversation.turns.some(turn=>turn.text==='紧急提醒不应被当作普通整理结果。'),false);
});

test('routine-shaped result carrying an exception remains pending instead of clearing correction state',async()=>{
  const h=await harness(),conversation=await pendingOrdinaryCorrectionCase(h);
  h.responses.set('/api/app/config',{text_trial:null,text_trial_required:false});
  h.responses.set('/api/ai/conversation-turn',{action:'ask',assistant_text:'不应写入。',provider:'SyntheticFixture',trace_id:'synthetic-exception-trace',
    risk_level:'routine',risk_assessment:{level:'none',status:'exception'},
    completeness:{clinical_state:{},relevant_context_ids:[],contradictions:[],unknowns:[],evidence_turn_ids:[]}});
  const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
  assert.equal(result.j.reason,'needs_review');assert.equal(result.j.conversation.manual_correction_analysis_pending,true);
  assert.equal(result.j.conversation.turns.some(turn=>turn.text==='不应写入。'),false);
});

test('ordinary chat turns continue to append their normal assistant response',async()=>{
  const h=await harness(),started=await h.start();
  h.responses.set('/api/app/config',{text_trial:null,text_trial_required:false});
  const sent=await submit(h,started.j.conversation,'普通路径的虚构原话。');
  assert.equal(sent.r.ok,true,JSON.stringify(sent.j));
  assert.ok(sent.j.conversation.turns.some(turn=>turn.role==='elder'&&turn.text==='普通路径的虚构原话。'));
  assert.equal(sent.j.conversation.turns.filter(turn=>turn.role==='assistant').length,started.j.conversation.turns.filter(turn=>turn.role==='assistant').length+1);
  assert.ok(sent.j.conversation.turns.some(turn=>turn.role==='assistant'&&turn.text==='已按您刚才说的保留这段原话。'));
});

test('legacy candidate rejects risk, stale correction snapshots, later edits, and malformed timestamps',async()=>{
  const h=await harness(),fixture=portableLegacyConversation();
  const candidateCheck=conversation=>h.context.__testLegacyReorganizationCandidate(conversation);
  assert.ok(candidateCheck(fixture));
  const targetChanged=structuredClone(fixture);targetChanged.turns[0].text+='后来修改';
  assert.equal(candidateCheck(targetChanged),null);
  const versionChanged=structuredClone(fixture);versionChanged.turns[0].version++;
  assert.equal(candidateCheck(versionChanged),null);
  const danger=structuredClone(fixture);danger.turns[0].local_safety={danger_detected:true};
  assert.equal(candidateCheck(danger),null);
  const reviewed=structuredClone(fixture);reviewed.report.reviewed_risk_assessments=[{level:'urgent'}];
  assert.equal(candidateCheck(reviewed),null);
  const newElder=structuredClone(fixture);newElder.turns.push({turn_id:'later-elder',role:'elder',version:1,text:'后来补充。',created_at:'2026-10-17T10:02:00.000Z'});
  assert.equal(candidateCheck(newElder),null);
  const editedElder=structuredClone(fixture);editedElder.turns[0].edited_at='2026-10-17T10:02:00.000Z';
  assert.equal(candidateCheck(editedElder),null);
  const malformed=structuredClone(fixture);malformed.turns[2].created_at='invalid-date';
  assert.equal(candidateCheck(malformed),null);
  const notAfter=structuredClone(fixture);notAfter.turns[2].created_at='2026-10-17T10:00:00.000Z';
  assert.equal(candidateCheck(notAfter),null);
});

test('portable legacy confirmation changes only active references, preserves facts, and survives reopen',async()=>{
  const h=await harness(),conversation=portableLegacyConversation(),legacy=conversation.turns[2],patientTurns=structuredClone(conversation.turns.filter(turn=>turn.role==='elder'));
  const reportSections=structuredClone(conversation.report.sections),reportSources=structuredClone(conversation.report.source_versions);
  await h.api.vault.put(`conversation:${conversation.conversation_id}`,conversation);
  const archivePath=`/api/conversations/${conversation.conversation_id}`,read=await h.request(archivePath);
  assert.equal(read.r.ok,true,JSON.stringify(read.j));
  assert.equal(read.j.conversation.legacy_reorganization_candidate.turn.turn_id,legacy.turn_id);
  const subject=(await h.request('/api/health-subjects')).j;
  const body={confirmed:true,expected_conversation_version:read.j.conversation.version,expected_subject_id:'subject_self',
    expected_subject_version:subject.version,expected_turn_id:legacy.turn_id,expected_turn_version:legacy.version,expected_turn_text:legacy.text,
    expected_trace_id:'portable-trace',expected_provider:'PortableFixture',expected_scope_id:'a'.repeat(64),expected_body_sha256:'b'.repeat(64)};
  const route=`${archivePath}/legacy-reorganization-output/${legacy.turn_id}/confirm`;
  assert.equal((await h.request(route,{...body,expected_turn_version:legacy.version+1})).r.status,409);
  assert.equal((await h.api.vault.get(`conversation:${conversation.conversation_id}`)).turns[2].superseded,undefined);
  const confirmed=await h.request(route,body);assert.equal(confirmed.r.ok,true,JSON.stringify(confirmed.j));
  const saved=await h.api.vault.get(`conversation:${conversation.conversation_id}`);
  assert.deepEqual(saved.turns.filter(turn=>turn.role==='elder'),patientTurns);
  assert.equal(saved.turns[2].text,legacy.text);assert.equal(saved.turns[2].superseded,true);
  assert.equal(saved.report.transcript.some(turn=>turn.turn_id===legacy.turn_id||turn.text===legacy.text),false);
  assert.deepEqual(saved.report.sections,reportSections);assert.deepEqual(saved.report.source_versions,reportSources);
  assert.equal(saved.report.version,conversation.report.version+1);
  assert.ok(confirmed.j.conversation.legacy_reorganization_history.some(turn=>turn.turn_id===legacy.turn_id&&turn.text===legacy.text));
  assert.equal(h.calls.some(call=>call.path==='/api/ai/conversation-turn'),false);
  const reopened=await h.reopen(),after=await reopened.request(archivePath);
  assert.equal(after.j.conversation.report.transcript.some(turn=>turn.turn_id===legacy.turn_id),false);
  assert.ok(after.j.conversation.legacy_reorganization_history.some(turn=>turn.turn_id===legacy.turn_id&&turn.text===legacy.text));
  const stable=await reopened.request(archivePath);
  assert.deepEqual(stable.j.conversation.report,after.j.conversation.report,'confirmed report projection stays byte-for-byte stable across reads');
  assert.equal((await reopened.api.vault.get(`conversation:${conversation.conversation_id}`)).report.version,confirmed.j.conversation.report.version);
});

test('a previously confirmed v121 report stabilizes after an ordinary pause save', {
  skip: !fs.existsSync(path.join(rootOperatorEvidence,'after-v121-history-saved-inspection.json')),
}, async () => {
  const h=await harness();
  const captured=JSON.parse(fs.readFileSync(path.join(rootOperatorEvidence,'after-v121-history-saved-inspection.json'),'utf8')).conversation;
  assert.equal(captured.manual_correction_reorganization?.legacy_reply_review?.state,'confirmed');
  await installCapturedConversation(h,captured);
  const archivePath=`/api/conversations/${captured.conversation_id}`;
  const projected=await h.request(archivePath);
  assert.equal(projected.r.ok,true,JSON.stringify(projected.j));
  assert.equal(projected.j.conversation.report.version,captured.report.version+1,'read projection detects the stale stored coverage');
  const paused=await h.request(`${archivePath}/pause`,{});
  assert.equal(paused.r.ok,true,JSON.stringify(paused.j));
  const persisted=await h.api.vault.get(`conversation:${captured.conversation_id}`);
  assert.equal(persisted.report.version,captured.report.version+1,'normal save persists one coverage repair');
  const first=await h.request(archivePath),second=await h.request(archivePath);
  assert.deepEqual(second.j.conversation.report,first.j.conversation.report,'repeated reads do not keep incrementing the report');
  assert.equal(first.j.conversation.report.version,persisted.report.version);
});

test('captured legacy reorganization output can only be withdrawn after exact local confirmation and remains historical', {
  skip: !fs.existsSync(path.join(rootOperatorEvidence,'after-saved-inspection.json')),
}, async () => {
  const h=await harness();
  const captured=JSON.parse(fs.readFileSync(path.join(rootOperatorEvidence,'after-saved-inspection.json'),'utf8')).conversation;
  const originalTurns=structuredClone(captured.turns),elderTurns=originalTurns.filter(turn=>turn.role==='elder');
  const report=structuredClone(captured.report),correctionIndex=originalTurns.findIndex(turn=>turn.turn_id===captured.manual_corrections.at(-1).correction_turn_id);
  const legacy=originalTurns.slice(correctionIndex+1).find(turn=>turn.role==='assistant'&&!turn.superseded);
  assert.ok(h.context.__testLegacyReorganizationCandidate(captured),'captured legacy output must satisfy conservative eligibility');
  await installCapturedConversation(h,captured);
  const archivePath=`/api/conversations/${captured.conversation_id}`;
  const read=await h.request(archivePath);
  assert.equal(read.r.ok,true,JSON.stringify(read.j));
  assert.ok(read.j.conversation.turns.some(turn=>turn.turn_id===legacy.turn_id));
  assert.equal(read.j.conversation.legacy_reorganization_candidate.turn.turn_id,legacy.turn_id);
  assert.equal(read.j.conversation.legacy_reorganization_candidate.trace_id,captured.last_ai_metadata.trace_id);
  const subjects=(await h.request('/api/health-subjects')).j;
  const confirmation={confirmed:true,expected_conversation_version:read.j.conversation.version,expected_subject_id:captured.subject_id,
    expected_subject_version:subjects.version,expected_turn_id:legacy.turn_id,expected_turn_version:legacy.version,
    expected_turn_text:legacy.text,expected_trace_id:captured.last_ai_metadata.trace_id,
    expected_provider:captured.last_ai_metadata.provider,expected_scope_id:captured.manual_correction_reorganization.scope_id,
    expected_body_sha256:captured.manual_correction_reorganization.body_sha256};
  const route=`${archivePath}/legacy-reorganization-output/${legacy.turn_id}/confirm`;
  const declined=await h.request(route,{...confirmation,confirmed:false});
  assert.equal(declined.r.status,409);
  assert.deepEqual((await h.api.vault.get(`conversation:${captured.conversation_id}`)).turns,originalTurns);
  const stale=await h.request(route,{...confirmation,expected_turn_text:`${legacy.text} `});
  assert.equal(stale.r.status,409);
  assert.deepEqual((await h.api.vault.get(`conversation:${captured.conversation_id}`)).turns,originalTurns);
  assert.ok(h.context.__testLegacyReorganizationCandidate(await h.api.vault.get(`conversation:${captured.conversation_id}`)),
    'a rejected confirmation must not invalidate the server-side candidate');
  const serverCandidate=h.context.__testLegacyReorganizationCandidate(await h.api.vault.get(`conversation:${captured.conversation_id}`));
  assert.equal(serverCandidate.turn.turn_id,confirmation.expected_turn_id);
  const confirmed=await h.request(route,confirmation);
  assert.equal(confirmed.r.ok,true,JSON.stringify(confirmed.j));
  const saved=await h.api.vault.get(`conversation:${captured.conversation_id}`);
  assert.deepEqual(saved.turns.filter(turn=>turn.role==='elder'),elderTurns);
  assert.equal(saved.turns.find(turn=>turn.turn_id===legacy.turn_id).text,legacy.text);
  assert.equal(saved.turns.find(turn=>turn.turn_id===legacy.turn_id).superseded,true);
  assert.equal(saved.report.transcript.some(turn=>turn.turn_id===legacy.turn_id||turn.text===legacy.text),false);
  assert.deepEqual(saved.report.sections,report.sections);
  assert.deepEqual(saved.report.source_turn_ids,report.source_turn_ids);
  assert.deepEqual(saved.report.source_versions,report.source_versions);
  assert.ok(confirmed.j.conversation.legacy_reorganization_history.some(item=>item.turn_id===legacy.turn_id
    &&item.text===legacy.text&&item.trace_id===captured.last_ai_metadata.trace_id&&item.provider===captured.last_ai_metadata.provider));
  assert.equal(h.calls.some(call=>call.path==='/api/ai/conversation-turn'),false,'historical review never invokes a provider');
  const reopened=await h.reopen(),reloaded=await reopened.request(archivePath);
  assert.equal(reloaded.j.conversation.report.transcript.some(turn=>turn.turn_id===legacy.turn_id||turn.text===legacy.text),false);
  assert.ok(reloaded.j.conversation.legacy_reorganization_history.some(turn=>turn.turn_id===legacy.turn_id&&turn.text===legacy.text));
});

test('corrected reorganization failure preserves pending report and duplicate clicks cannot dispatch twice', async () => {
  const h=await harness(),conversation=await pendingCorrectionCase(h),payload=await h.context.__testBuildConversationModelPayload(conversation);
  const grant={grant_id:'synthetic-correction-fail',receipt_id:'synthetic-correction-fail-receipt',receipt_sha256:'f'.repeat(64),
    expires_at:new Date(Date.now()+60_000).toISOString(),http_payload_sha256:hash(JSON.stringify(payload)),remaining_requests:1,kind:'llm',retries:0};
  h.responses.set('/api/app/config',{text_trial:grant});
  h.responses.set('/api/ai/conversation-turn',async()=>{await new Promise(resolve=>setTimeout(resolve,10));return {__status:422,error:'ai_conversation_failed',failure_code:'model_http_error',provider_http_status:429,failure_reason:'untrusted remote reason',remote_body:'untrusted remote body'}});
  const snapshot=await correctionSnapshot(h,conversation);
  const pair=await Promise.all([h.request(correctionPath(conversation),snapshot),h.request(correctionPath(conversation),snapshot)]);
  assert.equal(llmCalls(h).length,1);
  const read=await h.request(`/api/conversations/${conversation.conversation_id}`);
  assert.equal(read.j.conversation.manual_correction_analysis_pending,true);
  assert.equal(read.j.conversation.report.manual_correction_analysis_pending,true);
  assert.equal(read.j.conversation.manual_correction_reorganization.provider_http_status,429);
  assert.equal(JSON.stringify(read).includes('untrusted remote'),false);
  assert.equal((await h.api.vault.get(`event:${conversation.turns.at(-1).record_id}`)).raw_text,conversation.turns.at(-1).text);
  assert.equal(pair.filter(item=>item.j.dispatched).length,1);
  const ui=appResumeHarness(h);await ui.load();
  assert.match(ui.statuses.map(item=>item.text).join('\n'),/请求较多或受到限制/);
  assert.doesNotMatch(ui.statuses.map(item=>item.text).join('\n'),/429|untrusted remote/);
  const storedKey=`conversation:${conversation.conversation_id}`,stored=await h.api.vault.get(storedKey);
  await h.api.vault.put(storedKey,{...stored,manual_correction_reorganization:{...stored.manual_correction_reorganization,provider_http_status:418}});
  const sanitized=await h.request(`/api/conversations/${conversation.conversation_id}`);
  assert.equal(Object.hasOwn(sanitized.j.conversation.manual_correction_reorganization,'provider_http_status'),false);
});

test('a late reorganization result is discarded if the selected background changes after dispatch', async () => {
  const h=await harness(),conversation=await pendingCorrectionCase(h),payload=await h.context.__testBuildConversationModelPayload(conversation);
  const grant={grant_id:'synthetic-correction-race',receipt_id:'synthetic-correction-race-receipt',receipt_sha256:'9'.repeat(64),
    expires_at:new Date(Date.now()+60_000).toISOString(),http_payload_sha256:hash(JSON.stringify(payload)),remaining_requests:1,kind:'llm',retries:0};
  h.responses.set('/api/app/config',{text_trial:grant});
  h.responses.set('/api/ai/conversation-turn',async()=>{
    const before=await h.api.vault.get('health-context:current');
    await h.api.vault.put('health-context:current',{...(before||{entries:[]}),version:(before?.version||0)+1,updated_at:'synthetic-race'});
    return {action:'reply',assistant_text:'这条晚到结果不应写入。',provider:'SyntheticFixture',completeness:{clinical_state:{},relevant_context_ids:[],contradictions:[]}};
  });
  const result=await h.request(correctionPath(conversation),await correctionSnapshot(h,conversation));
  assert.equal(result.r.status,202);
  assert.equal(llmCalls(h).length,1,'one explicitly authorized request was dispatched');
  const latest=await h.request(`/api/conversations/${conversation.conversation_id}`);
  assert.equal(latest.j.conversation.manual_correction_analysis_pending,true);
  assert.equal(latest.j.conversation.turns.some(turn=>turn.text==='这条晚到结果不应写入。'),false);
});

test('reopening a pending correction does not trigger a model call and keeps its explicit action visible', async () => {
  const h=await harness(),conversation=await pendingCorrectionCase(h),ui=appResumeHarness(h);
  await ui.load();
  assert.equal(llmCalls(h).length,0);
  assert.match(ui.statuses.map(item=>item.text).join('\n'),/报告待重新整理/);
  const html=appSource.slice(appSource.indexOf('function renderVoiceConversation('),appSource.indexOf('function turnById('));
  assert.match(html,/data-correction-reorganize|manual_correction_analysis_pending/);
  assert.equal((await h.api.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation.manual_correction_analysis_pending,true);
});

test('a late successful UI response after subject switch cannot update the page or announce success', async () => {
  const statuses=[],synced=[];let resolvePost;
  const original={conversation_id:'synthetic-ui-conversation',version:4,subject_id:'subject_self',manual_correction_analysis_pending:true};
  const context=vm.createContext({activeConversation:original,activeHealthSubjectId:'subject_self',healthSubjectsVersion:3,healthSubjectUiEpoch:8,
    healthSubjectSwitchBusy:false,healthSubjectChanged:false,saveBusy:false,api:async path=>path==='/api/health-context'
      ?{r:{ok:true},j:{health_context:{version:2}}}:path==='/api/health-subjects'?{r:{ok:true},j:{active_subject_id:'subject_self',version:3}}
      :new Promise(resolve=>{resolvePost=resolve}),setVoiceComposerEnabled(){},setVoiceStatus:(text,tone)=>statuses.push({text,tone}),
    syncConversation:value=>synced.push(value),renderVoiceConversation(){}});
  const from=appSource.indexOf('async function reorganizeCorrectedConversation('),to=appSource.indexOf('async function loadConversation(',from);
  vm.runInContext(appSource.slice(from,to),context);
  const promise=context.reorganizeCorrectedConversation({disabled:false});
  await new Promise(setImmediate);
  context.activeHealthSubjectId='subject_family';context.healthSubjectUiEpoch=9;context.healthSubjectChanged=true;
  resolvePost({r:{ok:true},j:{dispatched:true,reason:'completed',conversation:{...original,version:7,manual_correction_analysis_pending:false}}});
  await promise;
  assert.equal(synced.length,0);
  assert.equal(statuses.some(item=>item.text.includes('已按当前更正原话重新整理')),false);
});

test('successful reorganization refreshes recent records before showing the refreshed summary', async () => {
  const sequence=[],statuses=[];let recentSummary='原话历史：旧摘要';
  const original={conversation_id:'synthetic-home-refresh',version:4,subject_id:'subject_self',manual_correction_analysis_pending:true};
  const updated={...original,version:6,manual_correction_analysis_pending:false,report:{body:'修订后的新摘要'}};
  const context=vm.createContext({activeConversation:original,activeHealthSubjectId:'subject_self',healthSubjectsVersion:3,healthSubjectUiEpoch:8,
    healthSubjectSwitchBusy:false,healthSubjectChanged:false,saveBusy:false,api:async path=>path==='/api/health-context'
      ?{r:{ok:true},j:{health_context:{version:2}}}:path==='/api/health-subjects'?{r:{ok:true},j:{active_subject_id:'subject_self',version:3}}
      :{r:{ok:true},j:{dispatched:true,reason:'completed',conversation:updated}},setVoiceComposerEnabled(){},
    setVoiceStatus:(text,tone)=>statuses.push({text,tone}),
    syncConversation:value=>{context.activeConversation=value;sequence.push('sync')},
    loadEvents:async()=>{sequence.push('loadEvents');recentSummary='已更新摘要';return true},renderVoiceConversation(){}});
  const from=appSource.indexOf('async function reorganizeCorrectedConversation('),to=appSource.indexOf('async function loadConversation(',from);
  vm.runInContext(appSource.slice(from,to),context);
  const result=await context.reorganizeCorrectedConversation({disabled:false});
  assert.equal(result,true);
  assert.deepEqual(sequence.slice(0,2),['sync','loadEvents']);
  assert.equal(recentSummary,'已更新摘要');
  assert.match(statuses.at(-1).text,/已按当前更正原话重新整理/);
});

