// Controlled browser/API state regression. This is not real microphone or ASR evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, randomUUID } = require('node:crypto');
const { test } = require('node:test');

function harness() {
  const elements = new Map(), storage = new Map(), recorders = [], views = [], requests = [], windowListeners = {}, confirmMessages = [];
  let response = async () => ({ r: { ok: true, status: 200 }, j: { ok: true, media: [] } });
  let nextId = 1, waits = 0;
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const attributes = new Map();
      elements.set(id, {
        id, value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, style: {}, children: [],
        classList: {
          add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); },
          toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        },
        querySelector(selector) { return element(id + ':' + selector); }, querySelectorAll() { return []; },
        addEventListener() {}, scrollIntoView() {}, append(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
      });
    }
    return elements.get(id);
  }
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; this.listeners = []; recorders.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
    addEventListener(name, callback) { assert.equal(name, 'stop'); this.listeners.push(callback); }
    emit(text) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
    async finish(finalText = '') {
      if (finalText) this.emit(finalText);
      this.onstop?.();
      for (const listener of this.listeners.splice(0)) await listener();
    }
  }
  const context = vm.createContext({
    console, Blob, FormData, URL, crypto: { subtle: webcrypto.subtle, randomUUID }, MediaRecorder: Recorder,
    location: { hostname: 'localhost', port: '5173' },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    document: { getElementById: element, querySelectorAll: () => [], createElement: tag => element('new-' + tag + nextId++) },
    window: { scrollTo() {}, addEventListener(name, callback) { windowListeners[name] = callback; } }, confirm: message => { confirmMessages.push(message); return true; },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, session_token: 'test', provider: 'mock', events: [] }) }),
    setInterval() { return nextId++; }, clearInterval() {}, clearTimeout() {},
    setTimeout(callback, milliseconds) { if (milliseconds === 1000) { waits++; queueMicrotask(callback); } return nextId++; },
  });
  function run(code) { return vm.runInContext(code, context); }
  run(fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8'));
  context.testApi = async (route, options = {}) => {
    requests.push({ route, options });
    if (route === '/api/events') return { r: { ok: true }, j: { events: [] } };
    if (route === '/api/conversations') return { r: { ok: true }, j: { conversations: [] } };
    return response(route, options);
  };
  context.testShowView = id => views.push(id);
  run('api=testApi; health=async()=>true; loadEvents=async()=>{}; showView=testShowView; toast=()=>{};');
  run(fs.readFileSync(path.join(__dirname, '../frontend/media.js'), 'utf8'));
  return {
    element, recorders, views, requests, storage, windowListeners, confirmMessages, run, context,
    click: id => element(id).onclick(), setApi(callback) { response = callback; },
    get waits() { return waits; },
  };
}

const saved = () => ({ media_id: 'media_test', kind: 'audio', content_type: 'audio/webm',
  version: 1, save_status: 'saved', recognition_status: 'not_started', link_status: 'not_linked' });

