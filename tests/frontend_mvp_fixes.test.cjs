// Focused browser-state regressions for the MVP integration fixes. These
// tests exercise the zero-dependency frontend with a controlled DOM; they do
// not claim microphone, camera, or provider acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, randomUUID } = require('node:crypto');
const { test } = require('node:test');

const frontend = path.join(__dirname, '../frontend');

function harness({ media = false } = {}) {
  const elements = new Map();
  let response = async route => {
    if (route === '/api/media/capabilities') return { r: { ok: true, status: 200 }, j: { capabilities: { enabled: true, disabled_reason: null } } };
    if (route === '/api/media') return { r: { ok: true, status: 200 }, j: { media: [] } };
    return { r: { ok: true, status: 200 }, j: { event: { record_id: 'rec_test', raw_text: '测试', version: 1 } } };
  };
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const attributes = new Map();
      const el = {
        id, value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, style: {}, children: [], attributes,
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains(name) { return classes.has(name); },
          toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        },
        querySelector(selector) { return element(`${id}:${selector}`); },
        querySelectorAll() { return []; },
        addEventListener() {},
        scrollIntoView() {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
      };
      elements.set(id, el);
    }
    return elements.get(id);
  }
  const context = vm.createContext({
    console, Blob, FormData, URL,
    crypto: { subtle: webcrypto.subtle, randomUUID },
    location: { hostname: 'localhost', port: '5173' },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    document: { getElementById: element, querySelectorAll: () => [], createElement: tag => element(`new-${tag}-${Math.random()}`) },
    window: { scrollTo() {}, addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, session_token: 'test', provider: 'mock', events: [] }) }),
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
  });
  const run = code => vm.runInContext(code, context);
  run(fs.readFileSync(path.join(frontend, 'app.js'), 'utf8'));
  context.testApi = async (route, options = {}) => response(route, options);
  // Keep startup work deterministic. The production code still performs the
  // same health/capability calls; this harness only avoids network races.
  run('api=testApi; health=async()=>true; loadEvents=async()=>{};');
  if (media) run(fs.readFileSync(path.join(frontend, 'media.js'), 'utf8'));
  return {
    context,
    element,
    run,
    setResponse(fn) { response = fn; },
  };
}

test('health background cannot be edited or saved before the initial read completes', async () => {
  const h = harness();
  let release;
  h.setResponse(() => new Promise(resolve => { release = resolve; }));
  h.run('localMode=true');
  const loading = h.run('loadHealthContext()');
  assert.equal(h.element('healthConditions').disabled, true);
  assert.equal(h.element('saveHealthContextBtn').disabled, true);
  release({ r: { ok: true }, j: { health_context: { entries: [] } } });
  await loading;
  assert.equal(h.element('healthConditions').disabled, false);
  assert.equal(h.element('saveHealthContextBtn').disabled, false);
});

test('an organize reply after leaving detail cannot reopen the old record', async () => {
  const h = harness();
  let release;
  h.setResponse(() => new Promise(resolve => { release = resolve; }));
  h.run("current={record_id:'rec_test',version:1};detailRequestSerial=10");
  const pending = h.run("organize(current)");
  h.run("showView('homeView')");
  release({ r: { ok: true, status: 200 }, j: { event: { record_id: 'rec_test', raw_text: '虚构旧详情', version: 2, state: 'draft' } } });
  await pending;
  assert.equal(h.run('current'), null);
  assert.equal(h.element('detail').classList.contains('hidden'), true);
});

test('a review reply after leaving detail does not force navigation back', async () => {
  const h = harness();
  let release;
  h.setResponse(() => new Promise(resolve => { release = resolve; }));
  h.run("current={record_id:'rec_test',version:2};detailRequestSerial=10;showDetail=async()=>{current={record_id:'rec_test'}}");
  const pending = h.run("review(current)");
  h.run("showView('homeView')");
  release({ r: { ok: true, status: 200 }, j: {} });
  await pending;
  assert.equal(h.run('current'), null);
});

test('late related history cannot render an older version over a newer draft', async () => {
  const h = harness();
  let release;
  h.setResponse(() => new Promise(resolve => { release = resolve; }));
  h.run("current={record_id:'rec_test',version:1,related_record_ids:['rec_other']};detailRequestSerial=10");
  const pending = h.run('loadRelatedHistory(current)');
  h.run("current={record_id:'rec_test',version:2,state:'draft',raw_text:'虚构新版'}");
  release({ r: { ok: true, status: 200 }, j: { event: { record_id: 'rec_other', raw_text: '虚构相关记录' } } });
  await pending;
  assert.equal(h.run('current.version'), 2);
});

