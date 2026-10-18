// Controlled state-machine regression, not proof of a real microphone or ASR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness() {
  let now = 0, nextTimer = 1, permissionCalls = 0, resolvePermission, rejectPermission;
  const timers = new Map(), elements = new Map(), recorders = [], tracks = [], windowListeners = {};
  let fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, session_token: 'test', provider: 'mock', events: [] }) });
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        textContent: '', value: '', disabled: false, innerHTML: '', dataset: {},
        classList: {
          toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
          add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
          contains(name) { return classes.has(name); },
        },
        querySelector() { return element(id + ':span'); }, querySelectorAll() { return []; },
        addEventListener() {}, scrollIntoView() {},
      });
    }
    return elements.get(id);
  }
  const permission = new Promise((resolve, reject) => { resolvePermission = resolve; rejectPermission = reject; });
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; this.pauses = 0; this.resumes = 0; this.stops = 0; recorders.push(this); }
    start() { this.state = 'recording'; }
    pause() { assert.equal(this.state, 'recording'); this.state = 'paused'; this.pauses++; }
    resume() { assert.equal(this.state, 'paused'); this.state = 'recording'; this.resumes++; }
    stop() { assert.notEqual(this.state, 'inactive'); this.state = 'inactive'; this.stops++; this.onstop?.(); }
    emit(text) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
  }
  const context = vm.createContext({
    console, Blob, FormData, URL, MediaRecorder: Recorder,
    location: { hostname: 'localhost', port: '5173' },
    navigator: { mediaDevices: { getUserMedia() { permissionCalls++; return permission; } } },
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [] },
    window: { scrollTo() {}, addEventListener(name, listener) { windowListeners[name] = listener; } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (...args) => fetchImpl(...args),
    Date: class extends Date { static now() { return now; } },
    setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8'), context);
  return {
    element, recorders, timers, context,
    click(id) { return element(id).onclick(); },
    run(code) { return vm.runInContext(code, context); },
    setFetch(handler) { fetchImpl = handler; },
    async dispatchWindow(name) { return windowListeners[name]?.(); },
    advance(ms) { now += ms; for (const timer of [...timers.values()]) if (timer.interval) timer.fn(); },
    allow() { const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track); resolvePermission({ getTracks: () => [track] }); },
    deny() { rejectPermission(new Error('NotAllowedError')); },
    get permissionCalls() { return permissionCalls; },
    get tracks() { return tracks; },
  };
}

function deferredTrial(h) {
  let resolve, reject, calls = 0;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  h.context.HealthLocal = { trialVoiceState() { calls++; return pending; } };
  return { resolve, reject, get calls() { return calls; } };
}

test('deferred local trial preflight immediately locks start and navigation without asking for microphone', async () => {
  const h = harness(), trial = deferredTrial(h);
  const starting = h.click('recordBtn');
  const duplicate = h.click('recordBtn');
  assert.equal(trial.calls, 1);
  assert.equal(h.run('voicePermissionPending'), true);
  assert.equal(h.element('recordBtn').disabled, true);
  assert.equal(h.element('finishVoiceBtn').disabled, true);
  assert.equal(h.run("showView('recordsView')"), false);
  assert.equal(h.permissionCalls, 0);
  h.advance(15000);
  assert.equal(h.element('voiceTimer').textContent, '00:00');
  trial.resolve(null);
  await duplicate;
  h.deny(); await starting;
  assert.equal(h.permissionCalls, 1);
  assert.equal(h.run('voicePermissionPending'), false);
});

test('cancel during deferred trial preflight rejects its late result before opening microphone', async () => {
  const h = harness(), trial = deferredTrial(h), starting = h.click('recordBtn');
  h.run('stopVoice("已取消准备录音")');
  // Also release the synthetic permission so the unfixed path cannot hang.
  h.allow(); trial.resolve(null); await starting;
  assert.equal(h.permissionCalls, 0);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.run('voicePermissionPending'), false);
  assert.equal(h.element('recordBtn').disabled, false);
  assert.equal(h.element('finishVoiceBtn').disabled, true);
});

test('conversation changing during deferred preflight cannot start microphone for the new source', async () => {
  const h = harness();
  h.run("activeConversation={conversation_id:'synthetic_before'}");
  const trial = deferredTrial(h), starting = h.click('recordBtn');
  h.run("activeConversation={conversation_id:'synthetic_after'}");
  h.allow(); trial.resolve(null); await starting;
  assert.equal(h.permissionCalls, 0);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.run('voicePermissionPending'), false);
});