for (const scenario of ['deleted original', 'another conversation']) test(`same media bytes can be saved after ${scenario}`, async () => {
  const h = harness();
  let creates = 0, exists = true;
  const associated = [];
  h.run('globalThis.HealthLocal={active:true}');
  h.context.fixture = new Blob(['synthetic-media'], { type: 'audio/webm' });
  h.setApi(async (route, options) => {
    if (route === '/api/media/capabilities') return { r: { ok: true }, j: { capabilities: {
      enabled: true, audio_content_types: ['audio/webm'], image_content_types: ['image/png'],
      max_total_bytes: 1000, max_part_bytes: 1000, max_parts: 2,
    } } };
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    if (route === '/api/media/uploads') {
      creates++; associated.push(options.body.get('conversation_id'));
      return { r: { ok: true }, j: { upload: { media_id: `media_${creates}`, upload_id: `upload_${creates}` } } };
    }
    if (/\/parts\//.test(route)) return { r: { ok: true }, j: {} };
    if (/\/complete$/.test(route)) return { r: { ok: true }, j: { media: { ...saved(), media_id: `media_${creates}` } } };
    if (/^\/api\/media\/media_/.test(route)) return exists
      ? { r: { ok: true }, j: { media: { ...saved(), media_id: 'media_1' } } }
      : { r: { ok: false, status: 404 }, j: { error: 'media_not_found' } };
    throw new Error('unexpected route ' + route);
  });
  const first = await h.run('uploadMedia(fixture,"audio",{temporary:true,conversationId:"conversation_first"})');
  assert.equal(first.media_id, 'media_1');
  if (scenario === 'deleted original') exists = false;
  const second = await h.run(`uploadMedia(fixture,"audio",{temporary:true,conversationId:"${scenario==='deleted original'?'conversation_first':'conversation_second'}"})`);
  assert.equal(second?.media_id, 'media_2');
  assert.equal(creates, 2);
  assert.equal(associated[1], scenario === 'deleted original' ? 'conversation_first' : 'conversation_second');
});

test('unavailable or Mock recognition is visible but does not disable saving the local original', async () => {
  const h = harness();
  h.setApi(async route => route === '/api/media/capabilities'
    ? { r: { ok: true }, j: { capabilities: { enabled: true } } }
    : { r: { ok: true }, j: { media: [] } });
  await h.run('loadMediaCapabilities()');
  let status = { image_recognition: { available: false, reason: 'configuration_missing' }, audio_recognition: { available: false, reason: 'network_unavailable' } };
  h.run('globalThis.HealthLocal={onlineStatus:async()=>statusForTest}');
  h.context.statusForTest = status;
  await h.run('refreshMediaOnlineStatus()');
  assert.match(h.element('photoRecognitionStatus').textContent, /图片原件仍可保存在本机/);
  assert.match(h.element('mediaRecognitionStatus').textContent, /图片识别尚未接通/);
  assert.equal(h.element('photoInput').disabled, false);
  assert.equal(h.element('savePhotoBtn').disabled, false);

  status = { image_recognition: { available: true, reason: 'provider_mock' }, audio_recognition: { available: true, reason: 'provider_configured' } };
  h.context.statusForTest = status;
  await h.run('refreshMediaOnlineStatus()');
  assert.match(h.element('photoRecognitionStatus').textContent, /图片识别尚未接通/);
  assert.doesNotMatch(h.element('photoRecognitionStatus').textContent, /Mock|演示模式/);
  assert.equal(h.element('savePhotoBtn').disabled, false);
});

test('media recognition status uses each capability even when the text provider is Mock', async () => {
  const h = harness();
  h.run('globalThis.HealthLocal={onlineStatus:async()=>({provider:"mock",audio_recognition:{available:true,reason:"provider_configured_connection_unverified"},image_recognition:{available:false,reason:"provider_not_configured"}})}');
  await h.run('refreshMediaOnlineStatus()');
  assert.match(h.element('photoRecognitionStatus').textContent, /图片识别尚未接通/);
  assert.match(h.element('mediaRecognitionStatus').textContent, /图片识别尚未接通/);
  assert.match(h.element('mediaRecognitionStatus').textContent, /语音转文字已配置，连接待验证/);
});

test('shared Mock recognition error uses neutral media wording', async () => {
  const h = harness();
  h.setApi(async () => ({ r: { ok: false, status: 503 }, j: { error: 'media_mock_unavailable', retryable: true } }));
  const error = await h.run("mediaRequest('/api/media/media_test/recognize',{method:'POST'}).catch(error=>error)");
  assert.equal(error.message, '识别服务尚未接通；原件已保存，可直接打字记录。');
});

test('empty or invalid audio explains re-recording and keeps the original view without retrying the same file', async () => {
  const h = harness();
  for (const [index, code] of ['invalid_media', 'no_text_detected'].entries()) {
    const media = { ...saved(), media_id: `media_${index}`, recognition_status: 'failed',
      recognition: { text: '', error: { code, retryable: false }, error_message: code } };
    h.context.currentFailure = media;
    await h.run('showVoiceMediaResult(currentFailure)');
    assert.match(h.element('voiceConversationStatus').textContent, /没有录到可用声音，请重新录音/);
    assert.match(h.element('voiceConversationStatus').textContent, /原件仍可查看/);
    assert.equal(h.requests.some(request => request.route.endsWith('/turns')), false);

    h.context.currentFailure = media;
    h.run('mediaItems=[currentFailure];renderMedia();showRecognition(currentFailure)');
    const archive = h.element('archivePhotos').innerHTML;
    assert.match(archive, /没有可识别的声音，请重新录音/);
    assert.match(archive, /data-original=/, 'the saved original remains available');
    assert.doesNotMatch(archive, /data-recognize=/, 'a terminal empty/invalid file is not offered as a futile retry');
    assert.match(h.element(`media-${media.media_id}:.media-result`).innerHTML, /没有可识别的声音，请重新录音/);
  }
});

test('finish captures this recorder and final bytes even if the global chunks array changes', async () => {
  const h = harness();
  let captured;
  h.context.captureUpload = async blob => { captured = blob; return null; };
  h.run('uploadMedia=captureUpload');
  await h.click('recordBtn');
  h.recorders[0].emit('before-stop/');
  h.click('finishVoiceBtn');
  assert.equal(h.run('voiceUploadPending'), true);
  assert.equal(h.element('recordBtn').disabled, true);
  h.run('chunks=[]');
  await h.recorders[0].finish('final-stop-data');
  assert.equal(await captured.text(), 'before-stop/final-stop-data');
  assert.equal(await h.run('pendingRecordingBlob').text(), await captured.text());
  assert.equal(h.element('retryVoiceUploadBtn').classList.contains('hidden'), false);
  assert.equal(h.views.length, 0, '完整前端应留在语音对话里展示保存和识别状态');
});

test('a MediaRecorder stop exception still preserves and offers retry for captured bytes', async () => {
  const h = harness(); let captured;
  h.context.captureStopFailure = async blob => { captured = blob; return null; };
  h.run('uploadMedia=captureStopFailure');
  await h.click('recordBtn');
  const recorder = h.recorders[0]; recorder.emit('partial-preserved');
  recorder.stop = () => { throw new Error('stop failed'); };
  h.click('finishVoiceBtn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await captured.text(), 'partial-preserved');
  assert.equal(await h.run('pendingRecordingBlob.text()'), 'partial-preserved');
  assert.equal(h.element('retryVoiceUploadBtn').classList.contains('hidden'), false);
});

test('conversation card deletion confirms once and sends the exact scoped request', async () => {
  const h = harness();
  let deleteRequest;
  const button = h.element('conversation-card-delete');
  h.setApi(async (route, options) => {
    if (route === '/api/media/capabilities') return { r: { ok: true }, j: { capabilities: { enabled: false } } };
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    deleteRequest = { route, options };
    return { r: { ok: true }, j: { deleted: { local_media_count: 1 } } };
  });
  h.context.testDeleteButton = button;
  await h.run('deleteConversation({conversation_id:"conversation_test",version:7},testDeleteButton)');
  assert.equal(deleteRequest.route, '/api/conversations/conversation_test');
  assert.equal(deleteRequest.options.method, 'DELETE');
  assert.deepEqual(JSON.parse(deleteRequest.options.body), { delete_scope_confirmed: true, expected_version: 7 });
  assert.equal(h.confirmMessages.length, 1);
  assert.match(h.confirmMessages[0], /确定删除这条完整对话吗/);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-label'), '正在删除这条完整对话');
});

test('standalone record deletion uses one confirmation and its own endpoint', async () => {
  const h = harness();
  let deleteRequest;
  const button = h.element('standalone-card-delete');
  h.setApi(async (route, options) => {
    if (route === '/api/media/capabilities') return { r: { ok: true }, j: { capabilities: { enabled: false } } };
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    deleteRequest = { route, options };
    return { r: { ok: true }, j: { deleted: { local_media_count: 0 } } };
  });
  h.context.testDeleteButton = button;
  await h.run('deleteRecord({record_id:"record_test"},testDeleteButton)');
  assert.equal(deleteRequest.route, '/api/events/record_test');
  assert.equal(deleteRequest.options.method, 'DELETE');
  assert.deepEqual(JSON.parse(deleteRequest.options.body), { delete_scope_confirmed: true });
  assert.equal(h.confirmMessages.length, 1);
  assert.match(h.confirmMessages[0], /确定删除这条记录吗/);
  assert.equal(button.disabled, true);
});

test('selected video/webm recording is declared audio/webm while its original bytes stay unchanged', async () => {
  const h = harness();
  const expectedBytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01, 0x7f, 0x80]);
  const source = new Blob([expectedBytes], { type: 'video/webm' });
  Object.defineProperty(source, 'name', { value: 'saved-recording.webm' });
  let metadata, uploadedBytes, recognizedId;
  h.setApi(async (route, options = {}) => {
    if (route === '/api/media/capabilities') return { r: { ok: true }, j: { capabilities: {
      enabled: true, audio_content_types: ['audio/webm'], image_content_types: ['image/png'],
      max_total_bytes: 1000, max_part_bytes: 1000, max_parts: 2,
    } } };
    if (route === '/api/media/uploads') {
      metadata = Object.fromEntries(['kind', 'content_type', 'expected_size', 'original_filename'].map(key => [key, options.body.get(key)]));
      return { r: { ok: true }, j: { upload: { media_id: 'media_selected', upload_id: 'upload_selected' } } };
    }
    if (route === '/api/media/uploads/upload_selected/parts/0') {
      uploadedBytes = new Uint8Array(await options.body.get('file').arrayBuffer());
      return { r: { ok: true }, j: { created: true } };
    }
    if (route === '/api/media/uploads/upload_selected/complete') return { r: { ok: true }, j: { media: { ...saved(), media_id: 'media_selected' } } };
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    throw new Error('unexpected test route ' + route);
  });
  h.context.captureRecognition = async id => { recognizedId = id; };
  h.run('recognizeMedia=captureRecognition');
  const input = h.element('audioUploadInput');
  input.files = [source];
  input.value = 'saved-recording.webm';
  await input.onchange({ target: input });

  assert.deepEqual(metadata, { kind: 'audio', content_type: 'audio/webm', expected_size: String(expectedBytes.length), original_filename: 'saved-recording.webm' });
  assert.deepEqual([...uploadedBytes], [...expectedBytes]);
  assert.equal(source.type, 'video/webm', 'normalization applies to upload metadata, not the selected original');
  assert.deepEqual([...new Uint8Array(await source.arrayBuffer())], [...expectedBytes]);
  assert.equal(recognizedId, 'media_selected');
});

