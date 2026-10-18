// Controlled DOM/network regressions; these do not establish real-provider or
// physical-browser acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const event = (overrides = {}) => ({
  record_id: 'rec_test', raw_text: '原先保存的原话', state: 'inbox', version: 1,
  recorded_at: '2026-09-13T08:00:00Z', draft: null,
  local_safety: { danger_detected: false }, ...overrides,
});

async function harness(initial) {
  const elements = new Map(), calls = [];
  let respond = async () => { throw new Error('offline'); };
  const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(['detail', 'dangerBanner'].includes(id) ? ['hidden'] : []);
      const el = {
        id, textContent: '', value: '', disabled: false, dataset: {}, children: [],
        classList: {
          toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
          add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); },
        },
        querySelector() { return element(id + ':span'); }, querySelectorAll() { return []; },
        addEventListener() {}, scrollIntoView() {},
      };
      let html = '';
      Object.defineProperty(el, 'innerHTML', {
        get() { return html; },
        set(value) {
          for (const child of el.children) elements.delete(child);
          el.children = []; html = value;
          for (const match of value.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
            const child = element(match[2]); el.children.push(match[2]);
            child.disabled = /\bdisabled\b/.test(match[0]);
            if (match[1] === 'textarea') child.value = decode(value.slice(match.index + match[0].length).split('</textarea>')[0]);
            if (match[1] === 'button') child.textContent = value.slice(match.index + match[0].length).split('</button>')[0];
          }
        },
      });
      elements.set(id, el);
    }
    return elements.get(id);
  }
  for (const id of ['modePill', 'toast', 'homeRecent', 'eventsList', 'archiveEvents', 'detail', 'dangerBanner', 'recordBtn', 'saveBtn', 'refreshBtn', 'handoffBtn', 'rawText']) element(id);
  const context = vm.createContext({
    console, FormData, URL,
    location: { hostname: 'localhost', port: '18768' },
    document: { getElementById: id => elements.get(id) || null, querySelectorAll: () => [] },
    window: { scrollTo() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/health') return { ok: true, status: 200, json: async () => ({ ok: true, session_token: 'synthetic-token', provider: 'mock' }) };
      return respond(url, options);
    },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 2; }, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  respond = async () => ({ ok: true, status: 200, json: async () => ({ event: initial }) });
  await vm.runInContext(`showDetail('${initial.record_id}')`, context);
  calls.length = 0;
  return {
    element: id => elements.get(id) || null, calls,
    run: code => vm.runInContext(code, context),
    setResponse(fn) { respond = fn; },
    click: id => elements.get(id).onclick(),
  };
}

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('422 response renders saved original and safety without a successful follow-up GET, and can retry', async () => {
  const h = await harness(event({ state: 'needs_review', version: 4, draft: { note: '过期草稿' } }));
  const saved = event({ raw_text: '胸口疼，喘不上气 <保留原字>', version: 5 });
  const safety = { danger_detected: true, danger_reminder: '请联系当地急救服务，不要自行改药。' };
  h.setResponse(async (url) => {
    if (url.endsWith('/organize')) return response(422, { event: saved, local_safety: safety, failure_reason: '模型超时' });
    throw new Error('follow-up GET offline');
  });
  await h.click('organizeBtn');
  assert.match(h.element('detail').innerHTML, /胸口疼，喘不上气 &lt;保留原字&gt;/);
  assert.doesNotMatch(h.element('detail').innerHTML, /过期草稿/);
  assert.match(h.element('detail').innerHTML, /请联系当地急救服务/);
  assert.equal(h.element('dangerBanner').classList.contains('hidden'), false);
  assert.match(h.element('dangerBanner').innerHTML, /不要自行改药/);
  assert.match(h.element('organizeStatus').textContent, /原话已保存，AI 整理失败：模型超时/);
  assert.equal(h.element('organizeBtn').disabled, false);
  assert.equal(h.element('reviewBtn'), null);
  assert.equal(h.calls.filter(call => call.url === '/api/events/rec_test').length, 0);
  h.setResponse(async (url) => {
    if (url.endsWith('/organize')) return response(200, { event: { ...saved, local_safety: safety, state: 'draft', version: 6, draft: { note: '新的整理草稿' } } });
    throw new Error('list GET offline');
  });
  await h.click('organizeBtn');
  const posts = h.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[1].options.body).expected_version, 5);
  assert.match(h.element('detail').innerHTML, /新的整理草稿/);
  assert.equal(h.element('reviewBtn').disabled, false);
  assert.equal(h.run('current.version'), 6);
});

test('422 retained prior draft is labelled as old and does not offer confirmation of a new result', async () => {
  const saved = event({ state: 'needs_review', version: 4, draft: { note: '以前的草稿仍保留' } });
  const h = await harness(saved);
  h.setResponse(async url => {
    if (url.endsWith('/organize')) return response(422, { event: saved, failure_reason: '校验失败' });
    throw new Error('offline');
  });
  await h.click('organizeBtn');
  assert.match(h.element('detail').innerHTML, /上次整理草稿（本次整理失败，未更新）/);
  assert.match(h.element('detail').innerHTML, /以前的草稿仍保留/);
  assert.equal(h.element('reviewBtn'), null);
  assert.equal(h.element('organizeBtn').disabled, false);
});