test('rejected local trial preflight releases the UI without microphone or timer', async () => {
  const h = harness(), trial = deferredTrial(h), starting = h.click('recordBtn');
  trial.reject(new Error('synthetic-vault-read-failed'));
  await assert.doesNotReject(starting);
  assert.equal(h.permissionCalls, 0);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.run('voicePermissionPending'), false);
  assert.equal(h.element('recordBtn').disabled, false);
  assert.equal(h.element('finishVoiceBtn').disabled, true);
  assert.equal(h.timers.size, 0);
  assert.match(h.element('voiceHint').textContent, /未能开启|未能准备|无法确认/);
});

test('review-required or stopped preflight releases controls while keeping microphone closed', async () => {
  for (const state of ['review_required', 'stopped']) {
    const h = harness(), trial = deferredTrial(h), starting = h.click('recordBtn');
    trial.resolve({ state }); await starting;
    assert.equal(h.permissionCalls, 0);
    assert.equal(h.recorders.length, 0);
    assert.equal(h.run('voicePermissionPending'), false);
    assert.equal(h.element('recordBtn').disabled, false);
    assert.equal(h.element('finishVoiceBtn').disabled, true);
  }
});

test('cancel closes granted microphone immediately while the second local trial read is deferred', async () => {
  const h = harness();
  let reads = 0, resolveSecond;
  h.context.HealthLocal = { trialVoiceState() {
    reads++;
    return reads === 1 ? Promise.resolve(null) : new Promise(resolve => { resolveSecond = resolve; });
  } };
  const starting = h.click('recordBtn');
  h.allow();
  for (let i = 0; i < 20 && !resolveSecond; i++) await new Promise(setImmediate);
  assert.equal(typeof resolveSecond, 'function');
  assert.equal(h.tracks[0].stopped, false);
  h.run('stopVoice("已取消")');
  assert.equal(h.tracks[0].stopped, true, 'cancel must close the stream before the deferred read settles');
  assert.equal(h.recorders.length, 0);
  resolveSecond(null); await starting;
  assert.equal(h.recorders.length, 0);
  assert.equal(h.run('voicePermissionPending'), false);
});

test('cancel before permission arrives closes its stream without another local state read', async () => {
  const h = harness(); let reads = 0;
  h.context.HealthLocal = { trialVoiceState: async () => { reads++; return null; } };
  const starting = h.click('recordBtn');
  for (let i = 0; i < 20 && !h.permissionCalls; i++) await new Promise(setImmediate);
  assert.equal(h.permissionCalls, 1);
  h.run('stopVoice("已取消")'); h.allow(); await starting;
  assert.equal(reads, 1, 'a canceled permission response must not wait for a second local read');
  assert.equal(h.tracks[0].stopped, true);
  assert.equal(h.recorders.length, 0);
});

test('rejected second local state read closes its granted microphone and releases controls', async () => {
  const h = harness(); let reads = 0;
  h.context.HealthLocal = { trialVoiceState() {
    return ++reads === 1 ? Promise.resolve(null) : Promise.reject(new Error('synthetic-second-read-failed'));
  } };
  const starting = h.click('recordBtn'); h.allow(); await assert.doesNotReject(starting);
  assert.equal(h.tracks[0].stopped, true);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.run('voicePermissionPending'), false);
  assert.equal(h.element('recordBtn').disabled, false);
});

test('permission pending prevents duplicate start and timer; denial never pretends to record', async () => {
  const h = harness();
  const start = h.click('recordBtn');
  assert.equal(h.element('recordBtn').disabled, true);
  assert.equal(h.element('finishVoiceBtn').disabled, true);
  await h.click('recordBtn');
  h.advance(15000);
  assert.equal(h.permissionCalls, 1);
  assert.equal(h.element('voiceTimer').textContent, '00:00');
  h.deny(); await start;
  assert.equal(h.element('recordBtn').disabled, false);
  assert.equal(h.element('finishVoiceBtn').disabled, true);
  assert.match(h.element('voiceHint').textContent, /未能开启/);
  assert.equal(h.run('mediaRecorder'), null);
  assert.equal(h.timers.size, 0);
});