test('unsupported selected video MIME is not added to the audio whitelist', async () => {
  const h = harness();
  h.setApi(async route => {
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    if (route === '/api/media/capabilities') return { r: { ok: true }, j: { capabilities: {
      enabled: true, audio_content_types: ['audio/webm'], image_content_types: ['image/png'],
      max_total_bytes: 1000, max_part_bytes: 1000, max_parts: 2,
    } } };
    throw new Error('unsupported file must be rejected before upload: ' + route);
  });
  const media = new Blob(['not uploaded'], { type: 'video/mp4' });
  h.context.unsupportedVideo = media;
  const result = await h.run('uploadMedia(unsupportedVideo,"audio")');
  assert.equal(result, undefined);
  assert.match(h.element('mediaStatus').textContent, /当前服务不支持该文件格式/);
  assert.equal(h.requests.some(request => request.route === '/api/media/uploads'), false);
});

test('failed multipart upload keeps original Blob and retry identity; success automatically recognizes', async () => {
  const h = harness();
  const media = saved();
  let failPart = true, recognizeCount = 0;
  const partKeys = [], partBytes = [];
  h.setApi(async (route, options) => {
    if (route === '/api/media') return { r: { ok: true, status: 200 }, j: { media: [media] } };
    if (route === '/api/media/capabilities') return { r: { ok: true }, j: { capabilities: {
      enabled: true, audio_content_types: ['audio/webm'], image_content_types: ['image/png'],
      max_total_bytes: 1000, max_part_bytes: 1000, max_parts: 2,
    } } };
    if (route === '/api/media/uploads') return { r: { ok: true }, j: { upload: { media_id: 'media_test', upload_id: 'upload_test' } } };
    if (route === '/api/media/media_test') return { r: { ok: true }, j: { media: { ...media, save_status: 'uploading' } } };
    if (route === '/api/media/uploads/upload_test/parts/0') {
      partKeys.push(options.headers['Idempotency-Key']); partBytes.push(await options.body.get('file').text());
      if (failPart) return { r: { ok: false, status: 0 }, j: {} };
      return { r: { ok: true }, j: { created: true } };
    }
    if (route === '/api/media/uploads/upload_test/complete') return { r: { ok: true }, j: { media } };
    throw new Error('unexpected test route ' + route);
  });
  h.context.captureRecognition = async id => { assert.equal(id, 'media_test'); recognizeCount++; };
  h.run('recognizeMedia=captureRecognition');
  await h.click('recordBtn'); h.recorders[0].emit('retained-original');
  h.click('finishVoiceBtn'); await h.recorders[0].finish();
  assert.equal(await h.run('pendingRecordingBlob').text(), 'retained-original');
  assert.equal(h.run('voiceUploadPending'), true);
  assert.equal(recognizeCount, 0);
  assert.match(h.element('voiceHint').textContent, /尚未保存/);
  assert.equal(h.element('retryVoiceUploadBtn').disabled, false);
  let prevented = false;
  h.windowListeners.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  failPart = false;
  await h.click('retryVoiceUploadBtn');
  assert.equal(partKeys.length, 2); assert.equal(partKeys[0], partKeys[1]);
  assert.deepEqual(partBytes, ['retained-original', 'retained-original']);
  assert.equal(h.run('pendingRecordingBlob'), null);
  assert.equal(h.run('voiceUploadPending'), false);
  assert.equal(h.element('retryVoiceUploadBtn').classList.contains('hidden'), true);
  assert.equal(recognizeCount, 1);
  assert.equal(h.element('recordBtn').disabled, false);
});

