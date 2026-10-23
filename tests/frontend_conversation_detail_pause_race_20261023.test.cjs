const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
const response = (conversation, status = 200) => ({ r: { ok: status < 400, status }, j: conversation ? { conversation } : {} });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ pauseStatus: initialPauseStatus = 200 } = {}) {
  const trace = [], toasts = [], rendered = [];
  const pauseGate = deferred();
  let version = 18, pauseStatus = initialPauseStatus;
  const detail = { classList: { add() {}, remove() {} }, innerHTML: '' };
  const nodes = new Map([['detail', detail]]);
  const element = id => nodes.get(id) || (nodes.set(id, { classList: { add() {}, remove() {} }, innerHTML: '', textContent: '' }), nodes.get(id));
  const views = ['voiceView', 'recordDetailView', 'homeView'].map(id => {
    const view = { id, active: id === 'voiceView', setAttribute() {}, querySelector() { return null; } };
    view.classList = { toggle(name, active) { if (name === 'active') view.active = active; } };
    return view;
  });
  const context = vm.createContext({
    views, activeConversation: { conversation_id: 'conversation_synthetic', version: 18, subject_id: 'subject_self' },
    currentConversationDetail: null, current: null, detailRequestSerial: 0, conversationLoadSequence: 0,
    pendingConversationDetailOpen: null, conversationDetailOpenSequence: 0, viewNavigationSerial: 0,
    activeHealthSubjectId: 'subject_self', healthSubjectsVersion: 2, healthSubjectUiEpoch: 3,
    healthSubjectChanged: false, healthSubjectSwitchBusy: false, healthSubjectLoaded: true,
    mediaRecorder: null, voicePermissionPending: false, voiceUploadPending: false,
    voiceCaptureIntent: null, localMode: true,
    document: {
      getElementById: element,
      querySelector(selector) {
        if (selector === '.view.active') return views.find(view => view.active) || null;
        if (selector === '.app-shell') return { classList: { toggle() {} } };
        return null;
      },
      querySelectorAll() { return []; },
    },
    window: { scrollTo() {} },
    $: element,
    api: async (path, options = {}) => {
      if (path.endsWith('/pause')) {
        trace.push('pause:start');
        await pauseGate.promise;
        if (pauseStatus !== 200) return response(null, pauseStatus);
        version = 19;
        trace.push('pause:done');
        return response({ conversation_id: 'conversation_synthetic', version, subject_id: 'subject_self' });
      }
      trace.push(`detail:get:v${version}`);
      return response({ conversation_id: 'conversation_synthetic', version, subject_id: 'subject_self' });
    },
    toast: message => toasts.push(message), reveal() {}, reducedMotion: () => true,
    clearRecordPanels() { context.detailRequestSerial++; context.currentConversationDetail = null; context.current = null; },
    cancelVoiceTurnPress() {}, closeVoiceTurnMenu() {}, releaseOriginalsIn() {},
    loadEvents() {}, renderHome() {}, refreshStorageStatus() {}, loadHealthMemory() {},
    loadConversation() {}, refreshVoiceOnlineStatus() {},
    renderConversationDetail(conversation) { rendered.push(conversation.version); context.currentConversationDetail = conversation; },
  });
  const run = expression => vm.runInContext(expression, context);
  const showStart = source.indexOf('function showView('), showEnd = source.indexOf('\n}\n', showStart) + 2;
  const pauseStart = source.indexOf('async function pauseConversation('), pauseEnd = source.indexOf('async function submitConversationText(', pauseStart);
  const detailStart = source.indexOf('async function showConversationDetail('), detailEnd = source.indexOf('async function showDetail(', detailStart);
  assert.ok(showStart >= 0 && showEnd > showStart && pauseStart >= 0 && pauseEnd > pauseStart && detailStart >= 0 && detailEnd > detailStart);
  run(source.slice(showStart, showEnd) + '\n' + source.slice(pauseStart, pauseEnd) + '\n' + source.slice(detailStart, detailEnd));
  return { context, run, trace, toasts, rendered, pauseGate, views, setPauseStatus(status) { pauseStatus = status; } };
}