test('missing MediaRecorder is reported before asking for microphone permission', async () => {
  const h = harness();
  h.run('globalThis.MediaRecorder=undefined');
  await h.click('recordBtn');
  assert.equal(h.permissionCalls, 0);
  assert.match(h.element('voiceHint').textContent, /暂不支持直接录音/);
  assert.match(h.element('voiceConversationStatus').textContent, /直接输入文字/);
});

test('starting another situation preserves unsent text and blocks while recording', async () => {
  const h = harness();
  let requests = 0;
  h.setFetch(async () => { requests++; return { ok: false, json: async () => ({}) }; });
  h.element('voiceTextInput').value = '这句话还没有发送';
  assert.equal(await h.click('startSeparateConversationBtn'), false);
  assert.equal(h.element('voiceTextInput').value, '这句话还没有发送');
  h.element('voiceTextInput').value = '';
  h.run("mediaRecorder={state:'recording'}");
  assert.equal(await h.click('startSeparateConversationBtn'), false);
  assert.equal(requests, 0);
});

test('an insecure page explains why the browser does not expose its microphone', async () => {
  const h = harness();
  h.run("globalThis.navigator.mediaDevices.getUserMedia=undefined;globalThis.location.hostname='192.168.1.8';globalThis.location.protocol='http:'");
  await h.click('recordBtn');
  assert.equal(h.permissionCalls, 0);
  assert.match(h.element('voiceHint').textContent, /不是安全连接/);
});

test('navigation is blocked while microphone permission is still pending', async () => {
  const h = harness();
  const starting = h.click('recordBtn');
  assert.equal(h.run("showView('recordsView')"), false);
  assert.equal(h.run('voicePermissionPending'), true);
  h.deny(); await starting;
  assert.equal(h.run('voicePermissionPending'), false);
});

test('a second microphone tap ends the current utterance instead of opening a save step', async () => {
  const h = harness();
  const start = h.click('recordBtn');
  h.advance(9000); h.allow(); await start;
  assert.equal(h.element('voiceTimer').textContent, '00:00');
  const recorder = h.recorders[0]; recorder.emit('before pause');
  assert.equal(h.tracks[0].stopped, false, 'a recorder which took ownership must stay open after start returns');
  h.advance(4500);
  h.element('finishVoiceBtn').onclick = () => h.run("stopVoice('test finish')");
  await h.click('recordBtn');
  assert.equal(recorder.state, 'inactive');
  assert.equal(recorder.stops, 1);
  assert.equal(h.element('voiceTimer').textContent, '00:04');
  assert.equal(h.recorders.length, 1);
  assert.equal(await new Blob(h.run('chunks')).text(), 'before pause');
  assert.equal(h.tracks[0].stopped, true);
  assert.equal(h.element('finishVoiceBtn').disabled, true);
});

test('recording safely falls back to a manual end when Web Audio silence detection is unavailable', async () => {
  const h = harness(); const start = h.click('recordBtn'); h.allow(); await start;
  h.advance(12000);
  const silence = [...h.timers.values()].find(timer => !timer.interval && timer.ms === 12000);
  assert.equal(silence, undefined);
  assert.equal(h.recorders[0].state, 'recording');
  assert.equal(h.element('voiceTimer').textContent, '00:12');
  h.advance(7000);
  assert.equal(h.element('voiceTimer').textContent, '00:19');
  assert.equal(h.element('finishVoiceBtn').disabled, false);
});

test('a returned network refreshes the API address without reloading the page', async () => {
  const h = harness();
  h.setFetch(async url => String(url).startsWith('/runtime-config.js')
    ? { ok: true, text: async () => 'globalThis.__BINGLI_CONFIG__ = {"apiBaseUrl":"https://api.example.test"};' }
    : { ok: true, json: async () => ({ ok: true, session_token: 'test', events: [], conversations: [] }) });

  assert.equal(h.run('API'), '');
  await h.dispatchWindow('online');
  assert.equal(h.run('API'), 'https://api.example.test');
  assert.equal(h.run('globalThis.BingliConfig.apiUrl("/api/events")'), 'https://api.example.test/api/events');
});