test('successful recognition waits through safety and event linking, then renders top-level safety', async () => {
  const h = harness();
  const safety = { danger_detected: true, danger_reminder: '顶层危险提醒：请联系专业人员。' };
  const states = [
    saved(),
    { ...saved(), recognition_status: 'succeeded', link_status: 'pending', link_pending_reason: 'safety_scan_pending' },
    { ...saved(), recognition_status: 'succeeded', link_status: 'pending', link_pending_reason: 'event_link_pending' },
    { ...saved(), recognition_status: 'succeeded', link_status: 'linked', event_link: { record_id: 'rec_test' }, local_safety: safety,
      recognition: { text: '已识别文字', is_mock: false, local_safety: { danger_detected: false } } },
  ];
  let reads = 0, posts = 0;
  h.setApi(async (route, options) => {
    if (route === '/api/media') return { r: { ok: true }, j: { media: [states[Math.min(reads, states.length - 1)]] } };
    if (route === '/api/media/media_test/recognize') { posts++; return { r: { ok: true }, j: { accepted: true } }; }
    if (route === '/api/media/media_test') return { r: { ok: true }, j: { media: states[Math.min(reads++, states.length - 1)] } };
    throw new Error('unexpected test route ' + route);
  });
  await h.run('recognizeMedia("media_test")');
  assert.equal(posts, 1);
  assert.equal(reads, 4);
  assert.equal(h.waits, 2);
  const result = h.element('media-media_test:.media-result');
  assert.match(result.innerHTML, /顶层危险提醒/);
  assert.match(result.innerHTML, /已识别文字/);
  assert.equal(result.children.at(-1).textContent, '核对识别记录');
  assert.match(h.element('mediaStatus').textContent, /识别文字已保留/);
  assert.equal(h.run('recognitionBusy.size'), 0);
});

