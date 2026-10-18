// Controlled browser/API state regression. This is not real microphone or ASR evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

function harness({ healthLocal = null, captureBootstrap = false } = {}) {
  const elements = new Map(), storage = new Map(), recorders = [], views = [], requests = [], windowListeners = {}, confirmMessages = [];
  let response = async route => ({ r: { ok: true, status: 200 }, j: route === '/api/events' ? { ok: true, events: [] } : { ok: true, media: [] } });
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
    console, Blob, FormData, URL, crypto: { subtle: webcrypto.subtle, randomUUID }, MediaRecorder: Recorder, HealthLocal: healthLocal,
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
  context.productionApi = context.api;
  context.testApi = async (route, options = {}) => {
    requests.push({ route, options });
    if (route === '/api/events') return response(route, options);
    if (route === '/api/conversations') return { r: { ok: true }, j: { conversations: [] } };
    return response(route, options);
  };
  context.testShowView = id => views.push(id);
  const bootstrapCalls = [], bootstrapObservers = [];
  context.captureBootstrap = (label, promise) => {
    const call = { label, promise }; bootstrapCalls.push(call);
    bootstrapObservers.forEach(observer => observer(label, call));
    return promise;
  };
  if (captureBootstrap) {
    run('api=productionApi; localMode=true;');
    run("const originalBootstrapSubjects=loadHealthSubjects;loadHealthSubjects=(...args)=>captureBootstrap('subjects',originalBootstrapSubjects(...args));const originalBootstrapEvents=loadEvents;loadEvents=(...args)=>captureBootstrap('events',originalBootstrapEvents(...args));");
  } else run('api=testApi; health=async()=>true; loadEvents=async()=>{}; showView=testShowView; toast=()=>{};');
  run(fs.readFileSync(path.join(__dirname, '../frontend/media.js'), 'utf8'));
  if (captureBootstrap) run("const originalBootstrapCapabilities=loadMediaCapabilities;loadMediaCapabilities=(...args)=>captureBootstrap('capabilities',originalBootstrapCapabilities(...args));const originalBootstrapMedia=loadMedia;loadMedia=(...args)=>captureBootstrap('media',originalBootstrapMedia(...args));");
  return {
    element, recorders, views, requests, storage, windowListeners, confirmMessages, bootstrapCalls, run, context,
    observeBootstrap(observer) { bootstrapObservers.push(observer); },
    click: id => element(id).onclick(), setApi(callback) { response = callback; },
    get waits() { return waits; },
  };
}

async function localStoreBridge() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, files: [], autocomplete: '',
      classList: { add() {}, remove() {}, toggle() {} }, focus() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController,
    setTimeout, clearTimeout, navigator: { storage: { persist: async () => true } },
    document: { getElementById: element, querySelector: () => null, createElement: () => element('localVaultGate'), body: { append() {} } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/local-store.js'), 'utf8'), context);
  const local = context.HealthLocal, passphrase = 'synthetic-media-bootstrap-test';
  await local.vault.setup(passphrase);
  const ready = local.initialise();
  await new Promise(setImmediate);
  element('vaultPassphrase').value = passphrase;
  await element('vaultForm').onsubmit({ preventDefault() {} });
  await ready;
  return local;
}

const saved = () => ({ media_id: 'media_test', kind: 'audio', content_type: 'audio/webm',
  version: 1, save_status: 'saved', recognition_status: 'not_started', link_status: 'not_linked' });