test('health background stays unchecked until the user selects and saves up to five local choices', async () => {
  const h = harness(), entries = Array.from({ length: 6 }, (_, index) => ({
    context_id: `context_${index + 1}`, category: 'conditions', text: `虚构背景 ${index + 1}`,
  }));
  const calls = [];
  h.context.testApi = async (route, options = {}) => {
    calls.push({ route, options });
    if (route === '/api/events') return { r: { ok: true }, j: { events: [] } };
    if (route === '/api/conversations') return { r: { ok: true }, j: { conversations: [] } };
    if (route === '/api/health-context') return { r: { ok: true }, j: { health_context: { entries } } };
    const ids = JSON.parse(options.body).context_ids;
    return { r: { ok: true }, j: { conversation: { conversation_id: 'conversation_test', version: 1, turns: [], report: null, selected_context_ids: ids } } };
  };
  h.run("api=testApi; activeConversation={conversation_id:'conversation_test',version:1,turns:[],selected_context_ids:[],report:null}; $('healthContextPickerPanel').classList.remove('hidden')");
  await h.run('loadHealthContextForPicker()');
  for (let index = 1; index <= 5; index++) assert.equal(h.run(`changeContextPickerSelection('context_${index}',true)`), true);
  assert.equal(h.run("changeContextPickerSelection('context_6',true)"), false);
  assert.equal(h.run('contextDraftSelection.size'), 5);

  assert.equal(await h.run('saveHealthContextSelection()'), true);
  const contextCalls = calls.filter(call => call.route === '/api/health-context' || call.route.endsWith('/context'));
  assert.deepEqual(contextCalls.map(call => call.route), ['/api/health-context', '/api/conversations/conversation_test/context']);
  assert.deepEqual(JSON.parse(contextCalls[1].options.body), { context_ids: ['context_1', 'context_2', 'context_3', 'context_4', 'context_5'] });
  assert.equal(calls.some(call => call.route.endsWith('/turns')), false, 'choosing context must not send a user turn or call AI');
  assert.equal(h.element('openHealthContextPickerBtn').textContent, '已选 5 项相关资料（可选）');
});

test('choosing no background saves an empty selection while ordinary close preserves the saved choice', async () => {
  const h = harness(), entry = { context_id: 'context_fictional_asthma', category: 'conditions',
    text: '2022年医生曾告知有哮喘。', temporal_status: 'historical', occurred_on: '2022-04-12', remember: true };
  const calls = [];
  h.context.testApi = async (route, options = {}) => {
    calls.push({ route, options });
    if (route === '/api/health-context') return { r: { ok: true }, j: { health_context: { entries: [entry] } } };
    if (!options.body) return { r: { ok: true }, j: { events: [], conversations: [] } };
    const ids = JSON.parse(options.body).context_ids;
    return { r: { ok: true }, j: { conversation: { conversation_id: 'conversation_test', subject_id: 'subject_self',
      version: 3, turns: [], report: null, selected_context_ids: ids } } };
  };
  h.run("api=testApi; activeConversation={conversation_id:'conversation_test',subject_id:'subject_self',version:2,turns:[],selected_context_ids:['context_fictional_asthma'],report:null}; $('healthContextPickerPanel').classList.remove('hidden')");
  await h.run('loadHealthContextForPicker()');
  assert.equal(h.run('contextDraftSelection.has("context_fictional_asthma")'), true);

  h.click('closeHealthContextPickerBtn');
  assert.equal(calls.some(call => call.route.endsWith('/context')), false, 'ordinary close is not a save');
  assert.deepEqual(Array.from(h.run('activeConversation.selected_context_ids')), ['context_fictional_asthma']);

  h.run("$('healthContextPickerPanel').classList.remove('hidden')");
  await h.run('loadHealthContextForPicker()');
  await h.click('cancelHealthContextSelectionBtn');
  const saved = calls.find(call => call.route.endsWith('/context'));
  assert.ok(saved, 'the continue-without-background action must persist its decision');
  assert.deepEqual(JSON.parse(saved.options.body), { context_ids: [] });
  assert.deepEqual(Array.from(h.run('activeConversation.selected_context_ids')), []);
  assert.equal(h.run("$('healthContextPickerPanel').classList.contains('hidden')"), true);

  h.run("$('healthContextPickerPanel').classList.remove('hidden')");
  await h.run('loadHealthContextForPicker()');
  assert.equal(h.run('contextDraftSelection.size'), 0, 'reopening must reflect the saved empty choice');
  assert.equal(calls.some(call => call.route.endsWith('/turns')), false, 'selection changes do not submit a patient turn');
});