test('document OCR remains a reviewable transcription rather than a promise of exact original text', () => {
  const h = harness();
  const html = h.run("detailHtml({source_kind:'document',raw_text:'HEB 130',state:'draft',draft:{summary:'检验表'}})");
  assert.match(html, /资料文字（请对照原件）/);
  assert.match(html, /核对前不会用于 AI 整理、事实或交接正文/);
  assert.doesNotMatch(html, /id="organizeBtn"|id="reviewBtn"|整理摘要/);
  assert.doesNotMatch(html, /AI 只做分类和归档，没有改写原文/);
  assert.match(html, /HEB 130/);
});

test('text and voice share the same resumable conversation behavior', () => {
  const markup = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
  assert.match(markup, /打字说，或者点麦克风/);
  assert.match(markup, /退出也会自动留下报告/);
  assert.match(app, /submitConversationText/);
  assert.match(app, /source_kind:extra\.source_kind\|\|'elder'/);
  assert.match(app, /\/api\/conversations\/\$\{encodeURIComponent\(activeConversation\.conversation_id\)\}\/turns/);
});

test('a saved elder turn without an assistant reply is resumed automatically', async () => {
  const h = harness();
  const pending = {
    conversation_id: 'conversation_resume_test', version: 2,
    turns: [
      { turn_id: 'turn_assistant_open', role: 'assistant', text: '您今天最难受的是什么？', action: 'ask' },
      { turn_id: 'turn_elder_leg', role: 'elder', text: '测试用：左腿疼得伸不直。', version: 1 },
    ],
    report: { report_id: 'report_test', status_label: '自动整理 · 本人未核对', source_turn_ids: ['turn_elder_leg'], body: '老人原话' },
  };
  const recovered = {
    ...pending, version: 3,
    turns: [...pending.turns, { turn_id: 'turn_assistant_followup', role: 'assistant', text: '这种不舒服大概什么时候开始的，后来有什么变化？', action: 'ask' }],
  };
  const calls = [];
  h.setResponse(async route => {
    calls.push(route);
    if (route.startsWith('/api/conversations/current?')) return { r: { ok: true, status: 200 }, j: { conversation: pending, resume_choice_required: false } };
    if (route.endsWith('/resume-assistant')) return { r: { ok: true, status: 200 }, j: { conversation: recovered, recovered: true, ai_failed: false } };
    return { r: { ok: true, status: 200 }, j: {} };
  });

  await h.run('conversationLoading=false;activeConversation=null;loadConversation()');

  assert.ok(calls.some(route => route.endsWith('/resume-assistant')));
  assert.equal(h.run('activeConversation.turns.at(-1).text'), '这种不舒服大概什么时候开始的，后来有什么变化？');
  assert.match(h.element('voiceConversationStatus').textContent, /已经接上刚才的话/);
});

test('event recents and media archive order newest first while retaining superseded filtering', () => {
  const h = harness({ media: true });
  const events = [
    { record_id: 'old', raw_text: '旧记录', state: 'inbox', recorded_at: '2026-09-12T10:00:00Z' },
    { record_id: 'replacement', raw_text: '新版本', state: 'recorded', recorded_at: '2026-09-13T10:00:00Z' },
    { record_id: 'superseded', raw_text: '历史旧版本', state: 'superseded', recorded_at: '2026-09-14T10:00:00Z' },
  ];
  h.run(`events=${JSON.stringify(events)};renderHome();renderArchive();`);
  const home = h.element('homeRecent').innerHTML;
  const archive = h.element('archiveEvents').innerHTML;
  assert.ok(home.indexOf('新版本') < home.indexOf('旧记录'));
  assert.ok(archive.indexOf('新版本') < archive.indexOf('旧记录'));
  assert.doesNotMatch(home, /历史旧版本/);
  assert.doesNotMatch(archive, /历史旧版本/);

  const media = [
    { media_id: 'm-old', kind: 'image', created_at: '2026-09-12T10:00:00Z', save_status: 'saved', recognition_status: 'not_started' },
    { media_id: 'm-new', kind: 'image', created_at: '2026-09-13T10:00:00Z', save_status: 'saved', recognition_status: 'not_started' },
  ];
  h.run(`mediaItems=${JSON.stringify(media)};renderMedia();`);
  const mediaHtml = h.element('archivePhotos').innerHTML;
  assert.ok(mediaHtml.indexOf('m-new') < mediaHtml.indexOf('m-old'));
});