test('successful temporary recognition keeps polling while the conversation turn is being persisted', async () => {
  const h = harness();
  const pending = { ...saved(), temporary: true, conversation_id: 'conversation_test', record_id: 'record_test',
    recognition_status: 'succeeded', link_pending_reason: 'conversation_link_pending',
    recognition: { text: '今天有些头晕。', is_mock: false } };
  const linked = { ...pending, link_pending_reason: null, conversation_turn_id: 'turn_00000001' };
  let reads = 0, recognizePosts = 0;
  h.context.testPending = pending;
  h.context.testLinked = linked;
  h.setApi(async route => {
    if (route === '/api/media') return { r: { ok: true }, j: { media: [pending] } };
    if (route === '/api/media/media_test') return { r: { ok: true }, j: { media: reads++ === 0 ? pending : linked } };
    if (route.endsWith('/recognize')) { recognizePosts++; return { r: { ok: true }, j: {} }; }
    throw new Error('unexpected test route ' + route);
  });
  await h.run('recognizeMedia("media_test")');
  assert.equal(h.run('recognitionStillFinishing(testPending)'), true);
  assert.equal(h.run('recognitionStillFinishing(testLinked)'), false);
  assert.equal(recognizePosts, 0, 'polling an already-successful result must not submit recognition again');
  assert.equal(reads, 2, 'polling must continue until the conversation turn id is persisted');
  assert.match(h.element('mediaStatus').textContent, /识别文字已保留/);
});