test('422 with an existing draft state offers retry rather than confirming a failed new result', async () => {
  const saved = event({ state: 'draft', version: 2, draft: { note: '上一次成功结果' } });
  const h = await harness(event());
  h.setResponse(async url => {
    if (url.endsWith('/organize')) return response(422, { event: saved, failure_reason: '超时' });
    throw new Error('offline');
  });
  await h.click('organizeBtn');
  assert.equal(h.element('reviewBtn'), null);
  assert.equal(h.element('organizeBtn').disabled, false);
  assert.equal(h.run('current.state'), 'draft');
  assert.equal(h.run('current.version'), 2);
  assert.match(h.element('detail').innerHTML, /上次整理草稿（本次整理失败，未更新）/);
});

test('transport failure keeps detail and makes organize retry available', async () => {
  const h = await harness(event());
  h.setResponse(async () => { throw new Error('offline'); });
  await h.click('organizeBtn');
  assert.match(h.element('detail').innerHTML, /原先保存的原话/);
  assert.equal(h.element('organizeBtn').disabled, false);
  assert.equal(h.element('organizeBtn').textContent, '整理记录');
});

test('revision double click sends one request; failure preserves edits and reenables retry', async () => {
  const h = await harness(event());
  await h.click('reviseBtn');
  h.element('revText').value = '修改后的原话'; h.element('revReason').value = '修正输入';
  let finish;
  h.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.click('submitRev');
  assert.equal(h.element('submitRev').disabled, true);
  assert.equal(h.element('submitRev').textContent, '保存中…');
  await h.click('submitRev');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 1);
  finish(response(409, { error: 'stale_version' }));
  await pending;
  assert.equal(h.element('revText').value, '修改后的原话');
  assert.equal(h.element('revReason').value, '修正输入');
  assert.equal(h.element('submitRev').disabled, false);
  assert.equal(h.element('submitRev').textContent, '保存修订');
  assert.match(h.element('reviseStatus').textContent, /输入已保留/);
});

test('revision network failure retains both inputs and permits retry', async () => {
  const h = await harness(event());
  await h.click('reviseBtn');
  h.element('revText').value = '仍未确认保存的修订'; h.element('revReason').value = '待补充说明';
  h.setResponse(async () => { throw new Error('offline'); });
  await h.click('submitRev');
  assert.equal(h.element('revText').value, '仍未确认保存的修订');
  assert.equal(h.element('revReason').value, '待补充说明');
  assert.equal(h.element('submitRev').disabled, false);
  assert.match(h.element('reviseStatus').textContent, /未保存成功，输入已保留/);
  await h.click('submitRev');
  assert.equal(h.calls.filter(call => call.options.method === 'POST').length, 2);
});

test('successful revision displays its returned new record even if list refresh is offline', async () => {
  const h = await harness(event());
  await h.click('reviseBtn');
  h.element('revText').value = '新版本原文'; h.element('revReason').value = '补充';
  h.setResponse(async (url) => {
    if (url.endsWith('/revise')) return response(201, { event: event({ record_id: 'rec_revision', raw_text: '新版本原文', supersedes_id: 'rec_test' }) });
    throw new Error('list offline');
  });
  await h.click('submitRev');
  assert.match(h.element('detail').innerHTML, /新版本原文/);
  assert.match(h.element('detail').innerHTML, /查看修订前原文/);
  assert.equal(h.run('current.record_id'), 'rec_revision');
});

test('organized detail renders a readable Chinese card instead of raw model JSON', async () => {
  const readable = {
    schema_version: 'event-v0.3', event_kind: 'symptom',
    summary: '今天脚疼，还有点红，走路的时候更疼。',
    time: { occurred: null, recorded: '2026-09-13T08:00:00Z', certainty: 'relative' },
    claims: [{ text: '今天脚疼，还有点红，走路的时候更疼。', source_kind: 'elder', record_id: 'rec_test', quote: '今天脚疼，还有点红，走路的时候更疼。' }],
    review_required: true, review_role: 'clinician_or_pharmacist', escalation_level: 'none',
    conflict: { present: false, record_refs: [] }, provenance_preserved: true,
    plan_change_allowed: false, follow_up_questions: ['请补充发生时间和可核验证据。'], forbidden_actions: [],
  };
  const h = await harness(event({ raw_text: readable.raw_text, state: 'draft', version: 2, draft: readable }));
  const html = h.element('detail').innerHTML;
  assert.match(html, /记录类型/);
  assert.match(html, /症状记录/);
  assert.match(html, /需要谁核对/);
  assert.match(html, /医生、护士或药师/);
  assert.match(html, /待核对问题/);
  assert.doesNotMatch(html, /"schema_version"/);
  assert.doesNotMatch(html, /"claims"/);
});