test('a failed no-background save keeps the original selection effective and the picker retryable', async () => {
  const h = harness(), entry = { context_id: 'context_fictional_asthma', category: 'conditions', text: '虚构测试背景', remember: true };
  const posts = [];
  h.context.testApi = async (route, options = {}) => {
    if (route === '/api/health-context') return { r: { ok: true }, j: { health_context: { entries: [entry] } } };
    if (route.endsWith('/context')) {
      const ids = JSON.parse(options.body).context_ids; posts.push(ids);
      if (posts.length === 1) return { r: { ok: false, status: 409 }, j: { error: 'subject_changed' } };
      return { r: { ok: true }, j: { conversation: { conversation_id: 'conversation_test', subject_id: 'subject_self', version: 4,
        turns: [], report: null, selected_context_ids: ids } } };
    }
    return { r: { ok: true }, j: { events: [], conversations: [] } };
  };
  h.run("api=testApi; activeHealthSubjectId='subject_family'; activeConversation={conversation_id:'conversation_test',subject_id:'subject_self',version:3,turns:[],selected_context_ids:['context_fictional_asthma'],report:null}; $('healthContextPickerPanel').classList.remove('hidden')");
  await h.run('loadHealthContextForPicker()');

  assert.equal(await h.click('cancelHealthContextSelectionBtn'), false);
  assert.equal(h.run("$('healthContextPickerPanel').classList.contains('hidden')"), false);
  assert.deepEqual(Array.from(h.run('activeConversation.selected_context_ids')), ['context_fictional_asthma']);
  assert.equal(h.run('contextDraftSelection.size'), 0, 'the pending choice remains visibly empty for retry');
  assert.match(h.element('contextSelectionStatus').textContent, /原选择仍在本机生效/);
  assert.equal(h.element('cancelHealthContextSelectionBtn').disabled, false);

  h.run("activeHealthSubjectId='subject_self'; healthSubjectChanged=false");
  assert.equal(await h.click('saveHealthContextSelectionBtn'), true);
  assert.deepEqual(posts, [[], []]);
  assert.deepEqual(Array.from(h.run('activeConversation.selected_context_ids')), []);
  assert.equal(h.run("$('healthContextPickerPanel').classList.contains('hidden')"), true);
});

test('stale-tab send refreshes changed conversation but preserves the unsent draft with an explicit notice', async () => {
  const h = harness(), calls = [], original = '我之前是不是说过脚踝的事？我现在记不清了。';let sendCount=0;
  const latest = { conversation_id: 'conversation_test', subject_id: 'subject_self', version: 8,
    selected_context_ids: [], turns: [{ turn_id: 'assistant_old', role: 'assistant', action: 'ask', text: '您今天最难受的是什么？', version: 1 }], report: null };
  h.context.testApi = async (route, options = {}) => {
    calls.push({ route, options });
    if (route.endsWith('/turns')) {
      sendCount++;
      if(sendCount===1)return { r: { ok: false, status: 409 }, j: { error: 'stale_conversation' } };
      const body=JSON.parse(options.body);
      return { r: { ok: true }, j: { conversation: { ...latest, version: 9, turns: [...latest.turns,
        { turn_id: 'elder_new', role: 'elder', text: body.text, version: 1 },
        { turn_id: 'assistant_new', role: 'assistant', text: '已记下。', version: 1 }] } } };
    }
    if (route.startsWith('/api/conversations/current?')) return { r: { ok: true }, j: { conversation: latest, resume_choice_required: false } };
    if (route === '/api/conversations/conversation_test') return { r: { ok: true }, j: { conversation: latest } };
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    if (route === '/api/events') return { r: { ok: true }, j: { events: [] } };
    return { r: { ok: true }, j: {} };
  };
  h.context.crypto = { randomUUID: () => 'synthetic-idempotency-key' };
  h.context.document.querySelector = selector => selector === '.view.active' ? { id: 'voiceView' } : null;
  h.element('voiceTextInput').style = {};
  h.run("activeHealthSubjectId='subject_self'; healthSubjectsVersion=1; healthSubjectUiEpoch=1; healthSubjectChanged=false; healthSubjectSwitchBusy=false; api=testApi; activeConversation={conversation_id:'conversation_test',subject_id:'subject_self',version:7,selected_context_ids:['context_old'],turns:[{turn_id:'assistant_old',role:'assistant',action:'ask',text:'您今天最难受的是什么？',version:1}],report:null}; $('voiceTextInput').value='我之前是不是说过脚踝的事？我现在记不清了。'");

  await h.run('saveVoiceSupplement()');
  await new Promise(setImmediate);

  assert.equal(h.run("$('voiceTextInput').value"), original, 'the unsent draft remains editable');
  assert.equal(h.run('activeConversation.version'), 8, 'the changed conversation is refreshed');
  assert.deepEqual(Array.from(h.run('activeConversation.selected_context_ids')), [], 'the revoked context is no longer selected');
  assert.equal(h.run('activeConversation.turns.some(turn=>turn.role==="elder"&&turn.text==="我之前是不是说过脚踝的事？我现在记不清了。")'), false,
    'the conflict does not append the unsent patient turn');
  assert.match(h.element('voiceConversationStatus').textContent, /对话或相关资料刚有更新；这句话尚未发送。请核对更新后的内容，再次点击发送。/);
  assert.equal(calls.filter(call => call.route.endsWith('/turns')).length, 1, 'there is no automatic resend');
  assert.equal(calls.some(call => call.route.endsWith('/resume-assistant')), false, 'refreshing after conflict does not auto-resume a reply');

  await h.run('saveVoiceSupplement()');
  assert.equal(sendCount, 2, 'only a separate user send retries the preserved draft');
  assert.equal(JSON.parse(calls.filter(call => call.route.endsWith('/turns')).at(-1).options.body).expected_version, 8);
  assert.equal(h.run("$('voiceTextInput').value"), '', 'the draft clears only after the explicit send succeeds');
});

