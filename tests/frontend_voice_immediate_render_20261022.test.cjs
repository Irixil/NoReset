const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const mediaSource = fs.readFileSync(path.join(__dirname, '../frontend/media.js'), 'utf8');

test('archive audio bubbles omit routine provenance captions while retaining transcript and source fields', () => {
  const turn = { turn_id: 'audio_1', role: 'elder', source_kind: 'audio_transcript', text: '合成原话：手腕不舒服。', media_id: 'media_1', record_id: 'record_1', audio_source_status: 'machine_transcribed' };
  const context = vm.createContext({ activeConversation: { turns: [turn] }, unavailableConversationOriginalIds: new Set(), isMockContent: () => false, escapeHtml: String,
    voiceAudioMessageHtml: (item, source, options) => `<article>${item.text}<small>${source}</small>${JSON.stringify(options)}</article>`,
    assistantFailureCopy: () => '', conversationTurnTime: () => '', mockWarning: '' });
  const start = appSource.indexOf('function conversationTranscriptTurnHtml('), end = appSource.indexOf('\nfunction legacyReorganizationOutputCandidate(', start);
  vm.runInContext(appSource.slice(start, end), context);
  const html = vm.runInContext('conversationTranscriptTurnHtml(activeConversation.turns[0])', context);
  assert.match(html, /合成原话：手腕不舒服/);
  assert.doesNotMatch(html, /语音识别文字 · 尚未人工核对|历史录音文字 · 状态待确认/);
  assert.equal(turn.audio_source_status, 'machine_transcribed');
  assert.equal(turn.media_id, 'media_1');
  context.unavailableConversationOriginalIds.add(turn.media_id);
  const missing = vm.runInContext('conversationTranscriptTurnHtml(activeConversation.turns[0])', context);
  assert.doesNotMatch(missing, /data-turn-play|voice-audio-bubble/);
  assert.match(missing, /没有找到这段录音原件/);
});