test('disabled media capabilities disable upload controls and explain the state', () => {
  const h = harness({ media: true });
  h.run("setMediaCapability({enabled:false,disabled_reason:'media_limits_not_configured'});");
  assert.equal(h.element('photoInput').disabled, true);
  assert.equal(h.element('audioUploadInput').disabled, true);
  assert.equal(h.element('savePhotoBtn').disabled, true);
  assert.equal(h.element('photoUploadLabel').getAttribute('aria-disabled'), 'true');
  assert.equal(h.element('audioUploadLabel').getAttribute('aria-disabled'), 'true');
  assert.match(h.element('photoCapabilityStatus').textContent, /未配置媒体资源保护边界/);
  assert.match(h.element('mediaCapabilityStatus').textContent, /媒体上传暂不可用/);
  assert.equal(h.element('savePhotoBtn').classList.contains('hidden'), true);
});

test('navigating away or closing detail clears old detail, handoff, and danger state', () => {
  const h = harness();
  for (const id of ['detail', 'handoff', 'dangerBanner']) {
    h.element(id).classList.remove('hidden');
    h.element(id).innerHTML = `old-${id}`;
  }
  h.run("current={record_id:'old'};showView('homeView');");
  for (const id of ['detail', 'handoff', 'dangerBanner']) {
    assert.equal(h.element(id).classList.contains('hidden'), true, `#${id} should be hidden`);
    assert.equal(h.element(id).innerHTML, '', `#${id} should be cleared`);
  }
  assert.equal(h.run('current'), null);

  for (const id of ['detail', 'handoff', 'dangerBanner']) h.element(id).classList.remove('hidden');
  h.run('closeDetail();');
  for (const id of ['detail', 'handoff', 'dangerBanner']) assert.equal(h.element(id).classList.contains('hidden'), true);
});

test('a non-retryable recognition failure keeps the original but omits retry action', () => {
  const h = harness({ media: true });
  const failed = {
    media_id: 'm-terminal', kind: 'image', original_filename: 'report.png', save_status: 'saved',
    recognition_status: 'failed', recognition: {
      error_message: '不支持的媒体类型或格式', error: { retryable: false }, retryable: false,
    },
  };
  h.run(`mediaItems=[${JSON.stringify(failed)}];renderMedia();`);
  const html = h.element('archivePhotos').innerHTML;
  assert.match(html, /查看原件/);
  assert.match(html, /不可重试/);
  assert.doesNotMatch(html, /data-recognize/);
  assert.doesNotMatch(html, /识别 \/ 重试/);
});

test('reselecting the same photo or audio clears the file input value after retaining bytes', async () => {
  const h = harness({ media: true });
  h.run('setMediaCapability({enabled:true,disabled_reason:null});uploadMedia=async()=>null;');
  const photoInput = h.element('photoInput');
  const audioInput = h.element('audioUploadInput');
  const file = new Blob(['synthetic'], { type: 'image/png' });
  photoInput.files = [file];
  photoInput.value = '/tmp/same.png';
  await photoInput.onchange({ target: photoInput });
  assert.equal(photoInput.value, '');
  audioInput.files = [new Blob(['synthetic'], { type: 'audio/webm' })];
  audioInput.value = '/tmp/same.wav';
  await audioInput.onchange({ target: audioInput });
  assert.equal(audioInput.value, '');
});

test('renamed photos retain original bytes but use the detected image type', async () => {
  const h = harness({ media: true });
  const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3]);
  h.context.renamedPhoto = new Blob([bytes], { type: 'image/jpeg' });
  const retained = await h.run('retainSelectedFile(renamedPhoto)');
  assert.equal(retained.type, 'image/png');
  assert.deepEqual(new Uint8Array(await retained.arrayBuffer()), bytes);
  h.run("mediaMessage('照片原件读取失败，请重新选择')");
  assert.equal(h.element('photoStatus').textContent, '照片原件读取失败，请重新选择');
});