test('stale-tab refresh is read-only when the updated conversation already has a pending patient turn', async () => {
  const h = harness(), calls = [], original = '合成草稿：脚踝有些不舒服';
  const latest = { conversation_id: 'conversation_test', subject_id: 'subject_self', version: 8,
    selected_context_ids: [], turns: [
      { turn_id: 'assistant_old', role: 'assistant', action: 'ask', text: '您今天最难受的是什么？', version: 1 },
      { turn_id: 'elder_pending', role: 'elder', text: '之前说过的原话', version: 1 },
    ], report: null };
  h.context.testApi = async (route, options = {}) => {
    calls.push({ route, options });
    if (route.endsWith('/turns')) return { r: { ok: false, status: 409 }, j: { error: 'stale_conversation' } };
    if (route === '/api/conversations/conversation_test') return { r: { ok: true }, j: { conversation: latest } };
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    if (route === '/api/events') return { r: { ok: true }, j: { events: [] } };
    return { r: { ok: true }, j: {} };
  };
  h.context.crypto = { randomUUID: () => 'synthetic-idempotency-key' };
  h.run("api=testApi; activeConversation={conversation_id:'conversation_test',subject_id:'subject_self',version:7,selected_context_ids:['context_old'],turns:[{turn_id:'assistant_old',role:'assistant',action:'ask',text:'您今天最难受的是什么？',version:1}],report:null}; $('voiceTextInput').value='合成草稿：脚踝有些不舒服'");

  await h.run('saveVoiceSupplement()');

  assert.equal(h.run("$('voiceTextInput').value"), original);
  assert.equal(h.run('activeConversation.version'), 8);
  assert.equal(h.run('activeConversation.turns.at(-1).turn_id'), 'elder_pending');
  assert.equal(calls.filter(call => call.route.endsWith('/turns')).length, 1);
  assert.equal(calls.some(call => call.route.endsWith('/resume-assistant')), false,
    'conflict refresh must not auto-request a reply for the pre-existing pending turn');
});

test('Mock and unavailable providers are identified without disabling local text entry', async () => {
  const h = harness();
  h.run("globalThis.HealthLocal={onlineStatus:async()=>({provider:'live',text_ai:{available:true,reason:'provider_configured'},audio_recognition:{available:false,reason:'network_unavailable'},image_recognition:{available:true,reason:'provider_mock'}})}");
  await h.run('refreshVoiceOnlineStatus()');
  assert.match(h.element('voiceOnlineStatus').textContent, /文字回复已配置，连接待验证/);
  assert.match(h.element('voiceOnlineStatus').textContent, /语音转文字网络暂不可用/);
  assert.match(h.element('voiceOnlineStatus').textContent, /图片识别尚未接通/);
  assert.equal(h.element('voiceTextInput').disabled, false);
  assert.match(h.element('voiceOnlineStatus').textContent, /原话和原件可先保存在本机/);
});