test('finishing a recording immediately renders a pending audio bubble before upload or recognition', () => {
  const elements = new Map(), recorder = { state: 'recording', mimeType: 'audio/wav', addEventListener() {} };
  const get = id => { if (!elements.has(id)) elements.set(id, { disabled: false, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  const context = vm.createContext({ mediaRecorder: recorder, chunks: [], elapsedMs: 1700, startedAt: 1000,
    Date: class extends Date { static now() { return 1000; } }, voiceUploadPending: false, voicePermissionPending: false,
    pendingRecordingIntent: null, voiceCaptureIntent: { conversationId: 'conversation_1' }, pendingConversationTurn: null,
    Blob, $: get, updateTimer() {}, stopVoice() { return true; }, setRecording() {}, renderVoiceConversation() { context.renders++; }, renders: 0,
    savePendingRecording() {}, mediaMessage() {}, setVoiceStatus() {} });
  const start = mediaSource.indexOf("$('finishVoiceBtn').onclick="), end = mediaSource.indexOf("$('retryVoiceUploadBtn').onclick=savePendingRecording", start);
  vm.runInContext(mediaSource.slice(start, end), context);
  get('finishVoiceBtn').onclick();
  assert.equal(context.renders, 1);
  assert.equal(context.pendingConversationTurn.audio_processing, true);
  assert.equal(context.pendingConversationTurn.source_kind, 'audio_transcript');
  const display = vm.createContext({ activeConversation: { turns: [] }, turn: context.pendingConversationTurn, conversationEditingTurnId: null,
    saveBusy: false, isMockContent: () => false, canShowSavedTextFirstSend: () => false, escapeHtml: String,
    audioDurationLabel: seconds => seconds ? `${seconds}″` : '' });
  const audioStart = appSource.indexOf('function voiceTurnHtml('), audioEnd = appSource.indexOf('\nlet voiceTurnMenuFocus=', audioStart);
  vm.runInContext(appSource.slice(audioStart, audioEnd), display);
  const pendingHtml = vm.runInContext('voiceTurnHtml(turn)', display);
  assert.match(pendingHtml, /voice-audio-bubble[^>]*disabled/);
  assert.match(pendingHtml, /正在保存录音/);
});

test('pending audio duration includes live recording time before the timer interval updates', () => {
  const elements = new Map(), recorder = { state: 'recording', mimeType: 'audio/wav', addEventListener() {} };
  const get = id => { if (!elements.has(id)) elements.set(id, { disabled: false, classList: { add() {}, remove() {}, toggle() {} } }); return elements.get(id); };
  const context = vm.createContext({ mediaRecorder: recorder, chunks: [], elapsedMs: 0, startedAt: 10000,
    Date: class extends Date { static now() { return 13500; } }, voiceUploadPending: false, voicePermissionPending: false,
    pendingRecordingIntent: null, voiceCaptureIntent: { conversationId: 'conversation_1' }, pendingConversationTurn: null,
    Blob, $: get, updateTimer() {}, stopVoice() { return true; }, setRecording() {}, renderVoiceConversation() {},
    savePendingRecording() {}, mediaMessage() {}, setVoiceStatus() {} });
  const start = mediaSource.indexOf("$('finishVoiceBtn').onclick="), end = mediaSource.indexOf("$('retryVoiceUploadBtn').onclick=savePendingRecording", start);
  vm.runInContext(mediaSource.slice(start, end), context);
  get('finishVoiceBtn').onclick();
  assert.equal(context.elapsedMs, 0);
  assert.equal(context.pendingConversationTurn.audio_duration_seconds, 4);
});

test('a successful transcript is rendered before the conversation request starts', async () => {
  const order = []; let transcriptWasVisible = false;
  const context = vm.createContext({ activeConversation: { conversation_id: 'conversation_1' }, isMockContent: () => false, mockText: () => false,
    voiceRecordingIntentIsCurrent: () => true, setVoiceStatus() {}, prepareMediaRetry() {}, renderVoiceConversation() { order.push('render'); },
    pendingConversationTurn: null, submitConversationText: async () => { order.push('submit'); transcriptWasVisible = Boolean(context.pendingConversationTurn?.text); return true; },
    document: { querySelector: () => ({ id: 'voiceView' }) } });
  const start = appSource.indexOf('async function showVoiceMediaResult('), end = appSource.indexOf('\nfunction prepareMediaRetry(', start);
  vm.runInContext(appSource.slice(start, end), context);
  await context.showVoiceMediaResult({ kind: 'audio', recognition_status: 'succeeded', recognition: { text: '合成转写原话。' }, temporary: true,
    conversation_id: 'conversation_1', media_id: 'media_1', record_id: 'record_1' }, { newRecording: true, durationSeconds: 2, captureIntent: {} });
  assert.ok(order.indexOf('render') >= 0 && order.indexOf('render') < order.indexOf('submit'));
  assert.equal(transcriptWasVisible, true);
  const box = { innerHTML: '', insertAdjacentHTML(position, html) { assert.equal(position,'beforeend');this.innerHTML+=html; }, querySelectorAll: () => [], querySelector: () => null }, scroller = { scrollHeight: 0, scrollTop: 0, clientHeight: 500, scrollTo() {} };
  const renderContext = vm.createContext({ activeConversation: { turns: [] }, pendingConversationTurn: context.pendingConversationTurn, pendingAudioReviewCandidates: [],
    pendingAudioReview: null, pendingCorrectionReview: null, pendingLegacyReorganizationReview: null, pendingFollowupTarget: null, saveBusy: true,
    conversationEditingTurnId: null, $: id => id === 'voiceConversationTurns' ? box : id === 'voiceConversation' ? scroller : null,
    releaseOriginalsIn() {}, cancelVoiceTurnPress() {}, closeVoiceTurnMenu() {}, bindVoiceTurnMenus() {}, bindConversationSourceActions() {},
    voiceTurnHtml: turn => `<div>${turn.text}</div>`, legacyAudioNeedsExplicitRecovery: () => false, bindPendingAudioPlayback() {},
    document: { querySelector: () => null }, window: { requestAnimationFrame: callback => callback() }, reducedMotion: () => true, setTimeout, escapeHtml: String });
  const renderStart = appSource.indexOf('function renderVoiceConversation('), renderEnd = appSource.indexOf('\nasync function retryPendingAudioReply(', renderStart);
  vm.runInContext(appSource.slice(renderStart, renderEnd), renderContext);
  renderContext.renderVoiceConversation();
  assert.match(box.innerHTML, /小零正在生成回复/);
});

test('saving the audio original advances the pending bubble to transcription without losing its duration', () => {
  const pending = { turn_id: 'pending-audio', source_kind: 'audio_transcript', text: '正在保存录音…', audio_duration_seconds: 7,
    pending: true, audio_processing: true, pending_audio_stage: 'saving' }, calls = [];
  const context = vm.createContext({ pendingConversationTurn: pending, renderVoiceConversation() { calls.push('render'); }, setVoiceStatus() {} });
  const start = appSource.indexOf('function showVoiceMediaSaved('), end = appSource.indexOf('\nfunction audioReviewAlreadyInConversation(', start);
  vm.runInContext(appSource.slice(start, end), context);
  context.showVoiceMediaSaved({ media_id: 'media_saved' });
  assert.equal(context.pendingConversationTurn.pending_audio_stage, 'transcribing');
  assert.equal(context.pendingConversationTurn.text, '正在转成文字…');
  assert.equal(context.pendingConversationTurn.media_id, 'media_saved');
  assert.equal(context.pendingConversationTurn.audio_duration_seconds, 7);
  assert.deepEqual(calls, ['render']);
});

test('the assistant reply is painted before speech begins, without another user input', () => {
  const frames = [], order = [], conversation = { conversation_id: 'conversation_1', subject_id: 'subject_self', turns: [{ turn_id: 'assistant_1', role: 'assistant', text: '合成回复。' }] };
  const context = vm.createContext({ activeConversation: null, pendingCorrectionReview: null, pendingMediaRetry: null, pendingFollowupTarget: null, lastSpokenTurnId: null,
    activeHealthSubjectId: 'subject_self', document: { querySelector: () => null }, renderVoiceConversation() { order.push('paint'); }, renderConversationReport() {},
    updateHealthContextButton() {}, setVoiceComposerEnabled() {}, updateHealthSubjectLabels() {}, isMockContent: () => false,
    speakAssistant() { order.push('speak'); }, window: { requestAnimationFrame: callback => frames.push(callback) }, setTimeout });
  const start = appSource.indexOf('function syncConversation('), end = appSource.indexOf('\nfunction conversationHasPendingReply(', start);
  vm.runInContext(appSource.slice(start, end), context);
  context.syncConversation(conversation);
  assert.deepEqual(order, ['paint']);
  while (frames.length) frames.shift()();
  assert.deepEqual(order, ['paint', 'speak']);
});

test('historical original lookup distinguishes confirmed missing, access denial and temporary failure', async () => {
  for (const [status, expected] of [[404, /没有找到这段录音原件/], [403, /无法读取或访问这段录音/], [503, /原录音暂时无法读取/]]) {
    const box = { isConnected: true, textContent: '', closest: () => null }, calls = [];
    const context = vm.createContext({ isMockContent: () => false, activeHealthSubjectId: 'subject_self', unavailableConversationOriginalIds: new Set(),
      globalThis: { HealthSafety: { currentAudioSource: () => null } },
      api: async route => { calls.push(route); return route.startsWith('/api/media/') ? { r: { ok: false, status }, j: {} } : { r: { ok: true }, j: { events: [] } }; },
      openOriginal: async () => { throw new Error('must not open without the media descriptor'); } });
    const start = appSource.indexOf('async function showConversationOriginal('), end = appSource.indexOf('\nasync function playPendingAudioOriginal(', start);
    vm.runInContext(appSource.slice(start, end), context);
    const turn = { source_kind: 'audio_transcript', media_id: 'media_missing', record_id: 'record_1', text: '合成原话。' };
    assert.equal(await context.showConversationOriginal(turn, box, { conversation_id: 'conversation_1' }), false);
    assert.match(box.textContent, expected);
    assert.equal(calls.length, 2);
  }
});

test('a confirmed missing historical original removes its playback button but keeps the transcript', async () => {
  const turn = { turn_id: 'turn_1', role: 'elder', source_kind: 'audio_transcript', text: '合成原话。', media_id: 'media_missing' };
  const button = { dataset: { turnOriginal: turn.turn_id }, disabled: false, hidden: false, setAttribute() {}, closest: () => ({ querySelector: () => ({ textContent: '没有找到这段录音原件' }) }) };
  const context = vm.createContext({ unavailableConversationOriginalIds: new Set(['media_missing']), showConversationOriginal: async () => false,
    setVoiceStatus() {}, document: { querySelector() {} } });
  const start = appSource.indexOf('function bindConversationSourceActions('), end = appSource.indexOf('\nfunction canShowSavedTextFirstSend(', start);
  vm.runInContext(appSource.slice(start, end), context);
  context.bindConversationSourceActions({ querySelectorAll: selector => selector === '[data-turn-play]' ? [button] : [] }, { conversation_id: 'conversation_1', turns: [turn] });
  await button.onclick();
  assert.equal(button.hidden, true);
  assert.equal(turn.text, '合成原话。');
});

test('a missing original binary is reported as missing and never attached as an audio player', async () => {
  const mediaId = 'media_missing_binary', box = { isConnected: true, textContent: '', replaceChildren() {} }, targets = new Map();
  const context = vm.createContext({ globalThis: { HealthLocal: { active: true, originalObjectUrl: async () => { throw new Error('原件不存在'); } } },
    originalTargets: targets, originalUrls: new Map(), unavailableConversationOriginalIds: new Set(),
    releaseOriginalsIn() {}, releaseOriginal(id) { targets.delete(id); }, URL: { revokeObjectURL() {} }, mediaMessage() {} });
  const start = mediaSource.indexOf('async function openOriginal('), end = mediaSource.indexOf('\nasync function showDocumentOriginals(', start);
  vm.runInContext(mediaSource.slice(start, end), context);
  assert.equal(await context.openOriginal(mediaId, { box, media: { media_id: mediaId, kind: 'audio' } }), false);
  assert.match(box.textContent, /没有找到这段录音原件/);
  assert.equal(context.unavailableConversationOriginalIds.has(mediaId), true);
  assert.equal(targets.has(mediaId), false);
});

test('conversation rerenders do not drag a reader back down after they scroll upward', () => {
  const scroller = { scrollHeight: 1200, scrollTop: 0, clientHeight: 500, scrollTo() { this.calls = (this.calls || 0) + 1; } };
  const box = { innerHTML: '', insertAdjacentHTML(position, html) { assert.equal(position,'beforeend');this.innerHTML+=html; }, querySelectorAll: () => [], querySelector: () => null };
  const context = vm.createContext({ activeConversation: { turns: [] }, pendingConversationTurn: null, pendingAudioReviewCandidates: [], pendingAudioReview: null,
    pendingCorrectionReview: null, pendingLegacyReorganizationReview: null, pendingFollowupTarget: null, saveBusy: false, conversationEditingTurnId: null,
    $: id => id === 'voiceConversationTurns' ? box : id === 'voiceConversation' ? scroller : null, releaseOriginalsIn() {}, bindVoiceTurnMenus() {},
    legacyAudioNeedsExplicitRecovery: () => false, bindConversationSourceActions() {}, voiceTurnHtml: () => '', bindPendingAudioPlayback() {},
    cancelVoiceTurnPress() {}, closeVoiceTurnMenu() {}, bindVoiceTurnMenus() {},
    document: { querySelector: () => null }, window: { requestAnimationFrame: callback => callback() }, reducedMotion: () => true, setTimeout });
  const start = appSource.indexOf('function renderVoiceConversation('), end = appSource.indexOf('\nasync function retryPendingAudioReply(', start);
  vm.runInContext(appSource.slice(start, end), context);
  context.renderVoiceConversation();
  assert.equal(scroller.calls || 0, 0);
  scroller.scrollTop = 650;
  context.renderVoiceConversation();
  assert.equal(scroller.calls, 1);
});