function reviewedAudioFixture({ reviewed = true } = {}) {
  const original='我咳嗽两天了，晚上更明显。',currentText='我咳嗽两天了，晚上明显些。';
  const root={record_id:'rec_audio_root',subject_id:'subject_self',source_kind:'audio_transcript',raw_text:original,state:'superseded',version:1};
  const current={record_id:'rec_audio_current',subject_id:'subject_self',source_kind:'audio_transcript',raw_text:currentText,state:'inbox',version:2,supersedes_id:root.record_id,
    source_review:reviewed?{method:'original_comparison',record_id:'rec_audio_current',text:currentText,confirmed_at:'2026-10-13T00:00:00Z'}:null};
  const media={...saved(),media_id:'media_reviewed_audio',subject_id:'subject_self',version:2,recognition_status:'succeeded',record_id:root.record_id,event_link:{record_id:root.record_id},recognition:{text:original,is_mock:false}};
  return {media,root,current,events:[root,current]};
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function settleBootstrap(h) {
  let settled = 0;
  while (settled < h.bootstrapCalls.length) {
    const batch = h.bootstrapCalls.slice(settled); settled = h.bootstrapCalls.length;
    await Promise.allSettled(batch.map(call => call.promise));
    await new Promise(setImmediate);
  }
}

test('media capability bootstrap waits for the actual local subject version', async () => {
  const h = harness(), local = await localStoreBridge();
  const subjects = await local.request('/api/health-subjects');
  assert.equal(subjects.r.status, 200);
  assert.ok(subjects.j.version > 0);
  const stale = await local.request('/api/media/capabilities', { headers: {
    'X-Health-Subject-Id': 'subject_self', 'X-Health-Subject-Version': '0',
  } });
  assert.equal(stale.r.status, 409);
  assert.equal(stale.j.error, 'stale_health_subjects');

  h.context.HealthLocal = local;
  h.run('localMode=true; api=productionApi; renderHealthSubjects=()=>{}; healthSubjectsVersion=0; healthSubjectLoaded=false; setMediaCapability(null)');
  const available = await h.run('loadMediaCapabilities()');
  assert.equal(available, true);
  assert.equal(h.run('healthSubjectsVersion'), subjects.j.version);
  assert.equal(h.element('photoInput').disabled, false);
  assert.equal(h.element('audioUploadInput').disabled, false);
});

test('media capability stays disabled when local subject synchronization fails', async () => {
  const h = harness();
  let capabilityRequests = 0;
  h.context.api = async path => {
    if (path === '/api/media/capabilities') capabilityRequests++;
    return { r: { ok: true }, j: { capabilities: { enabled: true } } };
  };
  h.run('localMode=true; loadHealthSubjects=async()=>false; setMediaCapability(null)');
  assert.equal(await h.run('loadMediaCapabilities()'), false);
  assert.equal(capabilityRequests, 0);
  assert.equal(h.element('photoInput').disabled, true);
  assert.equal(h.element('audioUploadInput').disabled, true);
});

test('app and media bootstrap share the real local owner read before loading records', async () => {
  const local = await localStoreBridge();
  const initial = await local.request('/api/health-subjects');
  const family = await local.request('/api/health-subjects', { method: 'POST', headers: {
    'X-Health-Subject-Id': initial.j.active_subject_id,
    'X-Health-Subject-Version': String(initial.j.version),
  }, body: JSON.stringify({ label: '虚构家属·启动并发', relationship: 'family', expected_version: initial.j.version }) });
  assert.equal(family.r.status, 201);
  const familyId = family.j.subjects.at(-1).subject_id;
  const selected = await local.request('/api/health-subjects/active', { method: 'POST', body: JSON.stringify({
    subject_id: familyId, expected_version: family.j.version,
  }) });
  assert.equal(selected.r.status, 200);
  const familyVersion = selected.j.version;

  const originalRequest = local.request.bind(local), firstGate = deferred(), secondGate = deferred();
  const firstReadReady = deferred(), secondReadReady = deferred(), eventsRead = deferred(), trace = [];
  let subjectReads = 0;
  local.request = async (path, options = {}) => {
    const method = options.method || 'GET', headers = options.headers || {};
    const entry = { path, method, subjectId: headers['X-Health-Subject-Id'] || '', version: headers['X-Health-Subject-Version'] || '' };
    if (path === '/api/health-subjects' && method === 'GET') {
      const ordinal = ++subjectReads, result = await originalRequest(path, options);
      trace.push({ ...entry, status: result.r.status, error: result.j.error || '' });
      (ordinal === 1 ? firstReadReady : secondReadReady).resolve();
      if (ordinal === 1) await firstGate.promise;
      if (ordinal === 2) await secondGate.promise;
      return result;
    }
    const result = await originalRequest(path, options);
    trace.push({ ...entry, status: result.r.status, error: result.j.error || '' });
    if (path === '/api/events' && method === 'GET') eventsRead.resolve(trace.at(-1));
    return result;
  };

  const h = harness({ healthLocal: local, captureBootstrap: true });
  const bothSubjectCallers = deferred(), capabilityBootstrap = deferred(); let subjectCallers = 0;
  h.observeBootstrap(label => {
    if (label === 'subjects' && ++subjectCallers === 2) bothSubjectCallers.resolve();
    if (label === 'capabilities') capabilityBootstrap.resolve();
  });
  try {
    await Promise.all([bothSubjectCallers.promise, capabilityBootstrap.promise, firstReadReady.promise]);
    if (subjectReads > 1) await secondReadReady.promise;
    firstGate.resolve();
    const events = await eventsRead.promise;
    await new Promise(setImmediate);
    assert.equal(events.subjectId, familyId, 'app waits for the family owner before loading records');
    assert.equal(events.version, String(familyVersion));
    assert.equal(events.status, 200);
    assert.equal(subjectReads, 1, 'concurrent startup callers share one owner-registry read');
    assert.equal(h.run('activeHealthSubjectId'), familyId);
    assert.equal(h.run('healthSubjectsVersion'), familyVersion);
    assert.equal(h.run('healthSubjectChanged'), false);
    assert.ok(trace.some(item => item.path === '/api/media/capabilities' && item.subjectId === familyId && item.version === String(familyVersion)));
  } finally {
    firstGate.resolve(); secondGate.resolve();
    await settleBootstrap(h);
  }
});

test('fast subject switch and archive navigation discard stale registry and capability reads', async () => {
  const h = harness(), local = await localStoreBridge();
  h.context.HealthLocal = local;
  h.run('localMode=true; api=productionApi; healthSubjectLoaded=false; healthSubjectChanged=false; healthSubjectSwitchBusy=false; pauseConversation=async()=>{}; loadHealthMemory=async()=>true; loadEvents=async()=>{}; loadMedia=async()=>{}; renderVoiceConversation=()=>{}; renderConversationReport=()=>{}; updateHealthContextButton=()=>{}');
  assert.equal(await h.run('loadHealthSubjects()'), true);
  h.element('newHealthSubjectLabel').value = '虚构家属·竞态回归';
  assert.equal(await h.run('createHealthSubject()'), true);
  const familyId = h.run('healthSubjects.find(subject=>subject.relationship==="family").subject_id');
  assert.equal(await h.run('loadMediaCapabilities()'), true);
  assert.equal(h.element('photoInput').disabled, false);

  const originalRequest = local.request.bind(local), capabilityStarted = deferred(), releaseOldCapability = deferred();
  const subjectReadStarted = deferred(), releaseOldSubjectRead = deferred();
  let holdNextCapability = true, holdNextSubjectRead = false;
  local.request = async (path, options) => {
    if (path === '/api/media/capabilities' && holdNextCapability) {
      holdNextCapability = false;
      capabilityStarted.resolve();
      await releaseOldCapability.promise;
    }
    const result = await originalRequest(path, options);
    if (path === '/api/health-subjects' && holdNextSubjectRead) {
      holdNextSubjectRead = false;
      subjectReadStarted.resolve();
      await releaseOldSubjectRead.promise;
    }
    return result;
  };
  const staleCapabilities = h.run('loadMediaCapabilities()');
  await capabilityStarted.promise;
  holdNextSubjectRead = true;
  const staleSubjectRead = h.run('loadHealthSubjects()');
  await subjectReadStarted.promise;

  const pause = deferred(); h.context.pauseForSwitch = pause.promise;
  h.run('pauseConversation=()=>pauseForSwitch');
  const switching = h.run(`activateHealthSubject(${JSON.stringify(familyId)})`);
  await new Promise(setImmediate);
  assert.equal(h.run('healthSubjectSwitchBusy'), true);
  assert.equal(h.element('photoInput').disabled, true, 'media controls stay disabled while the owner changes');
  assert.equal(await h.run('loadMediaCapabilities()'), false, 'archive navigation cannot re-enable controls mid-switch');
  assert.equal(h.element('audioUploadInput').disabled, true);

  pause.resolve();
  assert.equal(await switching, true);
  assert.equal(h.run('activeHealthSubjectId'), familyId);
  assert.equal(h.run('healthSubjectChanged'), false);
  assert.equal(h.element('photoInput').disabled, false, 'the new owner receives fresh capabilities');

  releaseOldSubjectRead.resolve();
  assert.equal(await staleSubjectRead, false);
  assert.equal(h.run('healthSubjectChanged'), false, 'a late old-owner registry result is not a peer-page conflict');
  assert.equal(h.run('activeHealthSubjectId'), familyId);

  releaseOldCapability.resolve();
  assert.equal(await staleCapabilities, false);
  assert.equal(h.run('healthSubjectChanged'), false, 'a late 403 from the old owner is not a peer-tab conflict');
  assert.equal(h.run('activeHealthSubjectId'), familyId);
  assert.equal(h.element('photoInput').disabled, false, 'a stale response cannot disable or replace the new owner state');
});

test('subject switch clears stale archive status and ignores a delayed old-owner record response', async () => {
  const local = await localStoreBridge();
  const h = harness({ healthLocal: local, captureBootstrap: true });
  await settleBootstrap(h);
  h.run('renderList=()=>{}');
  assert.equal(await h.run('loadHealthSubjects()'), true);
  assert.equal(h.run('healthSubjectLoaded'), true);

  const saved = await h.context.api('/api/events', { method: 'POST', body: JSON.stringify({
    raw_text: '虚构本人记录，仅用于所属人切换回归', source_kind: 'elder',
  }) });
  assert.equal(saved.r.ok, true);
  assert.equal(await h.run('loadEvents()'), true);
  assert.equal(h.element('archiveEventCount').textContent, 1);

  h.element('newHealthSubjectLabel').value = '虚构家属·归档切换回归';
  assert.equal(await h.run('createHealthSubject()'), true);
  const familyId = h.run('healthSubjects.find(subject => subject.relationship === "family").subject_id');
  assert.ok(familyId);

  const originalRequest = local.request.bind(local), eventsStarted = deferred(), releaseEvents = deferred();
  const mediaStarted = deferred(), releaseMedia = deferred();
  let holdNextSelfEvents = true, holdNextSelfMedia = true;
  local.request = async (path, options = {}) => {
    const result = await originalRequest(path, options);
    if (path === '/api/events' && (options.method || 'GET') === 'GET' && holdNextSelfEvents) {
      holdNextSelfEvents = false;
      eventsStarted.resolve({ result, subjectId: options.headers?.['X-Health-Subject-Id'] });
      await releaseEvents.promise;
    }
    if (path === '/api/media' && (options.method || 'GET') === 'GET' && holdNextSelfMedia) {
      holdNextSelfMedia = false;
      mediaStarted.resolve({ result, subjectId: options.headers?.['X-Health-Subject-Id'] });
      await releaseMedia.promise;
      return { ...result, j: { ...result.j, media: [{ media_id: 'synthetic_old_owner_photo', kind: 'image', original_filename: 'old-owner.png', save_status: 'saved', recognition_status: 'not_started', link_status: 'not_linked' }] } };
    }
    return result;
  };
  const staleLoad = h.run('loadEvents()');
  const staleMediaLoad = h.run('loadMedia()');
  const [delayed, delayedMedia] = await Promise.all([eventsStarted.promise, mediaStarted.promise]);
  assert.equal(delayed.subjectId, 'subject_self');
  assert.equal(delayed.result.j.events.length, 1);
  assert.equal(delayedMedia.subjectId, 'subject_self');

  h.element('archiveEventCount').textContent = '77';
  h.element('archivePhotoCount').textContent = '6';
  h.element('mediaStatus').textContent = '旧所属人的录音状态';
  h.element('photoStatus').textContent = '旧所属人的照片状态';
  assert.equal(await h.run(`activateHealthSubject(${JSON.stringify(familyId)})`), true);
  assert.equal(h.run('activeHealthSubjectId'), familyId);
  assert.equal(h.element('archiveEventCount').textContent, 0);
  assert.equal(h.element('archivePhotoCount').textContent, 0);
  assert.equal(h.element('mediaStatus').textContent, '');
  assert.equal(h.element('photoStatus').textContent, '');
  assert.match(h.element('archiveEvents').innerHTML, /还没有健康记录/);
  assert.match(h.element('archivePhotos').innerHTML, /还没有上传原件/);

  releaseEvents.resolve();
  releaseMedia.resolve();
  assert.equal(await staleLoad, false);
  assert.equal(await staleMediaLoad, false);
  assert.equal(h.run('activeHealthSubjectId'), familyId);
  assert.equal(h.element('archiveEventCount').textContent, 0);
  assert.equal(h.element('archivePhotoCount').textContent, 0);
  assert.deepEqual(h.run('mediaItems'), []);
  assert.doesNotMatch(h.element('archiveEvents').innerHTML, /虚构本人记录/);
});

test('same-owner subject-registry version changes discard late media capabilities', async () => {
  const h = harness(), local = await localStoreBridge();
  h.context.HealthLocal = local;
  h.run('localMode=true; api=productionApi; healthSubjectLoaded=false; healthSubjectChanged=false; healthSubjectSwitchBusy=false');
  assert.equal(await h.run('loadHealthSubjects()'), true);
  h.element('newHealthSubjectLabel').value = '虚构家属·版本一';
  assert.equal(await h.run('createHealthSubject()'), true);
  assert.equal(await h.run('loadMediaCapabilities()'), true);
  const originalRequest = local.request.bind(local), capabilityStarted = deferred(), releaseOldCapability = deferred();
  let holdNextCapability = true;
  local.request = async (path, options) => {
    if (path === '/api/media/capabilities' && holdNextCapability) {
      holdNextCapability = false; capabilityStarted.resolve(); await releaseOldCapability.promise;
    }
    return originalRequest(path, options);
  };
  const oldVersion = h.run('healthSubjectsVersion'), staleCapabilities = h.run('loadMediaCapabilities()');
  await capabilityStarted.promise;
  h.element('newHealthSubjectLabel').value = '虚构家属·版本二';
  assert.equal(await h.run('createHealthSubject()'), true);
  assert.equal(h.run('activeHealthSubjectId'), 'subject_self', 'the current person stays selected');
  assert.ok(h.run('healthSubjectsVersion') > oldVersion);
  assert.equal(h.element('photoInput').disabled, true, 'version refresh invalidates previously authorized controls');
  assert.equal(await h.run('loadMediaCapabilities()'), true);
  assert.equal(h.element('photoInput').disabled, false);

  releaseOldCapability.resolve();
  assert.equal(await staleCapabilities, false);
  assert.equal(h.run('healthSubjectChanged'), false);
  assert.equal(h.run('activeHealthSubjectId'), 'subject_self');
  assert.equal(h.element('photoInput').disabled, false, 'late old-version response cannot overwrite the refreshed state');
});

test('a real local owner mismatch still disables media and blocks memory writes', async () => {
  const h = harness(), local = await localStoreBridge();
  h.context.HealthLocal = local;
  h.run('localMode=true; api=productionApi; healthSubjectLoaded=false; healthSubjectChanged=false; healthSubjectSwitchBusy=false');
  assert.equal(await h.run('loadHealthSubjects()'), true);
  h.element('newHealthSubjectLabel').value = '虚构家属·外部切换';
  assert.equal(await h.run('createHealthSubject()'), true);
  assert.equal(await h.run('loadMediaCapabilities()'), true);
  const active = await local.request('/api/health-subjects/active', { method: 'POST', body: JSON.stringify({
    subject_id: h.run('healthSubjects.find(subject=>subject.relationship==="family").subject_id'),
    expected_version: h.run('healthSubjectsVersion'),
  }) });
  assert.equal(active.r.status, 200);
  assert.equal(await h.run('loadHealthSubjects()'), false);
  assert.equal(h.run('healthSubjectChanged'), true);
  assert.equal(h.element('photoInput').disabled, true);
  h.element('healthMemoryText').value = '合成测试：冲突时不提交';
  let memoryWrites = 0;
  const originalRequest = local.request.bind(local);
  local.request = async (path, options) => {
    if (path === '/api/health-memory' && options.method === 'POST') memoryWrites++;
    return originalRequest(path, options);
  };
  assert.equal(await h.run('saveHealthMemory()'), false);
  assert.equal(memoryWrites, 0, 'the peer-page conflict prevents writes');
  assert.equal(h.element('healthMemoryText').value, '合成测试：冲突时不提交');
});

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

test('archive media distinguishes unreadable from silent audio and keeps originals without futile retry', async () => {
  const h = harness(), failures = new Map();
  for (const [index, code] of ['invalid_media', 'no_text_detected'].entries()) {
    const media = { ...saved(), media_id: `media_${index}`, recognition_status: 'failed',
      recognition: { text: '', error: { code, retryable: false }, error_message: code } };
    failures.set(media.media_id, media);
    h.context.currentFailure = media;
    await h.run('showVoiceMediaResult(currentFailure)');
    const voiceMessage = code === 'invalid_media'
      ? /录音文件无法读取，请重新选有效录音，原件保留/
      : /没有录到可用声音，请重新录音/;
    assert.match(h.element('voiceConversationStatus').textContent, voiceMessage);
    assert.match(h.element('voiceConversationStatus').textContent, /原件(?:保留|仍可查看)/);
    assert.equal(h.requests.some(request => request.route.endsWith('/turns')), false);

    h.context.currentFailure = media;
    h.run('mediaItems=[currentFailure];renderMedia();showRecognition(currentFailure)');
    const archive = h.element('archivePhotos').innerHTML;
    const expected = code === 'invalid_media'
      ? /录音文件无法读取，请重新选有效录音，原件保留/
      : /没有可识别的声音，请重新录音/;
    assert.match(archive, expected);
    assert.match(archive, /data-original=/, 'the saved original remains available');
    assert.doesNotMatch(archive, /data-recognize=/, 'a terminal empty/invalid file is not offered as a futile retry');
    assert.match(h.element(`media-${media.media_id}:.media-result`).innerHTML, expected);

    h.setApi(async route => route === '/api/media'
      ? { r: { ok: true }, j: { media: [...failures.values()] } }
      : failures.has(route.split('/').at(-1))
        ? { r: { ok: true }, j: { media: failures.get(route.split('/').at(-1)) } }
        : { r: { ok: false, status: 404 }, j: { error: 'not_found' } });
    const recognized = await h.run(`recognizeMedia(${JSON.stringify(media.media_id)})`);
    assert.equal(recognized.recognition.error.code, code);
    assert.equal(h.requests.some(request => request.route.endsWith('/recognize')), false);
    assert.match(h.element(`media-${media.media_id}:.media-result`).innerHTML, expected);
    assert.match(h.element('archivePhotos').innerHTML, /data-original=/);
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

test('empty and over-limit uploads explain why nothing was saved and allow the normal path afterward', async () => {
  const h = harness();
  const maxBytes = 10 * 1024 * 1024 - 1024;
  let uploadCreates = 0, uploadedPart = false, completed = false, recognizeCalls = 0;
  const media = saved();
  h.setApi(async (route, options) => {
    if (route === '/api/media/capabilities') return { r: { ok: true }, j: { capabilities: {
      enabled: true, audio_content_types: ['audio/webm'], image_content_types: ['image/png'],
      max_total_bytes: maxBytes, max_part_bytes: 1024, max_parts: 4,
    } } };
    if (route === '/api/media/uploads') {
      uploadCreates++;
      return { r: { ok: true }, j: { upload: { media_id: 'media_test', upload_id: 'upload_test' } } };
    }
    if (route === '/api/media/uploads/upload_test/parts/0') {
      uploadedPart = true;
      assert.equal(await options.body.get('file').text(), 'valid audio');
      return { r: { ok: true }, j: { created: true } };
    }
    if (route === '/api/media/uploads/upload_test/complete') {
      completed = true;
      return { r: { ok: true }, j: { media } };
    }
    if (route === '/api/media') return { r: { ok: true }, j: { media: [] } };
    throw new Error('unexpected media request: ' + route);
  });
  h.context.captureRecognition = async id => { assert.equal(id, 'media_test'); recognizeCalls++; };
  h.run('recognizeMedia=captureRecognition');
  const select = async file => {
    const target = { files: [file], value: 'selected' };
    await h.element('audioUploadInput').onchange({ target });
    assert.equal(target.value, '');
  };

  await select(new Blob([], { type: 'audio/webm' }));
  assert.match(h.element('mediaStatus').textContent, /文件是空的/);
  assert.match(h.element('mediaStatus').textContent, /尚未保存/);
  assert.equal(uploadCreates, 0);
  assert.equal(h.requests.some(request => request.route === '/api/media/uploads'), false);
  assert.equal(recognizeCalls, 0);
  assert.equal(h.run('uploadBusy'), false);

  await select(new Blob([new Uint8Array(maxBytes + 1)], { type: 'audio/webm' }));
  assert.match(h.element('mediaStatus').textContent, /超过当前上限/);
  assert.match(h.element('mediaStatus').textContent, /9\.99 MB/);
  assert.match(h.element('mediaStatus').textContent, /尚未保存/);
  assert.match(h.element('mediaStatus').textContent, /选择较小/);
  assert.equal(uploadCreates, 0);
  assert.equal(h.requests.some(request => request.route === '/api/media/uploads'), false);
  assert.equal(recognizeCalls, 0);
  assert.equal(h.run('uploadBusy'), false);

  await select(new Blob(['valid audio'], { type: 'audio/webm' }));
  assert.equal(uploadCreates, 1);
  assert.equal(uploadedPart, true);
  assert.equal(completed, true);
  assert.equal(recognizeCalls, 1);
  assert.equal(h.run('uploadBusy'), false);
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
  const h = harness();h.context.HealthSafety=safety;
  const safetyResult = { danger_detected: true, danger_reminder: '顶层危险提醒：请联系专业人员。' };
  const states = [
    saved(),
    { ...saved(), recognition_status: 'succeeded', link_status: 'pending', link_pending_reason: 'safety_scan_pending' },
    { ...saved(), recognition_status: 'succeeded', link_status: 'pending', link_pending_reason: 'event_link_pending' },
    { ...saved(), recognition_status: 'succeeded', link_status: 'linked', event_link: { record_id: 'rec_test' }, local_safety: safetyResult,
      recognition: { text: '已识别文字', is_mock: false, local_safety: { danger_detected: false } } },
  ];
  let reads = 0, posts = 0;
  h.setApi(async (route, options) => {
    if (route === '/api/media') return { r: { ok: true }, j: { media: [states[Math.min(reads, states.length - 1)]] } };
    if (route === '/api/events') return { r: { ok: true }, j: { events: [{ record_id: 'rec_test', subject_id: 'subject_self', source_kind: 'audio_transcript', raw_text: '已识别文字', state: 'inbox', version: 1 }] } };
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
  assert.equal(result.children.find(child=>child.textContent==='核对当前文字')?.textContent, '核对当前文字');
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

test('legacy pending or already-linked audio always opens source review instead of reposting a turn', async () => {
  const h = harness();
  const pending = { ...saved(), kind:'audio',media_id:'media_test',record_id:'record_test',temporary: true, conversation_id: 'conversation_test',
    recognition_status: 'succeeded', link_pending_reason: 'conversation_link_pending',
    recognition: { text: '今天有些头晕。', is_mock: false } };
  const reviewedPanel=[];h.context.presentAudioReview=async media=>{reviewedPanel.push(media.media_id);h.context.pendingAudioReview={media_id:media.media_id};return true};
  h.run("activeConversation={conversation_id:'conversation_test',version:2,turns:[]}");
  h.context.testPending=pending;h.context.testLinked={...pending,conversation_turn_id:'turn_00000001',link_pending_reason:null};
  await h.run('showVoiceMediaResult(testPending)');
  await h.run('showVoiceMediaResult(testLinked)');
  assert.deepEqual(reviewedPanel,['media_test','media_test']);
  assert.equal(h.requests.filter(request => request.route.endsWith('/turns')).length, 0);
  assert.equal(h.requests.filter(request => request.route.endsWith('/pause')).length, 0, 'showing ASR text leaves time to compare the original before explicit pause');
  assert.equal(h.context.pendingAudioReview.media_id,'media_test');
});

test('legacy terminal conversation-link failure is held for source review rather than retried automatically', async () => {
  const h = harness();
  const failedLink = { ...saved(), kind:'audio',media_id:'media_test',temporary: true, conversation_id: 'conversation_test', record_id: 'record_test',
    recognition_status: 'succeeded', conversation_link_error: 'conversation_link_interrupted',
    recognition: { text: '今天有些头晕。', is_mock: false } };
  let shown=false;h.context.presentAudioReview=async()=>{shown=true;return true};
  h.run("activeConversation={conversation_id:'conversation_test',version:3,turns:[]}");
  h.element('voiceTextInput').value = '';
  h.context.failedLink = failedLink;
  await h.run('showVoiceMediaResult(failedLink)');
  assert.equal(shown,true);assert.equal(h.element('voiceTextInput').value,'');
  assert.equal(h.requests.some(request=>request.route.endsWith('/turns')),false);
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

test('audio archive card and expanded result follow the reviewed current revision while preserving first ASR', async () => {
  const h=harness(),fixture=reviewedAudioFixture();h.context.HealthSafety=safety;h.context.reviewMedia=fixture.media;h.context.reviewEvents=fixture.events;
  h.setApi(async route=>route==='/api/events'?{r:{ok:true},j:{events:fixture.events}}:route==='/api/media/media_reviewed_audio'?{r:{ok:true},j:{media:fixture.media}}:{r:{ok:true},j:{media:[]}});
  h.run('mediaItems=[reviewMedia];renderMedia(reviewEvents);showRecognition(reviewMedia,reviewEvents)');
  const card=h.element('archivePhotos').innerHTML,detail=h.element('media-media_reviewed_audio:.media-result');
  assert.match(card,/当前录音文字已核对（非医学确认）/);
  assert.doesNotMatch(card,/文字已识别，待核对|当前文字待核对/);
  assert.match(detail.innerHTML,/当前录音文字已核对（非医学确认）/);
  assert.match(detail.innerHTML,/首次机器识别（修订前，仅作历史参考）/);
  assert.match(detail.innerHTML,/我咳嗽两天了，晚上更明显。/);
  assert.match(detail.innerHTML,/我咳嗽两天了，晚上明显些。/);
  h.run("showView=()=>{};showDetail=recordId=>{routedRecordId=recordId}");
  const button=detail.children.find(child=>child.textContent==='查看当前记录');assert.ok(button);
  await button.onclick();assert.equal(h.run('routedRecordId'),'rec_audio_current');
});

test('audio review status fails closed for unreviewed, branched, missing, read-failed and cross-owner chains', () => {
  const h=harness(),base=reviewedAudioFixture();h.context.HealthSafety=safety;h.context.reviewMedia=base.media;
  const branched=[...base.events,{...base.current,record_id:'rec_audio_branch',raw_text:'另一条修订',source_review:null}];
  const crossOwner=[base.root,{...base.current,subject_id:'subject_family'}];
  h.context.unreviewedEvents=reviewedAudioFixture({reviewed:false}).events;
  const staleReceipt=reviewedAudioFixture().events.map(event=>event.record_id==='rec_audio_current'?{...event,source_review:{...event.source_review,text:'过期核对文字'}}:event);
  h.context.branchedEvents=branched;h.context.crossOwnerEvents=crossOwner;h.context.missingEvents=[];
  h.context.staleReceiptEvents=staleReceipt;
  assert.equal(h.run("audioReviewDisplay(reviewMedia,unreviewedEvents).state"),'pending');
  assert.equal(h.run("audioReviewDisplay(reviewMedia,staleReceiptEvents).state"),'pending');
  assert.equal(h.run("audioReviewDisplay(reviewMedia,branchedEvents).state"),'unknown');
  assert.equal(h.run("audioReviewDisplay(reviewMedia,crossOwnerEvents).state"),'unknown');
  assert.equal(h.run("audioReviewDisplay(reviewMedia,missingEvents).state"),'unknown');
  assert.equal(h.run("audioReviewDisplay(reviewMedia,null).state"),'unknown');
  h.run('mediaItems=[reviewMedia];renderMedia(null)');
  assert.match(h.element('archivePhotos').innerHTML,/状态暂不可确认/);
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