test('local storage full keeps the draft and gives neutral recovery guidance without retrying', async () => {
  const h = harness(), original = '合成QA原话：我咳嗽两天了，晚上明显些。';
  let sends = 0;
  h.context.testApi = async (route) => {
    if (route.endsWith('/turns')) {
      sends++;
      return { r: { ok: false, status: 507 }, j: { ok: false, error: 'local_storage_full' } };
    }
    return { r: { ok: true }, j: {} };
  };
  h.context.crypto = { randomUUID: () => 'synthetic-quota-test' };
  h.run("api=testApi; activeConversation={conversation_id:'conversation_test',subject_id:'subject_self',version:1,selected_context_ids:[],turns:[],report:null}; $('voiceTextInput').value='合成QA原话：我咳嗽两天了，晚上明显些。'");

  await h.run('saveVoiceSupplement()');

  assert.equal(sends, 1, 'the page does not automatically resend after a failed local write');
  assert.equal(h.run("$('voiceTextInput').value"), original, 'the unsaved text remains in the composer');
  assert.equal(h.element('voiceConversationStatus').textContent,
    '本机存储空间不足，这次保存没有完整完成。请先复制输入文字并保留当前页面；释放设备空间后，先核对当前对话和“我的记录”，再决定是否重试。不要清除本应用的网站数据。');
  assert.equal(h.run("$('voiceConversationStatus').textContent.includes('全部已保存')"), false);
  assert.equal(h.run("$('voiceConversationStatus').textContent.includes('完全未保存')"), false);
});

test('global Mock provider affects text only; audio and image use their own capabilities', async () => {
  const h = harness();
  h.run("globalThis.HealthLocal={onlineStatus:async()=>({provider:'mock',text_ai:{available:true,reason:'provider_configuration_missing_or_invalid'},audio_recognition:{available:true,reason:'provider_configured_connection_unverified'},image_recognition:{available:false,reason:'media_configuration_invalid'}})}");
  await h.run('refreshVoiceOnlineStatus()');
  assert.match(h.element('voiceOnlineStatus').textContent, /文字回复尚未接通/);
  assert.match(h.element('voiceOnlineStatus').textContent, /语音转文字已配置，连接待验证/);
  assert.match(h.element('voiceOnlineStatus').textContent, /图片识别尚未接通/);
  assert.doesNotMatch(h.element('voiceOnlineStatus').textContent, /Mock|演示模式|回复为模拟内容|已开通/);
});

test('ready capabilities use plain-language daily guidance instead of repeating configuration status', async () => {
  const h = harness();
  h.run("globalThis.HealthLocal={onlineStatus:async()=>({provider:'live',text_ai:{available:true,reason:'provider_configured_connection_unverified'},audio_recognition:{available:true,reason:'provider_configured_connection_unverified'},image_recognition:{available:true,reason:'provider_configured_connection_unverified'}})}");
  await h.run('refreshVoiceOnlineStatus()');
  assert.equal(h.element('voiceOnlineStatus').textContent, '原话会先保存在本机；语音识别和回复需要联网。');
  assert.doesNotMatch(h.element('voiceOnlineStatus').textContent, /连接待验证|已配置/);
});