test('opening current chat details waits for pause save and reads the committed version', async () => {
  const h = harness();
  const opening = h.run('showConversationDetail("conversation_synthetic")');
  await new Promise(setImmediate);
  assert.deepEqual(h.trace, ['pause:start'], 'detail GET must not race ahead of the exit save');
  h.pauseGate.resolve();
  assert.equal(await opening, true);
  assert.deepEqual(h.trace, ['pause:start', 'pause:done', 'detail:get:v19']);
  assert.deepEqual(h.rendered, [19]);
  assert.equal(h.context.currentConversationDetail.version, 19);
});

test('a failed pause keeps the chat open and does not read or render stale details', async () => {
  const h = harness();h.setPauseStatus(503);
  const opening = h.run('showConversationDetail("conversation_synthetic")');
  await new Promise(setImmediate);h.pauseGate.resolve();
  assert.equal(await opening, false);
  assert.deepEqual(h.trace, ['pause:start']);
  assert.equal(h.context.activeConversation.version, 18, 'a failed pause must not make the chat appear saved at a newer version');
  assert.equal(h.views.find(view => view.active).id, 'voiceView');
  assert.deepEqual(h.rendered, []);
  assert.match(h.toasts.join('\n'), /退出时未能确认保存结果/);
});

test('leaving the chat while its save is pending cancels the detail read', async () => {
  const h = harness();
  const opening = h.run('showConversationDetail("conversation_synthetic")');
  await new Promise(setImmediate);
  h.run('showView("homeView")');
  h.pauseGate.resolve();
  assert.equal(await opening, false);
  assert.deepEqual(h.trace, ['pause:start', 'pause:done'], 'cancellation must not issue a second pause or a detail GET');
  assert.equal(h.views.find(view => view.active).id, 'homeView');
});

test('an owner change during pause prevents rendering another owner’s details', async () => {
  const h = harness();
  const opening = h.run('showConversationDetail("conversation_synthetic")');
  await new Promise(setImmediate);
  h.context.activeHealthSubjectId = 'subject_fictional_family';
  h.context.healthSubjectUiEpoch++;
  h.pauseGate.resolve();
  assert.equal(await opening, false);
  assert.deepEqual(h.trace, ['pause:start', 'pause:done']);
  assert.deepEqual(h.rendered, []);
});

test('a changed owner is rejected before leaving-save or detail read begins', async () => {
  const h = harness();
  h.context.healthSubjectChanged = true;
  assert.equal(await h.run('showConversationDetail("conversation_synthetic")'), false);
  assert.deepEqual(h.trace, []);
  assert.match(h.toasts.join('\n'), /所属人状态已变化/);
});

test('recording, permission wait and original upload block detail navigation before pause side effects', async t => {
  for (const busy of ['recording', 'permission', 'upload']) {
    await t.test(busy, async () => {
      const h = harness(), intent = { invalidated: false };
      h.context.voiceCaptureIntent = intent;
      if (busy === 'recording') h.context.mediaRecorder = { state: 'recording' };
      if (busy === 'permission') h.context.voicePermissionPending = true;
      if (busy === 'upload') h.context.voiceUploadPending = true;
      assert.equal(await h.run('showConversationDetail("conversation_synthetic")'), false);
      assert.deepEqual(h.trace, []);
      assert.equal(intent.invalidated, false);
      assert.equal(h.views.find(view => view.active).id, 'voiceView');
      assert.match(h.toasts.join('\n'), busy === 'permission' ? /等待麦克风权限/ : /正在录音或保留原件/);
    });
  }
});

test('repeated detail clicks share one pause and one current-version read', async () => {
  const h = harness();
  const first = h.run('showConversationDetail("conversation_synthetic")');
  const second = h.run('showConversationDetail("conversation_synthetic")');
  await new Promise(setImmediate);
  assert.deepEqual(h.trace, ['pause:start']);
  h.pauseGate.resolve();
  assert.equal(await first, true);
  assert.deepEqual(h.trace, ['pause:start', 'pause:done', 'detail:get:v19']);
  assert.deepEqual(h.rendered, [19]);
});