test('pending audio-to-conversation link never posts a duplicate elder turn; persisted turn only refreshes', async () => {
  const h = harness();
  const pending = { ...saved(), temporary: true, conversation_id: 'conversation_test',
    recognition_status: 'succeeded', link_pending_reason: 'conversation_link_pending',
    recognition: { text: '今天有些头晕。', is_mock: false } };
  const conversation = { conversation_id: 'conversation_test', version: 3,
    turns: [{ turn_id: 'turn_00000001', role: 'elder', text: '今天有些头晕。' }] };
  h.context.testPending = pending;
  h.context.testLinked = { ...pending, conversation_turn_id: 'turn_00000001', link_pending_reason: null };
  h.run("activeConversation={conversation_id:'conversation_test',version:2,turns:[]}");
  h.setApi(async route => {
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    if (route === '/api/conversations/conversation_test') return { r: { ok: true }, j: { conversation } };
    if (route === '/api/conversations') return { r: { ok: true }, j: { conversations: [] } };
    if (route === '/api/conversations/conversation_test/pause') return { r: { ok: true }, j: { conversation } };
    throw new Error('unexpected test route ' + route);
  });
  await h.run('showVoiceMediaResult(testPending)');
  assert.match(h.element('voiceConversationStatus').textContent, /正在保存到这次对话/);
  assert.equal(h.requests.some(request => request.route.endsWith('/turns')), false);

  await h.run('showVoiceMediaResult(testLinked)');
  assert.equal(h.requests.filter(request => request.route.endsWith('/turns')).length, 0);
  assert.equal(h.requests.filter(request => request.route === '/api/conversations/conversation_test').length, 1);
  assert.equal(h.requests.filter(request => request.route.endsWith('/pause')).length, 1);
  assert.deepEqual(h.run('activeConversation.turns.map(turn=>turn.turn_id)'), ['turn_00000001']);
});

test('terminal conversation-link failure offers a safe retry with the original idempotency key and media references', async () => {
  const h = harness();
  const failedLink = { ...saved(), temporary: true, conversation_id: 'conversation_test', record_id: 'record_test',
    recognition_status: 'succeeded', conversation_link_error: 'conversation_link_interrupted',
    recognition: { text: '今天有些头晕。', is_mock: false } };
  const conversation = { conversation_id: 'conversation_test', version: 4,
    turns: [{ turn_id: 'turn_00000002', role: 'elder', text: '今天有些头晕。' }] };
  h.run("activeConversation={conversation_id:'conversation_test',version:3,turns:[]}");
  h.element('voiceTextInput').value = '';
  h.context.failedLink = failedLink;
  h.setApi(async route => {
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    if (route.endsWith('/turns')) return { r: { ok: true }, j: { conversation } };
    throw new Error('unexpected test route ' + route);
  });
  await h.run('showVoiceMediaResult(failedLink)');
  assert.equal(h.element('voiceTextInput').value, '今天有些头晕。');
  assert.equal(h.requests.some(request => request.route.endsWith('/turns')), false,
    'a failed persistence confirmation must ask for a deliberate retry, not silently repost');
  await h.run('saveVoiceSupplement()');
  const retry = h.requests.find(request => request.route.endsWith('/turns'));
  assert.ok(retry);
  assert.equal(retry.options.headers['Idempotency-Key'], 'media-conversation:media_test');
  assert.deepEqual(JSON.parse(retry.options.body), {
    text: '今天有些头晕。', source_kind: 'audio_transcript', record_id: 'record_test',
    media_id: 'media_test', expected_version: 3, keep_media_until_pause: true,
  });
  assert.equal(h.element('voiceTextInput').value, '');
});

test('a duplicate recognition click shares the in-flight request', async () => {
  const h = harness(); let resolveRead, posts = 0;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  h.setApi(async (route, options) => {
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    if (route.endsWith('/recognize')) { posts++; return { r: { ok: true }, j: {} }; }
    return pending;
  });
  const first = h.run('recognizeMedia("media_test")');
  await h.run('recognizeMedia("media_test")');
  resolveRead({ r: { ok: true }, j: { media: { ...saved(), recognition_status: 'succeeded',
    event_link: { record_id: 'rec_test' }, recognition: { text: 'existing result', is_mock: true } } } });
  await first;
  assert.equal(posts, 0);
  assert.equal(h.requests.filter(request => request.route === '/api/media/media_test').length, 1);
});