test('successful conversation replies and media recognition refresh the matching capability banners', async () => {
  const h = harness(), checks = { voice: 0, media: 0 }, calls = [];
  h.run('localMode=true');
  h.context.HealthLocal = {
    async request(path) { calls.push(path); return { r: { ok: true }, j: { state: 'completed' } }; },
    async onlineStatus() {
      checks.voice++;
      return { provider: 'live', text_ai: { available: true }, audio_recognition: { available: true }, image_recognition: { available: true } };
    },
  };
  h.context.refreshMediaOnlineStatus = async () => { checks.media++; };

  for (const path of [
    '/api/conversations/c1/turns',
    '/api/conversations/c1/turns/t1/first-send',
    '/api/conversations/c1/resume-assistant',
    '/api/media/m1/recognize',
  ]) {
    await h.run(`api(${JSON.stringify(path)}, {method:'POST', body:'{}'})`);
  }
  await new Promise(setImmediate);
  assert.deepEqual(calls.filter(path => /\/(?:turns(?:\/[^/]+\/first-send)?|resume-assistant|recognize)$/.test(path)), [
    '/api/conversations/c1/turns',
    '/api/conversations/c1/turns/t1/first-send',
    '/api/conversations/c1/resume-assistant',
    '/api/media/m1/recognize',
  ]);
  assert.equal(checks.voice, 4, 'each completed user-visible reply/recognition path refreshes text capability');
  assert.equal(checks.media, 1, 'ASR capability is refreshed after recognition only');

  h.context.HealthLocal.request = async () => ({ r: { ok: false, status: 503 }, j: { error: 'provider_unavailable' } });
  h.context.HealthLocal.onlineStatus = async () => { throw new Error('synthetic status refresh failure'); };
  const failedReply = await h.run("api('/api/conversations/c1/turns',{method:'POST',body:'{}'})");
  await new Promise(setImmediate);
  assert.equal(failedReply.r.ok, false, 'capability refresh remains detached from the request result');
});

test('failed assistant reply offers one manual retry without repeating the saved health text', async () => {
  const h = harness(), calls = [];
  h.context.testApi = async (route, options = {}) => {
    calls.push({ route, options });
    return { r: { ok: true }, j: { ai_failed: false, conversation: { conversation_id: 'conversation_test', version: 3, selected_context_ids: [], report: null, turns: [
      { turn_id: 'elder_1', role: 'elder', text: '虚构病情不重复显示', version: 1 },
      { turn_id: 'assistant_2', role: 'assistant', text: '恢复后的回复', version: 1 },
    ] } } };
  };
  h.run("api=testApi; activeConversation={conversation_id:'conversation_test',version:2,selected_context_ids:[],report:null,turns:[{turn_id:'elder_1',role:'elder',text:'虚构病情不重复显示',version:1},{turn_id:'assistant_2',role:'assistant',text:'内部失败提示包含虚构病情不重复显示',ai_failed:true,version:1}]}; renderVoiceConversation()");
  assert.match(h.element('voiceConversationTurns').innerHTML, /data-voice-retry/);
  assert.match(h.element('voiceConversationTurns').innerHTML, /这次回复未确认成功，原话已保存在本机。/);
  assert.doesNotMatch(h.element('voiceConversationTurns').innerHTML, /稍后重试或继续/);
  assert.doesNotMatch(h.element('voiceConversationTurns').innerHTML, /内部失败提示包含虚构病情不重复显示/);
  const archivedFailure = h.run('conversationTranscriptTurnHtml(activeConversation.turns[1])');
  assert.match(archivedFailure, /这次回复未确认成功，原话已保存在本机。/);
  assert.match(archivedFailure, /<summary>当时系统提示（历史）<\/summary><p>内部失败提示包含虚构病情不重复显示<\/p>/);
  assert.doesNotMatch(archivedFailure.replace(/<details[\s\S]*?<\/details>/g, ''), /内部失败提示包含虚构病情不重复显示/);
  assert.doesNotMatch(archivedFailure, /data-voice-retry/);
  assert.equal(h.run('activeConversation.turns[1].text'), '内部失败提示包含虚构病情不重复显示');

  h.context.testRetryButton = h.element('retry-button');
  assert.equal(await h.run('retryConversationReply(testRetryButton)'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/conversations/conversation_test/resume-assistant');
  assert.equal(h.run('activeConversation.turns.filter(turn=>turn.role==="elder").length'), 1);

  for (const state of ['stopped', 'completed']) {
    h.run(`activeConversation={conversation_id:'saved_audio_${state}',version:3,selected_context_ids:[],report:null,saved_audio_trial:{state:'${state}'},turns:[{turn_id:'elder_saved',role:'elder',text:'虚构录音原话',version:1},{turn_id:'assistant_saved',role:'assistant',text:'',ai_failed:true,error_code:'model_timeout',version:1}]}; renderVoiceConversation()`);
    assert.match(h.element('voiceConversationTurns').innerHTML, /模型响应超时/);
    assert.doesNotMatch(h.element('voiceConversationTurns').innerHTML, /data-voice-retry/);
  }
});