test('mock ASR text stays out of conversation and is never read aloud', async () => {
  const h = harness(); let spoken = 0;
  h.run("activeConversation={conversation_id:'conversation_test',version:1,turns:[]}; globalThis.speechSynthesis={cancel(){},resume(){},speak(){spokenCount++}}; globalThis.SpeechSynthesisUtterance=class { constructor(text){this.text=text} };");
  h.context.spokenCount = 0;
  const mock = { media_id: 'media_test', recognition_status: 'succeeded', recognition: { text: '[Mock ASR] bingli-ai-demo.webm', is_mock: true } };
  h.context.mockMedia = mock;
  await h.run('showVoiceMediaResult(mockMedia)');
  h.run("speakAssistant({turn_id:'turn_mock',role:'assistant',text:'[Mock ASR] bingli-ai-demo.webm',is_mock:true},true)");
  spoken = h.context.spokenCount;
  assert.match(h.element('voiceConversationStatus').textContent, /不是患者原话/);
  assert.equal(spoken, 0);
  assert.equal(h.requests.some(request => request.route.endsWith('/turns')), false);
});

test('unavailable real ASR gives the saved-original message and preserves a retryable historical original', async () => {
  const h = harness();
  const unavailable = { media_id: 'media_test', recognition_status: 'failed', save_status: 'saved',
    recognition: { is_mock: true, retryable: true, error: { code: 'media_mock_unavailable', retryable: true }, text: '[Mock ASR] prior demo' } };
  h.context.unavailableMedia = unavailable;
  await h.run('showVoiceMediaResult(unavailableMedia)');
  assert.match(h.element('voiceConversationStatus').textContent, /语音转文字尚未接通；录音已保存/);

  h.run('mediaItems=[unavailableMedia];renderMedia()');
  assert.match(h.element('archivePhotos').innerHTML, /模拟识别结果，不是患者原话/);
  assert.match(h.element('archivePhotos').innerHTML, /重新识别原录音/);
  h.context.testMockForDisplay = unavailable;
  h.run('showRecognition(testMockForDisplay)');
  const detail = h.element('media-media_test:.media-result').innerHTML;
  assert.match(detail, /不能核对为事实/);
  assert.doesNotMatch(detail, /核对识别记录|恢复记录关联/);

  h.context.unreadableOriginal = { media_id: 'media_missing', save_status: 'saved', recognition_status: 'failed',
    recognition: { error: { code: 'original_unavailable', retryable: false } } };
  await h.run('showVoiceMediaResult(unreadableOriginal)');
  assert.equal(h.element('voiceConversationStatus').textContent, '原录音无法读取，请重新录音后再试。');
});

test('legacy mock prefix is treated as historical simulation even without is_mock', async () => {
  const h = harness();
  h.context.legacyMock = { media_id: 'media_test', recognition_status: 'succeeded',
    recognition: { text: '[Mock ASR] bingli-ai-demo.webm', is_mock: false } };
  await h.run('showVoiceMediaResult(legacyMock)');
  assert.match(h.element('voiceConversationStatus').textContent, /不是患者原话/);
  assert.equal(h.requests.some(request => request.route.endsWith('/turns')), false);
});

test('an elder turn can be corrected in its own chat bubble and updates the report', async () => {
  const h = harness();
  const originalTurn = { turn_id: 'turn_00000001', role: 'elder', original_text: '鸡天坏豆腐说我坏的', text: '鸡天坏豆腐说我坏的', source_kind: 'audio_transcript', record_id: 'rec_original', version: 1, versions: [] };
  const conversation = { conversation_id: 'conversation_test', turns: [{ turn_id: 'turn_assistant1', role: 'assistant', text: '请慢慢说。' }, originalTurn], report: { title: '就诊沟通记录', status_label: '自动整理 · 本人未核对', version: 1, source_turn_ids: [originalTurn.turn_id], body: '老人原话\n1. 鸡天坏豆腐说我坏的' } };
  const correctedTurn = { ...originalTurn, text: '今天吃豆腐后胃不舒服。', version: 2, versions: [{ version: 1, text: originalTurn.text }] };
  const corrected = { ...conversation, turns: [conversation.turns[0], correctedTurn], report: { ...conversation.report, version: 2, body: '老人原话\n1. 今天吃豆腐后胃不舒服。' } };
  h.setApi(async (route, options = {}) => {
    if (route === '/api/media') return { r: { ok: true, status: 200 }, j: { media: [] } };
    if (route === '/api/media/capabilities') return { r: { ok: true, status: 200 }, j: { capabilities: { enabled: true } } };
    if (route === '/api/conversations/conversation_test/turns/turn_00000001') return { r: { ok: true, status: 200 }, j: { conversation: corrected } };
    throw new Error('unexpected test route ' + route);
  });
  h.run(`activeConversation=${JSON.stringify(conversation)};renderVoiceConversation();beginVoiceTurnEdit('turn_00000001')`);
  assert.match(h.run("voiceTurnHtml(turnById('turn_00000001'))"), /修改刚才说的话/);
  const saved = await h.run("saveVoiceTurnEdit('turn_00000001','今天吃豆腐后胃不舒服。')");
  assert.equal(saved, true);
  const correction = h.requests.find(request => request.route === '/api/conversations/conversation_test/turns/turn_00000001');
  assert.deepEqual(JSON.parse(correction.options.body), {
    text: '今天吃豆腐后胃不舒服。', expected_version: 1,
  });
  assert.equal(h.run("turnById('turn_00000001').original_text"), originalTurn.original_text);
  assert.equal(h.run("turnById('turn_00000001').text"), '今天吃豆腐后胃不舒服。');
  assert.equal(h.run("activeConversation.report.version"), 2);
  assert.match(h.element('voiceConversationStatus').textContent, /原话和报告都已更新/);
});

test('failed turn correction keeps the newly typed text in the same bubble', async () => {
  const h = harness();
  const conversation = { conversation_id: 'conversation_test', turns: [{ turn_id: 'turn_00000001', role: 'elder', original_text: '错误的识别', text: '错误的识别', source_kind: 'audio_transcript', version: 1, versions: [] }], report: { version: 1, body: '错误的识别', source_turn_ids: ['turn_00000001'] } };
  h.setApi(async (route, options = {}) => {
    if (route === '/api/media') return { r: { ok: true, status: 200 }, j: { media: [] } };
    if (route === '/api/media/capabilities') return { r: { ok: true, status: 200 }, j: { capabilities: { enabled: true } } };
    if (route === '/api/conversations/conversation_test/turns/turn_00000001') return { r: { ok: false, status: 409 }, j: { error: 'stale_version' } };
    throw new Error('unexpected test route ' + route);
  });
  h.run(`activeConversation=${JSON.stringify(conversation)};beginVoiceTurnEdit('turn_00000001')`);
  const saved = await h.run("saveVoiceTurnEdit('turn_00000001','这是我刚改好的原话')");
  assert.equal(saved, false);
  assert.equal(h.run("turnById('turn_00000001').editText"), '这是我刚改好的原话');
  assert.match(h.run("voiceTurnHtml(turnById('turn_00000001'))"), /这是我刚改好的原话/);
  assert.match(h.run("voiceTurnHtml(turnById('turn_00000001'))"), /已经有新版本/);
});

test('document detail opens only selected revision photos locally and allows retry after a read failure', async () => {
  const h = harness(), opened = [];
  h.context.testOpenOriginal = async id => { opened.push(id); return 'blob:local-original'; };
  h.run("localMode=true;current={record_id:'rec_revision'};HealthLocal={active:true,originalObjectUrl:testOpenOriginal};");
  h.setApi(async route => route === '/api/handoffs'
    ? { r: { ok: false }, j: {} } : { r: { ok: true }, j: { media: [] } });
  await h.run("showDocumentOriginals('rec_revision')");
  assert.match(h.element('documentOriginals').textContent, /重试/);
  assert.equal(h.element('documentOriginalBtn').disabled, false);
  h.setApi(async (route, options) => {
    if (route !== '/api/handoffs') return { r: { ok: true }, j: { media: [] } };
    assert.deepEqual(JSON.parse(options.body), { record_ids: ['rec_revision'] });
    return { r: { ok: true }, j: { handoff: { media_attachments: [
      { media_id: 'media_ancestor', kind: 'image', save_status: 'saved', record_id: 'rec_revision' },
      { media_id: 'media_audio', kind: 'audio', save_status: 'saved' },
    ] } } };
  });
  await h.run("showDocumentOriginals('rec_revision')");
  assert.deepEqual(opened, ['media_ancestor']);
  const image = h.element('documentOriginals').children[0].children[0];
  assert.equal(image.src, 'blob:local-original');
  assert.equal(image.alt, '已保存的照片原件');
  assert.equal(h.element('documentOriginalBtn').disabled, false);
});
