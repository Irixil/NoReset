const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const PYTHON_CONVERSATION = `
import json, sys
from backend.conversation import CATEGORIES, conversation_turn

def empty_state():
    return {category: {"status": "missing", "summary": "", "evidence_turn_ids": [], "context_ids": []} for category in CATEGORIES}

class ExplicitFakeProvider:
    def complete_json(self, _system, payload):
        turns = payload["turns"]
        latest = turns[-1]
        if "天气" in latest["text"]:
            return {"user_intent": "non_health", "latest_turn_adds_fact": False,
                "reply_text": "好的，我明白了。", "suggested_action": "finish",
                "question_category": None, "question_importance": None, "candidate_question": "",
                "clinical_state": empty_state(), "relevant_context_ids": [], "unknowns": [], "contradictions": []}
        state = empty_state()
        state["main_complaint"] = {"status": "known", "summary": latest["text"],
            "evidence_turn_ids": [latest["turn_id"]], "context_ids": []}
        weather = next((turn for turn in turns if "天气" in turn["text"]), latest)
        onset_source = next((turn for turn in turns if "开始咳嗽" in turn["text"]), weather)
        state["onset_course"] = {"status": "known", "summary": onset_source["text"],
            "evidence_turn_ids": [onset_source["turn_id"]], "context_ids": []}
        return {"user_intent": "health_fact", "latest_turn_adds_fact": True,
            "reply_text": "我记下您刚才说的情况。", "suggested_action": "ask",
            "question_category": "onset_course", "question_importance": "essential",
            "candidate_question": "咳嗽从什么时候开始？", "clinical_state": state,
            "relevant_context_ids": [], "unknowns": [], "contradictions": []}

payload = json.load(sys.stdin)
print(json.dumps(conversation_turn(payload, ExplicitFakeProvider()), ensure_ascii=False))
`;

function pythonConversation(payload) {
  const result = spawnSync('python3', ['-c', PYTHON_CONVERSATION], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', PYTHONPATH: REPO_ROOT, PYTHONDONTWRITEBYTECODE: '1' },
    input: payload,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `python exit ${result.status}`);
  return JSON.parse(result.stdout);
}

// Run the actual local API over encrypted storage; only DOM and remote HTTP are
// substituted. Browser evidence separately covers native IndexedDB and controls.
async function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {},
      classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const calls = [];
  const responses = new Map();
  let usePythonConversation = false;
  let authenticated = true;
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL,
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null },
    fetch: async (path, options) => {
      calls.push({ path, ...options });
      const body = path === '/api/ai/conversation-turn' && usePythonConversation ? pythonConversation(options.body)
        : responses.has(path) ? responses.get(path) : path === '/api/app/session' ? { authenticated, csrf_token: authenticated ? 'test-csrf' : null }
        : path === '/api/app/config' ? { provider: 'mock', capabilities: Object.fromEntries(['text_ai', 'audio_recognition', 'image_recognition'].map(name => [name, { available: true, reason: '' }])) }
        : { action: 'ask', assistant_text: '什么时候开始的？', question_category: 'onset_course' };
      const status = Number.isInteger(body?.__status) ? body.__status : 200;
      return { ok: status >= 200 && status < 300, status, json: async () => {
        if (!body || !Object.hasOwn(body, '__status')) return await body;
        const { __status, ...payload } = body;
        return payload;
      } };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal;
  const password = 'synthetic-only-passphrase';
  await api.vault.setup(password);
  const unlock = async () => {
    const ready = api.initialise();
    await new Promise(setImmediate);
    element('vaultPassphrase').value = password;
    assert.equal(element('vaultSubmit').disabled, false);
    await element('vaultForm').onsubmit({ preventDefault() {} });
    await ready;
  };
  await unlock();
  const request = async (path, body, headers = {}) => api.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers });
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-09-30' })).j.conversation;
  const say = async (conversation, text) => (await request(`/api/conversations/${conversation.conversation_id}/turns`, { text, expected_version: conversation.version }, { 'Idempotency-Key': webcrypto.randomUUID() })).j.conversation;
  return { api, calls, request, start, say, unlock, setResponse(path, body) { responses.set(path, body); },
    setAuthenticated(value) { authenticated = value; }, usePythonConversation() { usePythonConversation = true; } };
}

test('health context stays local until explicitly selected; only selected entries and paired questions leave device', async () => {
  const h = await harness();
  const entries = (await h.request('/api/health-context', { fields: { conditions: ['既往左膝受伤', '无关的皮肤记录'] } })).j.health_context.entries;
  let c = await h.start();
  c = await h.say(c, '左膝不舒服');
  let sent = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.deepEqual(sent.health_context, []);
  assert.match(sent.turns[0].responding_to.text, /今天最难受/);
  const count = h.calls.length;
  c = (await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [entries[0].context_id] })).j.conversation;
  assert.equal(h.calls.length, count, 'selection itself never uploads a health entry');
  c = await h.say(c, '前天');
  sent = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.deepEqual(sent.health_context.map(item => item.text), ['既往左膝受伤']);
  assert.equal(sent.turns[1].responding_to.text, '什么时候开始的？');
  assert.equal(sent.turns[1].text, '前天');
  assert.ok(sent.health_context[0].confirmed_at);
  const call = h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1);
  assert.equal(call.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(call.credentials, 'include');
});

test('invalid context IDs cannot be selected and clearing the choice stops future disclosure', async () => {
  const h = await harness();
  const c = await h.start();
  const path = `/api/conversations/${c.conversation_id}/context`;
  for (const ids of [['not-a-context'], Array(6).fill('bad'), null]) {
    assert.equal((await h.request(path, { context_ids: ids })).r.status, 400);
  }
  const cleared = (await h.request(path, { context_ids: [] })).j.conversation;
  assert.equal(cleared.selected_context_ids.length, 0);
  assert.equal(h.calls.length, 0);
});

test('missing online session preserves the saved reply and source report without calling AI', async () => {
  const h = await harness();
  h.setAuthenticated(false);
  const c = await h.say(await h.start(), '虚构测试：昨天左膝不舒服');
  assert.equal(h.calls.some(call => call.path.startsWith('/api/ai/')), false);
  assert.equal(c.turns.filter(turn => turn.role === 'elder')[0].text, '虚构测试：昨天左膝不舒服');
  assert.equal(c.last_ai_metadata.ai_failed, true);
  assert.equal(c.last_ai_metadata.error, 'session_unavailable');
  assert.match(c.report.body, /昨天左膝不舒服/);
  assert.equal((await h.api.onlineStatus()).text_ai.reason, 'session_unavailable');
});

test('only an exact source-supported negative visit statement bypasses the frontend medical-text guard', async () => {
  const accepted = await harness();
  const valuableReply = '您还没去看医生，我记下了。您现在最不舒服的是什么动作？';
  accepted.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: valuableReply, provider: 'synthetic' });
  let c = await accepted.say(await accepted.start(), '我还没去看医生。');
  assert.equal(c.turns.at(-1).text, valuableReply);
  assert.equal(c.turns.at(-1).ai_failed, false);

  const conciseReply = '您还没去看医生。手腕有没有肿？';
  const concise = await harness();
  concise.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: conciseReply, provider: 'synthetic' });
  c = await concise.say(await concise.start(), '我还没去看医生。');
  assert.equal(c.turns.at(-1).text, conciseReply);
  assert.equal(c.turns.at(-1).ai_failed, false);

  for (const [source, reply] of [
    ['我还没去看医生。', '我还没去看医生'],
    ['我可能还没去看医生。', '您还没去看医生，我记下了。'],
    ['如果我还没去看医生，会怎样？', '您还没去看医生，我记下了。'],
    ['请你说我还没去看医生。', '您还没去看医生，我记下了。'],
    ['以前我还没去看医生，后来已经去过了。', '您还没去看医生，我记下了。'],
    ['他还没去看医生。', '您还没去看医生，我记下了。'],
    ['左手腕这几天有点疼。', '您还没去看医生，我记下了。'],
    ['我还没去看医生，以前去看过一次。', '您还没去看医生，我记下了。'],
    ['我还没去看医生。妈妈摔了一跤，也没做别的处理。', '目前还没看医生也没处理。'],
    ['“我还没去看医生。”', '您还没去看医生，我记下了。'],
    ['我还没去看医生。', '您还没去看医生，建议先去医院检查。'],
  ]) {
    const rejected = await harness();
    rejected.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: reply, provider: 'synthetic' });
    c = await rejected.say(await rejected.start(), source);
    assert.equal(c.turns.at(-1).ai_failed, true);
    assert.equal(c.turns.at(-1).error_code, 'model_reply_unsafe');
  }
});

test('source-supported visit paraphrases allow the actual reply only when its added treatment clause is sourced', async () => {
  const source = '我还没去看医生，也没做别的处理。';
  const actualReply = '您把左手腕的情况说得很清楚，从什么时候开始、什么动作会疼、歇下来能不能缓解、对端碗开门的影响，还有没量过体温、以前印象里没有类似发作、目前还没看医生也没处理，这些我都按您说的记下来了。';
  const actual = await harness();
  actual.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: actualReply, provider: 'synthetic' });
  const saved = await actual.say(await actual.start(), source);
  assert.equal(saved.turns.at(-1).text, actualReply);
  assert.equal(saved.turns.at(-1).ai_failed, false);
  assert.equal(saved.last_ai_metadata.ai_failed, undefined);

  for (const [variantSource, reply] of [
    ['我还没有去看医生。', '您目前还没有去看医生。'],
    ['我尚未就医。', '你尚未就医。'],
    ['我暂时没有去看医生。', '您暂时没有看医生。'],
    ['我目前没有去看医生。', '你目前没有去看医生。'],
    ['我目前还没去看医生。', '您目前还没看医生。'],
  ]) {
    const h = await harness();
    h.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: reply, provider: 'synthetic' });
    const c = await h.say(await h.start(), variantSource);
    assert.equal(c.turns.at(-1).ai_failed, false, `${variantSource} => ${reply}`);
  }

  const unsupportedTreatment = await harness();
  unsupportedTreatment.setResponse('/api/ai/conversation-turn', {
    action: 'reply', assistant_text: '您目前还没看医生也没处理。', provider: 'synthetic',
  });
  const rejected = await unsupportedTreatment.say(await unsupportedTreatment.start(), '我还没去看医生。');
  assert.equal(rejected.turns.at(-1).error_code, 'model_reply_unsafe');
});

test('failed reply persists only an allowlisted failure code, never remote reason text', async () => {
  const h = await harness();
  h.setResponse('/api/ai/conversation-turn', { __status: 422, error: 'ai_conversation_failed', failure_code: 'model_timeout', failure_reason: '患者原话与任意远程内容不得入库' });
  const c = await h.say(await h.start(), '虚构测试：左手腕不舒服');
  assert.equal(c.last_ai_metadata.error, 'model_timeout');
  assert.equal(c.turns.at(-1).error_code, 'model_timeout');
  assert.equal(JSON.stringify(c).includes('患者原话与任意远程内容不得入库'), false);

  const unavailable = await harness();
  unavailable.setResponse('/api/ai/conversation-turn', { __status: 503, error: 'untrusted remote detail', failure_reason: 'also untrusted' });
  const stopped = await unavailable.say(await unavailable.start(), '纯虚构测试：连接失败');
  assert.equal(stopped.last_ai_metadata.error, 'http_503');
  assert.equal(JSON.stringify(stopped).includes('untrusted'), false);
});

test('locking and unlocking a second time re-enables the submit button and retains records', async () => {
  const h = await harness();
  const c = await h.say(await h.start(), '虚构测试记录');
  h.api.lock();
  await h.unlock();
  const restored = (await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation;
  assert.equal(restored.turns[1].text, '虚构测试记录');
});

test('explicit retry replaces a failed assistant message without duplicating the saved user reply', async () => {
  const h = await harness();
  h.setAuthenticated(false);
  const c = await h.say(await h.start(), '昨天开始不舒服');
  h.setAuthenticated(true);
  const retry = await h.request(`/api/conversations/${c.conversation_id}/resume-assistant`, {});
  assert.equal(retry.j.recovered, true);
  assert.equal(retry.j.ai_failed, false);
  const turns = retry.j.conversation.turns.filter(turn => !turn.superseded);
  assert.equal(turns.filter(turn => turn.role === 'elder').length, 1);
  assert.equal(turns.some(turn => turn.ai_failed), false);
});

test('selected handoff does not include unrelated or unselected media', async () => {
  const h = await harness();
  const c = await h.say(await h.start(), '虚构选择记录');
  const recordId = c.turns.find(turn => turn.role === 'elder').record_id;
  await h.api.vault.put('media:chosen', { media_id: 'chosen', record_id: recordId, created_at: new Date().toISOString() });
  await h.api.vault.put('media:private-other', { media_id: 'private-other', record_id: 'rec_other', created_at: new Date().toISOString() });
  await h.api.vault.put('media:unlinked', { media_id: 'unlinked', created_at: new Date().toISOString() });
  const handoff = (await h.request('/api/handoffs', { record_ids: [recordId] })).j.handoff;
  assert.deepEqual(Array.from(handoff.media_attachments, item => item.media_id), ['chosen']);
});

test('selected corrected document retains its original attachment across revision history', async () => {
  const h = await harness();
  let event = (await h.request('/api/events', { raw_text: 'OCR 4.00', source_kind: 'document' })).j.event;
  const originalId = event.record_id;
  await h.api.vault.put('media:original', { media_id: 'original', record_id: originalId, created_at: new Date().toISOString() });
  await h.api.vault.put('media:other', { media_id: 'other', record_id: 'unselected', created_at: new Date().toISOString() });
  for (const text of ['OCR 4.60', '核对后 4.60']) {
    event = (await h.request(`/api/events/${event.record_id}/revise`, { raw_text: text, source_kind: 'document', reason: '对照原件修正', expected_version: event.version })).j.event;
  }
  const handoff = (await h.request('/api/handoffs', { record_ids: [event.record_id] })).j.handoff;
  assert.equal(handoff.items.length, 0, 'a correction alone is not source verification');
  assert.equal(handoff.pending_documents[0].record_id, event.record_id);
  assert.equal(JSON.stringify(handoff).includes('核对后 4.60'), false);
  assert.deepEqual(Array.from(handoff.media_attachments, item => item.media_id), ['original']);
  assert.equal((await h.request(`/api/events/${originalId}`)).j.event.raw_text, 'OCR 4.00');
});

test('deleting the newest revision removes its full chain and linked image without touching independent data', async () => {
  const h = await harness();
  let event = (await h.request('/api/events', { raw_text: '原始影像文字 1.0', source_kind: 'document' }, { 'Idempotency-Key': 'revision-chain-root' })).j.event;
  const recordIds = [event.record_id];
  const mediaId = 'media_revision_chain_original';
  await h.api.vault.put(`media:${mediaId}`, { media_id: mediaId, kind: 'image', record_id: event.record_id,
    event_link: { record_id: event.record_id }, save_status: 'saved', recognition_status: 'succeeded', version: 1 });
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([8, 6, 7, 5]).buffer, { content_type: 'image/jpeg' });
  await h.api.vault.put('upload:upload_revision_chain', { upload_id: 'upload_revision_chain', media_id: mediaId });
  await h.api.vault.put('upload-part:upload_revision_chain:000', { bytes: 'pending chunk' });
  await h.api.vault.put('operation:media-upload:revision-chain-upload', { upload_id: 'upload_revision_chain', media_id: mediaId });
  event = (await h.request(`/api/events/${event.record_id}/revise`, { raw_text: '修订影像文字 1.6', source_kind: 'document', reason: '对照原件', expected_version: event.version })).j.event;
  recordIds.push(event.record_id);
  event = (await h.request(`/api/events/${event.record_id}/revise`, { raw_text: '复核影像文字 1.8', source_kind: 'document', reason: '再次对照原件', expected_version: event.version })).j.event;
  recordIds.push(event.record_id);
  const independent = (await h.request('/api/events', { raw_text: '独立资料保留', source_kind: 'elder' })).j.event;
  const conversation = await h.start();

  const remove = (recordId) => h.api.request(`/api/events/${recordId}`, { method: 'DELETE', body: JSON.stringify({ delete_scope_confirmed: true }) });
  assert.equal((await remove(recordIds[0])).j.error, 'record_has_successor', 'an old version cannot be deleted out from under its successor');
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
  const deleted = await remove(event.record_id);
  assert.equal(deleted.r.ok, true);
  assert.equal(deleted.j.deleted.record_count, 3);
  for (const recordId of recordIds) {
    assert.equal((await h.api.vault.get(`event:${recordId}`)), undefined);
    assert.equal((await h.api.vault.list(`history:${recordId}:`)).length, 0);
  }
  assert.equal(await h.api.vault.get(`media:${mediaId}`), undefined);
  assert.equal(await h.api.vault.get(`media-binary:${mediaId}`), undefined);
  assert.equal(await h.api.vault.get('upload:upload_revision_chain'), undefined);
  assert.equal(await h.api.vault.get('upload-part:upload_revision_chain:000'), undefined);
  assert.equal(await h.api.vault.get('operation:event:revision-chain-root'), undefined);
  assert.equal(await h.api.vault.get('operation:media-upload:revision-chain-upload'), undefined);
  assert.equal((await h.request(`/api/events/${independent.record_id}`)).j.event.raw_text, '独立资料保留');
  assert.equal((await h.request(`/api/conversations/${conversation.conversation_id}`)).r.status, 200);
});

test('failed revision or chain-delete transaction leaves the prior encrypted records intact', async () => {
  const h = await harness();
  let event = (await h.request('/api/events', { raw_text: '原始影像原文', source_kind: 'document' })).j.event;
  const mediaId = 'media_failed_delete_original';
  await h.api.vault.put(`media:${mediaId}`, { media_id: mediaId, kind: 'image', record_id: event.record_id, event_link: { record_id: event.record_id } });
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([1, 3, 3, 7]).buffer, { content_type: 'image/jpeg' });
  const driver = h.api.vault.driver;
  const mutate = driver.mutateDocs.bind(driver);
  driver.mutateDocs = async () => { throw Object.assign(new Error('synthetic transaction abort'), { name: 'AbortError' }); };

  const failedRevision = await h.request(`/api/events/${event.record_id}/revise`, { raw_text: '修订原文', source_kind: 'document', reason: '对照原图', expected_version: event.version });
  assert.equal(failedRevision.r.ok, false);
  assert.equal((await h.api.vault.get(`event:${event.record_id}`)).raw_text, '原始影像原文');
  assert.equal((await h.api.vault.get(`event:${event.record_id}`)).state, 'inbox');
  assert.equal((await h.api.vault.list('event:')).length, 1);
  assert.equal((await h.api.vault.list(`history:${event.record_id}:`)).length, 1);

  driver.mutateDocs = mutate;
  event = (await h.request(`/api/events/${event.record_id}/revise`, { raw_text: '修订原文', source_kind: 'document', reason: '对照原图', expected_version: event.version })).j.event;
  driver.mutateDocs = async () => { throw Object.assign(new Error('synthetic transaction abort'), { name: 'AbortError' }); };
  const failedDelete = await h.api.request(`/api/events/${event.record_id}`, { method: 'DELETE', body: JSON.stringify({ delete_scope_confirmed: true }) });
  assert.equal(failedDelete.r.ok, false);
  assert.equal((await h.api.vault.get(`event:${event.supersedes_id}`)).raw_text, '原始影像原文');
  assert.equal((await h.api.vault.get(`event:${event.record_id}`)).raw_text, '修订原文');
  assert.ok(await h.api.vault.get(`media:${mediaId}`));
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
  assert.ok((await h.api.vault.list(`history:${event.supersedes_id}:`)).length > 0);
  assert.ok((await h.api.vault.list(`history:${event.record_id}:`)).length > 0);
  driver.mutateDocs = mutate;
});

test('QuotaExceededError is identified by name only and retry creates the original once', async () => {
  for (const quotaError of [
    Object.assign(new Error('synthetic transaction failure'), { name: 'QuotaExceededError' }),
    Object.assign(new Error(''), { name: 'QuotaExceededError' }),
  ]) {
    const h = await harness(), conversation = await h.start();
    const driver = h.api.vault.driver, mutate = driver.mutateDocs.bind(driver);
    const text = '合成QA原话：今天上午手腕酸了一会儿。';
    const operationKey = 'quota-recovery-once';
    let rejected = false;
    driver.mutateDocs = async (puts, ...rest) => {
      if (!rejected && puts.some(item => item.key.startsWith('event:'))) {
        rejected = true;
        throw quotaError;
      }
      return mutate(puts, ...rest);
    };
    const path = `/api/conversations/${conversation.conversation_id}/turns`;
    const send = () => h.request(path, { text, expected_version: conversation.version }, { 'Idempotency-Key': operationKey });
    const failed = await send();
    assert.equal(failed.r.status, 507);
    assert.equal(failed.j.error, 'local_storage_full');
    assert.equal((await h.api.vault.list('event:')).length, 0, 'failed event transaction leaves no raw record');
    const unchanged = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
    assert.equal(unchanged.turns.some(turn => turn.role === 'elder' && turn.text === text), false,
      'failed event transaction does not append the raw turn');
    assert.equal(unchanged.turns.filter(turn => turn.role === 'assistant').length,
      conversation.turns.filter(turn => turn.role === 'assistant').length,
      'failed event transaction does not append an assistant turn');
    assert.equal(h.calls.some(call => call.path === '/api/ai/conversation-turn'), false,
      'storage failure happens before any assistant request');

    driver.mutateDocs = mutate;
    const recovered = await send();
    assert.equal(recovered.r.ok, true, JSON.stringify(recovered.j));
    assert.equal((await h.api.vault.list('event:')).filter(event => event.raw_text === text).length, 1);
    const saved = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
    assert.equal(saved.turns.filter(turn => turn.role === 'elder' && turn.text === text).length, 1);
    assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, 1,
      'only the explicit successful retry requests an assistant response');
  }

  const h = await harness(), conversation = await h.start(), driver = h.api.vault.driver;
  const mutate = driver.mutateDocs.bind(driver);
  driver.mutateDocs = async (puts, ...rest) => {
    if (puts.some(item => item.key.startsWith('event:'))) throw new Error('quota exceeded');
    return mutate(puts, ...rest);
  };
  const ordinaryError = await h.request(`/api/conversations/${conversation.conversation_id}/turns`,
    { text: '合成QA原话。', expected_version: conversation.version }, { 'Idempotency-Key': 'ordinary-error' });
  assert.notEqual(ordinaryError.j.error, 'local_storage_full', 'message text alone never classifies a quota error');
});

test('quota failure after event commit preserves the event but does not append a conversation turn or call the assistant', async () => {
  const h = await harness(), conversation = await h.start();
  const driver = h.api.vault.driver, mutate = driver.mutateDocs.bind(driver);
  const text = '合成QA原话：午饭后手腕又酸了一会儿。';
  const operationKey = 'quota-after-event-commit';
  let sends = 0;
  driver.mutateDocs = async (puts, ...rest) => {
    if (puts.some(item => item.key.startsWith('conversation:'))) {
      throw Object.assign(new Error('synthetic conversation quota failure'), { name: 'QuotaExceededError' });
    }
    return mutate(puts, ...rest);
  };
  const path = `/api/conversations/${conversation.conversation_id}/turns`;
  const send = () => { sends++; return h.request(path, { text, expected_version: conversation.version }, { 'Idempotency-Key': operationKey }); };
  const failed = await send();
  assert.equal(failed.r.status, 507);
  assert.equal(failed.j.error, 'local_storage_full');
  const records = (await h.api.vault.list('event:')).filter(event => event.raw_text === text);
  assert.equal(records.length, 1, 'the raw event committed before the conversation write failed');
  const unchanged = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.equal(unchanged.turns.some(turn => turn.role === 'elder' && turn.text === text), false,
    'the conversation was not fully written');
  assert.equal(unchanged.turns.filter(turn => turn.role === 'assistant').length,
    conversation.turns.filter(turn => turn.role === 'assistant').length);
  assert.equal(h.calls.some(call => call.path === '/api/ai/conversation-turn'), false,
    'no assistant request occurs after the conversation write fails');
  assert.equal(sends, 1, 'the request is not automatically retried');
  assert.equal((await h.api.vault.list('event:')).filter(event => event.raw_text === text).length, 1,
    'no automatic retry duplicates or removes the committed event');
  driver.mutateDocs = mutate;
});

test('recognition finishing after full-conversation deletion cannot recreate saved transcript data', async () => {
  for (const response of [
    { recognition: { is_mock: false, text: '合成样例，昨天左膝疼' } },
    { error: 'provider_unavailable' },
  ]) {
    const h = await harness(), conversation = await h.start(), media = await savedAudio(h, conversation);
    let finish;
    h.setResponse('/api/ai/media/recognize', new Promise(resolve => { finish = resolve; }));
    await h.request(`/api/media/${media.media_id}/recognize`, { expected_version: media.version });
    while (!h.calls.some(call => call.path === '/api/ai/media/recognize')) await new Promise(setImmediate);
    const deleted = await h.api.request(`/api/conversations/${conversation.conversation_id}`, {
      method: 'DELETE', body: JSON.stringify({ delete_scope_confirmed: true, expected_version: conversation.version }),
    });
    assert.equal(deleted.r.ok, true);
    finish(response);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await h.request('/api/events')).j.events.length, 0);
    assert.equal(await h.api.vault.get(`media:${media.media_id}`), undefined);
    assert.equal(await h.api.vault.get(`media-binary:${media.media_id}`), undefined);
    assert.equal(await h.api.vault.get(`conversation:${conversation.conversation_id}`), undefined);
  }
});

test('older recognition success or failure cannot overwrite a newer processing attempt', async () => {
  for (const response of [
    { recognition: { is_mock: false, text: '过期尝试的文字' } },
    { error: 'provider_unavailable' },
  ]) {
    const h = await harness(), conversation = await h.start(), media = await savedAudio(h, conversation);
    let finish;
    h.setResponse('/api/ai/media/recognize', new Promise(resolve => { finish = resolve; }));
    await h.request(`/api/media/${media.media_id}/recognize`, { expected_version: media.version });
    while (!h.calls.some(call => call.path === '/api/ai/media/recognize')) await new Promise(setImmediate);
    const processing = await h.api.vault.get(`media:${media.media_id}`);
    await h.api.vault.put(`media:${media.media_id}`, { ...processing, version: processing.version + 1, updated_at: new Date().toISOString() });
    finish(response);
    await new Promise(resolve => setTimeout(resolve, 30));
    const saved = await h.api.vault.get(`media:${media.media_id}`);
    assert.equal(saved.version, processing.version + 1);
    assert.equal(saved.recognition_status, 'processing');
    assert.equal((await h.request('/api/events')).j.events.length, 0);
  }
});

test('failed full-conversation delete transaction leaves the conversation, media, records and operations intact', async () => {
  const h = await harness();
  let conversation = await h.say(await h.start(), '合成样例：昨天左膝疼');
  const elder = conversation.turns.find(turn => turn.role === 'elder');
  const eventId = elder.record_id;
  const media = await savedAudio(h, conversation);
  await h.api.vault.put('upload:upload_pending_conversation', { upload_id: 'upload_pending_conversation', media_id: 'media_pending_conversation', conversation_id: conversation.conversation_id, total_parts: 1 });
  await h.api.vault.put('upload-part:upload_pending_conversation:000', { bytes: 'pending upload part' });
  await h.api.vault.put('operation:media-upload:pending-conversation', { upload_id: 'upload_pending_conversation', media_id: 'media_pending_conversation' });
  const unrelated = (await h.request('/api/events', { raw_text: '不相关资料', source_kind: 'elder' })).j.event;
  const driver = h.api.vault.driver;
  const mutate = driver.mutateDocs.bind(driver);
  driver.mutateDocs = async () => { throw Object.assign(new Error('synthetic transaction abort'), { name: 'AbortError' }); };

  const deletion = await h.api.request(`/api/conversations/${conversation.conversation_id}`, {
    method: 'DELETE', body: JSON.stringify({ delete_scope_confirmed: true, expected_version: conversation.version }),
  });
  assert.equal(deletion.r.ok, false, 'storage rejection is returned through the API failure shape');
  assert.equal((await h.api.vault.get(`conversation:${conversation.conversation_id}`)).conversation_id, conversation.conversation_id);
  assert.equal((await h.api.vault.get(`event:${eventId}`)).raw_text, elder.text);
  assert.ok(await h.api.vault.get(`media:${media.media_id}`));
  assert.ok(await h.api.vault.get(`media-binary:${media.media_id}`));
  assert.ok(await h.api.vault.get('upload:upload_pending_conversation'));
  assert.ok(await h.api.vault.get('upload-part:upload_pending_conversation:000'));
  assert.ok(await h.api.vault.get('operation:media-upload:pending-conversation'));
  assert.equal((await h.request(`/api/events/${unrelated.record_id}`)).j.event.raw_text, '不相关资料');
  driver.mutateDocs = mutate;
});

test('conversation-bound media upload atomically saves the original before its temporary parts are removed', async () => {
  const h = await harness(), conversation = await h.start();
  const bytes = new Uint8Array([9, 2, 6, 5]);
  const digest = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const create = new FormData();
  for (const [key, value] of Object.entries({ kind: 'audio', content_type: 'audio/webm', total_parts: '1', expected_size: String(bytes.length), expected_sha256: digest, original_filename: 'synthetic.webm', temporary: 'true', conversation_id: conversation.conversation_id })) create.append(key, value);
  const created = await h.api.request('/api/media/uploads', { method: 'POST', body: create });
  assert.equal(created.r.ok, true);
  const upload = created.j.upload;
  const part = new FormData();
  part.append('file', new Blob([bytes], { type: 'audio/webm' }), 'synthetic.webm');
  assert.equal((await h.api.request(`/api/media/uploads/${upload.upload_id}/parts/0`, { method: 'POST', body: part })).r.ok, true);
  const complete = await h.api.request(`/api/media/uploads/${upload.upload_id}/complete`, { method: 'POST', body: '{}' });
  assert.equal(complete.r.ok, true, JSON.stringify(complete.j));
  const media = complete.j.media;
  const original = await h.api.vault.get(`media-binary:${media.media_id}`);
  assert.deepEqual([...new Uint8Array(original.bytes)], [...bytes]);
  assert.equal((await h.api.vault.get(`media:${media.media_id}`)).save_status, 'saved');
  assert.equal(await h.api.vault.get(`upload:${upload.upload_id}`), undefined);
  assert.equal(await h.api.vault.get(`upload-part:${upload.upload_id}:000`), undefined);
});

test('unreviewed OCR is quarantined across organize, confirmation, history input, handoff, revision and conversation', async () => {
  const h = await harness();
  const guessed = '胸部120法及以上CT\nHBV DNA 2.0E+011IU/ml';
  let event = (await h.request('/api/events', { raw_text: guessed, source_kind: 'document', source_review: { text: guessed, confirmed_at: 'forged' } })).j.event;
  const path = `/api/events/${event.record_id}`;
  for (const action of ['organize', 'review', 'summary']) {
    const result = await h.request(`${path}/${action}`, { expected_version: event.version, action: 'confirm', summary: guessed });
    assert.equal(result.j.error, 'document_source_review_required');
  }
  assert.equal(h.calls.length, 0, 'unreviewed OCR never reaches the provider');
  const c = await h.start();
  const turn = await h.request(`/api/conversations/${c.conversation_id}/turns`, { text: guessed, record_id: event.record_id, expected_version: c.version }, { 'Idempotency-Key': 'doc-as-turn' });
  assert.equal(turn.j.error, 'conversation_source_invalid');
  const other = (await h.request('/api/events', { raw_text: '虚构患者自述', source_kind: 'elder', related_record_ids: [event.record_id] })).j.event;
  await h.request(`/api/events/${other.record_id}/organize`, { expected_version: other.version });
  assert.deepEqual(JSON.parse(h.calls.find(call => call.path === '/api/ai/organize').body).history, []);
  // Historical recorded state and a saved old model draft must not bypass the new gate.
  await h.api.vault.put(`event:${event.record_id}`, { ...event, state: 'recorded', draft: { summary: guessed } });
  const handoff = (await h.request('/api/handoffs', { record_ids: [event.record_id] })).j.handoff;
  assert.equal(handoff.items.length, 0);
  assert.equal(handoff.pending_documents.length, 1);
  assert.equal(JSON.stringify(handoff).includes(guessed), false);
  assert.equal((await h.request(`${path}/source-review`, { expected_version: event.version })).j.error, 'source_review_confirmation_required');
  event = (await h.request(`${path}/source-review`, { expected_version: event.version, compared_with_original: true })).j.event;
  assert.equal(event.state, 'inbox', 'old unverified AI draft must be invalidated');
  assert.equal(event.draft, null);
  assert.equal(event.source_review.text, guessed);
  // This tests explicit human attestation, not automatic visual correctness.
  assert.equal((await h.request('/api/handoffs', { record_ids: [event.record_id] })).j.handoff.items[0].raw_text, guessed);
  const revised = (await h.request(`${path}/revise`, { expected_version: event.version, raw_text: '[无法辨认]\nHBV DNA 2.0E+01IU/ml', source_kind: 'elder', reason: '对照原件更正' })).j.event;
  assert.equal(revised.source_kind, 'document', 'revision cannot relabel document OCR as patient speech');
  assert.equal(revised.source_review, null);
  assert.equal(revised.confirmation_scope, null);
  assert.equal((await h.request(`/api/events/${revised.record_id}/organize`, { expected_version: revised.version })).j.error, 'document_source_review_required');
});

test('old mislabelled document revisions remain quarantined after encrypted backup restore', async () => {
  const h = await harness();
  const old = (await h.request('/api/events', { raw_text: '标题残缺', source_kind: 'document' })).j.event;
  const wrong = { ...old, record_id: 'rec_legacy_wrong_source', source_kind: 'elder', raw_text: '猜测标题', supersedes_id: old.record_id, state: 'recorded' };
  await h.api.vault.put('event:' + wrong.record_id, wrong);
  const read = (await h.request('/api/events/' + wrong.record_id)).j.event;
  assert.equal(read.source_kind, 'document');
  assert.equal((await h.request('/api/handoffs', { record_ids: [wrong.record_id] })).j.handoff.items.length, 0);
  const archive = await h.api.vault.exportArchive();
  await h.api.vault.restoreArchive(archive, 'synthetic-only-passphrase');
  assert.equal((await h.request('/api/events/' + wrong.record_id + '/organize', { expected_version: wrong.version })).j.error, 'document_source_review_required');
});

test('late organize response cannot overwrite a newer revision or resurrect its old record', async () => {
  const h = await harness();
  const event = (await h.request('/api/events', { raw_text: '昨天左边疼', source_kind: 'elder' })).j.event;
  let finish;
  h.setResponse('/api/ai/organize', new Promise(resolve => { finish = resolve; }));
  const organizing = h.request(`/api/events/${event.record_id}/organize`, { expected_version: event.version });
  while (!h.calls.some(call => call.path === '/api/ai/organize')) await new Promise(setImmediate);
  const revision = await h.request(`/api/events/${event.record_id}/revise`, { expected_version: event.version, raw_text: '昨天右边疼', reason: '更正方向' });
  assert.equal(revision.r.ok, true);
  finish({ output: { summary: '昨天左边疼' } });
  assert.equal((await organizing).j.error, 'stale_version');
  assert.equal((await h.request('/api/events/' + event.record_id)).j.event.state, 'superseded');
});

test('delete completes during an in-flight organize and the late response cannot recreate the record', async () => {
  const h = await harness();
  const event = (await h.request('/api/events', { raw_text: '虚构样例：昨天左边疼', source_kind: 'elder' })).j.event;
  let finish;
  h.setResponse('/api/ai/organize', new Promise(resolve => { finish = resolve; }));
  const organizing = h.request(`/api/events/${event.record_id}/organize`, { expected_version: event.version });
  while (!h.calls.some(call => call.path === '/api/ai/organize')) await new Promise(setImmediate);
  const deleted = await h.api.request(`/api/events/${event.record_id}`, { method: 'DELETE', body: JSON.stringify({ delete_scope_confirmed: true }) });
  assert.equal(deleted.r.ok, true, 'delete is not blocked by the remote model request');
  finish({ output: { summary: '旧资料的迟到整理' } });
  assert.equal((await organizing).j.error, 'stale_version');
  assert.equal((await h.request(`/api/events/${event.record_id}`)).r.status, 404);
});

test('revision and deletion of the same record serialize without leaving a resurrected old version', async () => {
  const h = await harness();
  const event = (await h.request('/api/events', { raw_text: '影像原文 1.0', source_kind: 'document' })).j.event;
  let release, signal;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { signal = resolve; });
  const driver = h.api.vault.driver;
  const mutate = driver.mutateDocs.bind(driver);
  driver.mutateDocs = async (...args) => { signal(); await gate; return mutate(...args); };
  const revising = h.request(`/api/events/${event.record_id}/revise`, { raw_text: '影像原文 1.6', source_kind: 'document', reason: '对照原图', expected_version: event.version });
  await entered;
  const deleting = h.api.request(`/api/events/${event.record_id}`, { method: 'DELETE', body: JSON.stringify({ delete_scope_confirmed: true }) });
  await new Promise(setImmediate);
  release();
  const revised = await revising;
  const deleted = await deleting;
  driver.mutateDocs = mutate;
  assert.equal(revised.r.ok, true);
  assert.equal(deleted.j.error, 'record_has_successor');
  const events = (await h.request('/api/events')).j.events;
  assert.equal(events.length, 2);
  assert.equal(events.find(item => item.record_id === event.record_id).state, 'superseded');
  assert.equal(events.find(item => item.record_id === revised.j.event.record_id).raw_text, '影像原文 1.6');
});

test('oversized health background is rejected intact instead of silently dropping lines', async () => {
  const h = await harness();
  await h.request('/api/health-context', { fields: { conditions: ['原有虚构条目'] } });
  const result = await h.request('/api/health-context', { fields: { conditions: Array.from({ length: 13 }, (_, i) => `条目${i}`) } });
  assert.equal(result.j.error, 'health_context_too_many');
  const saved = (await h.request('/api/health-context')).j.health_context;
  assert.deepEqual(Array.from(saved.entries, item => item.text), ['原有虚构条目']);
});

test('old configuration failures become manually retryable while unsupported files remain terminal', async () => {
  const h = await harness();
  for (const code of ['provider_not_configured', 'unsupported_format']) {
    await h.api.vault.put(`media:${code}`, { media_id: code, created_at: new Date().toISOString(), recognition_status: 'failed', recognition: { retryable: false, error: { code, retryable: false } } });
  }
  const items = (await h.request('/api/media')).j.media;
  assert.equal(items.find(item => item.media_id === 'provider_not_configured').recognition.retryable, true);
  assert.equal(items.find(item => item.media_id === 'unsupported_format').recognition.retryable, false);
});

async function savedAudio(h, conversation, recognition = null) {
  const media = { media_id: 'media_syntheticvoice', kind: 'audio', content_type: 'audio/webm',
    original_filename: 'synthetic.webm', size: 4, temporary: true,
    conversation_id: conversation.conversation_id, save_status: 'saved',
    recognition_status: recognition ? 'succeeded' : 'not_started', recognition, version: 1 };
  await h.api.vault.put('media:' + media.media_id, media);
  await h.api.vault.putBinary('media-binary:' + media.media_id, new Uint8Array([1, 2, 3, 4]).buffer, { content_type: 'audio/webm' });
  return media;
}
async function recognize(h, media) {
  await h.request(`/api/media/${media.media_id}/recognize`, { expected_version: media.version });
  for (let i = 0; i < 150; i++) {
    const current = (await h.request(`/api/media/${media.media_id}`)).j.media;
    if (current.recognition_status !== 'processing' && current.link_pending_reason !== 'conversation_link_pending') return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('recognition did not finish');
}

test('Mock ASR cannot create a patient fact, conversation turn or report, and original survives pause', async () => {
  const h = await harness(), c = await h.start(), media = await savedAudio(h, c);
  h.setResponse('/api/ai/media/recognize', { recognition: { is_mock: true, text: '[Mock ASR] synthetic.webm' } });
  const result = await recognize(h, media);
  assert.equal(result.recognition_status, 'failed');
  assert.equal(result.recognition.error.code, 'media_mock_unavailable');
  assert.equal(result.recognition.retryable, true);
  assert.equal((await h.request('/api/events')).j.events.length, 0);
  const latest = (await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation;
  assert.equal(latest.turns.length, 1);
  assert.equal(latest.report, null);
  await h.request(`/api/conversations/${c.conversation_id}/pause`, {});
  assert.ok(await h.api.vault.get('media-binary:' + media.media_id));
});

test('retry after Mock failure uses actual provider transcript once and pairs it to the saved conversation', async () => {
  const h = await harness(), c = await h.start(), media = await savedAudio(h, c);
  h.setResponse('/api/ai/media/recognize', { recognition: { is_mock: true, text: '[Mock ASR] synthetic.webm' } });
  await recognize(h, media);
  h.setResponse('/api/ai/media/recognize', { recognition: { is_mock: false, text: '合成样例，昨天左膝疼' } });
  const result = await recognize(h, media);
  assert.equal(result.recognition_status, 'succeeded');
  assert.equal((await h.request('/api/events')).j.events.length, 1);
  let latest = (await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation;
  assert.equal(latest.turns.filter(t => t.role === 'elder').length, 0);
  assert.equal(latest.report, null);
  assert.equal(result.link_pending_reason, 'audio_source_review_required');
  const event=(await h.request('/api/events/'+result.record_id)).j.event;
  const reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event;
  const currentMedia=(await h.request('/api/media/'+media.media_id)).j.media;
  latest=(await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation;
  h.setResponse('/api/ai/conversation-turn',{action:'reply',assistant_text:'合成测试：我已保存这段核对过的原话。',provider:'SyntheticMechanicalFixture'});
  const linked=await h.request(`/api/conversations/${c.conversation_id}/turns`,{text:event.raw_text,source_kind:'audio_transcript',record_id:event.record_id,media_id:media.media_id,source_version:reviewed.version,media_version:currentMedia.version,expected_version:latest.version,keep_media_until_pause:true},{'Idempotency-Key':'synthetic-reviewed-after-mock-retry'});
  assert.equal(linked.r.ok,true,linked.j.error||'reviewed audio was refused');latest=linked.j.conversation;
  assert.equal(latest.turns.filter(t => t.role === 'elder').length, 1);
  assert.equal(latest.turns.find(t => t.role === 'elder').text, '合成样例，昨天左膝疼');
  assert.equal(latest.turns.find(t=>t.role==='elder').audio_source_reviewed,true);
  assert.match(latest.report.body, /昨天左膝疼/);
  assert.ok(await h.api.vault.get('media-binary:' + media.media_id));
});

test('old Mock incident remains visible, but cannot be linked, exported as patient fact, or sent to model', async () => {
  const h = await harness(), c = await h.start();
  const fake = '[Mock ASR] synthetic.webm';
  const media = await savedAudio(h, c, { is_mock: true, text: fake });
  await h.api.vault.put('event:rec_old_mock', { record_id: 'rec_old_mock', raw_text: fake, source_kind: 'audio_transcript', state: 'inbox', version: 1 });
  const dirty = { ...c, turns: [...c.turns,
    { turn_id: 'turn_old_mock', role: 'elder', text: fake, source_kind: 'audio_transcript', record_id: 'rec_old_mock', media_id: media.media_id, version: 1 },
    { turn_id: 'turn_mock_reply', role: 'assistant', text: `您说 ${fake}，我听清了。`, action: 'ask' }],
    report: { format_version: 3, body: fake, version: 1 },
    completeness: { clinical_state: { main_complaint: { status: 'known', summary: fake } } } };
  await h.api.vault.put('conversation:' + c.conversation_id, dirty);
  const read = (await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation;
  assert.equal(read.turns[1].is_mock, true);
  assert.equal(read.report, null);
  assert.equal(read.completeness, null);
  assert.equal((await h.request('/api/conversations')).j.conversations.length, 1, 'history not silently erased');
  assert.equal((await h.request(`/api/media/${media.media_id}/link`, {})).j.error, 'media_mock_unavailable');
  const blocked = await h.request(`/api/conversations/${read.conversation_id}/turns`,{text:'虚构样例：昨天左膝疼',expected_version:read.version},{'Idempotency-Key':'synthetic-pending-audio-block'});
  assert.equal(blocked.r.status,409,'an old unreviewed audio source pauses this thread until the person recovers or sets it aside');
  const next = await h.say(await h.start(), '虚构样例：昨天左膝疼');
  const payload = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.equal(payload.turns.length, 1);
  assert.equal(payload.turns[0].responding_to?.turn_id, next.turns.find(turn=>turn.role==='assistant')?.turn_id);
  assert.doesNotMatch(next.report.body, /Mock/);
  const handoff = (await h.request('/api/handoffs', {})).j.handoff;
  assert.equal(handoff.items.length, 1);
  assert.doesNotMatch(JSON.stringify(handoff.conversation_reports), /Mock ASR/);
  await h.request(`/api/conversations/${c.conversation_id}/pause`, {});
  assert.ok(await h.api.vault.get('media-binary:' + media.media_id));
  assert.ok(await h.api.vault.get('event:rec_old_mock'), 'incident retained in encrypted history');
});

test('response-only dialogue is preserved as context without turning it into a patient fact', async () => {
  const h = await harness();
  h.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: '问走路是想了解不舒服对日常活动的影响。您可以按自己的话说。' });
  let c = await h.say(await h.start(), '为什么问我走路的情况');
  assert.equal(c.turns.at(-1).action, 'reply');
  c = await h.say(c, '明白了，上楼时会更明显');
  const sent = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.match(sent.turns.at(-1).responding_to.text, /日常活动/);
  assert.doesNotMatch(c.report.body, /问走路是想了解/);
});

test('safe scope explanation survives frontend checks but advice after a disclaimer is still rejected', async () => {
  const h = await harness();
  h.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: '我不能提供诊断、用药或治疗建议。可以先把您担心的地方说清楚。' });
  let c = await h.say(await h.start(), '我有点担心');
  assert.equal(c.turns.at(-1).ai_failed, false);
  h.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: '我不能诊断。建议加量吃药。' });
  c = await h.say(c, '那我怎么办');
  assert.equal(c.turns.at(-1).ai_failed, true);
});

test('a record explanation that mentions 病历 is not mistaken for a disease conclusion', async () => {
  const h = await harness();
  const text = '这是病历记录，用来说明您已经说过的情况。';
  h.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: text });
  const c = await h.say(await h.start(), '虚构记录：昨天膝部酸');
  assert.equal(c.turns.at(-1).text, text);
  assert.notEqual(c.last_ai_metadata.ai_failed, true);
});

for (const text of [
  '您得了肺炎。', '这是肺炎。', '诊断为关节炎。', '您患有糖尿病。',
  '每天服用两片阿司匹林。', '把胰岛素增加到十单位。', '先去做血常规。',
  '您的情况很安全，没有问题。', '请做CT检查。', '每天服用 2 mg 阿司匹林。',
]) test(`frontend rejects out-of-bound model reply: ${text}`, async () => {
  const h = await harness();
  h.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: text });
  const c = await h.say(await h.start(), '虚构测试：左膝酸');
  assert.equal(c.turns.at(-1).ai_failed, true);
  assert.notEqual(c.turns.at(-1).text, text);
  assert.match(c.report.body, /左膝酸/);
});

test('a recognition interrupted by closing the page becomes retryable instead of staying processing forever', async () => {
  const h = await harness(), c = await h.start(), media = await savedAudio(h, c);
  await h.api.vault.put('media:' + media.media_id, { ...media, recognition_status: 'processing', updated_at: new Date(Date.now() - 130000).toISOString() });
  const stale = (await h.request(`/api/media/${media.media_id}`)).j.media;
  assert.equal(stale.recognition_status, 'interrupted');
  assert.equal(stale.recognition.retryable, true);
  h.setResponse('/api/ai/media/recognize', { recognition: { is_mock: false, text: '虚构样例，昨天左膝疼' } });
  assert.equal((await recognize(h, stale)).recognition_status, 'succeeded');
});

test('editing a patient turn invalidates prior clinical analysis even if the next model request fails', async () => {
  const h = await harness();
  const c = await h.say(await h.start(), '虚构样例：昨天左膝疼');
  const elder = c.turns.find(turn => turn.role === 'elder');
  await h.api.vault.put('conversation:' + c.conversation_id, { ...c, completeness: { clinical_state: { functional_impact: { status: 'known', evidence_turn_ids: [elder.turn_id] } } }, relevant_health_context: [{ context_id: 'context_old', text: '旧背景关联' }] });
  h.setAuthenticated(false);
  const changed = (await h.request(`/api/conversations/${c.conversation_id}/turns/${elder.turn_id}`, { text: '虚构更正：今天右手有些麻', expected_version: elder.version, expected_conversation_version: c.version })).j.conversation;
  assert.equal(changed.completeness, null);
  assert.equal(changed.relevant_health_context.length, 0);
  assert.match(changed.report.body, /今天右手有些麻/);
  assert.doesNotMatch(changed.report.body, /昨天左膝疼|旧背景关联/);
  assert.equal(changed.last_ai_metadata.ai_failed, true);
});

test('editing an original turn keeps other turns classification-bound across real Python replies', async () => {
  const h = await harness();
  h.usePythonConversation();
  const profile = (await h.request('/api/health-memory')).j.health_context;
  const memory = await h.request('/api/health-memory', {
    expected_version: profile.version,
    entry: { category: 'conditions', text: '虚构测试背景：旧的健康背景', temporal_status: 'historical',
      confirmation_status: 'confirmed', confirmed_by: 'self', occurred_on: '2021-02-03', remember: true, source_kind: 'self_statement' },
  });
  assert.equal(memory.r.status, 201);

  let conversation = await h.start();
  conversation = await h.say(conversation, '今天天气晴，我打算去看电影。');
  const weather = conversation.turns.find(turn => turn.role === 'elder');
  conversation = await h.say(conversation, '我咳嗽。');
  const cough = conversation.turns.filter(turn => turn.role === 'elder').at(-1);
  assert.ok(conversation.controller.non_health_sources.some(source => source.turn_id === weather.turn_id));

  const remembered = memory.j.health_context.entries[0];
  const correction = await h.api.request(`/api/health-memory/${remembered.context_id}`, {
    method: 'PATCH', body: JSON.stringify({ expected_version: memory.j.health_context.version,
      entry: { category: remembered.category, text: '虚构测试背景：更正后的健康背景',
        temporal_status: remembered.temporal_status, confirmation_status: remembered.confirmation_status,
        confirmed_by: remembered.confirmed_by, occurred_on: remembered.occurred_on,
        remember: remembered.remember, source_kind: remembered.source_kind } }),
  });
  assert.equal(correction.r.status, 200);
  conversation = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.equal(conversation.completeness, null, 'memory correction invalidates its prior analysis');
  assert.ok(conversation.controller.non_health_sources.some(source => source.turn_id === weather.turn_id),
    'memory correction leaves the unchanged weather classification available');

  const editedCough = await h.request(`/api/conversations/${conversation.conversation_id}/turns/${cough.turn_id}`, {
    text: '这两天还是会咳嗽。', expected_version: cough.version,
    expected_conversation_version: conversation.version,
  });
  assert.equal(editedCough.r.status, 200);
  const coughPayload = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.ok(coughPayload.controller.non_health_sources?.some(source => source.turn_id === weather.turn_id),
    'the real local-store edit request sends forward the untouched weather classification');
  assert.ok(editedCough.j.conversation.controller.non_health_sources.some(source => source.turn_id === weather.turn_id),
    'Python validates and returns the untouched weather classification');
  let onset = editedCough.j.conversation.completeness.clinical_state.onset_course;
  assert.equal(onset.evidence_turn_ids.includes(weather.turn_id), false);
  assert.equal(editedCough.j.conversation.completeness.evidence_turn_ids.includes(weather.turn_id), false);
  assert.doesNotMatch(onset.summary, /天气晴/);

  const editedWeather = await h.request(`/api/conversations/${conversation.conversation_id}/turns/${weather.turn_id}`, {
    text: '我今天开始咳嗽。', expected_version: weather.version,
    expected_conversation_version: editedCough.j.conversation.version,
  });
  assert.equal(editedWeather.r.status, 200);
  onset = editedWeather.j.conversation.completeness.clinical_state.onset_course;
  assert.equal(onset.status, 'known', 'editing the classified source permits fresh backend evaluation');
  assert.deepEqual(Array.from(onset.evidence_turn_ids), [weather.turn_id]);
  assert.equal(editedWeather.j.conversation.controller.non_health_sources.some(source => source.turn_id === weather.turn_id), false);

  const fresh = await h.start();
  assert.equal(fresh.controller.non_health_sources, undefined, 'a new conversation starts without another session’s markers');
  const freshAfterTurn = await h.say(fresh, '我今天也咳嗽。');
  const freshPayload = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.equal(freshPayload.controller.non_health_sources?.some(source => source.turn_id === weather.turn_id) || false, false);
  assert.equal(freshAfterTurn.controller.non_health_sources?.some(source => source.turn_id === weather.turn_id) || false, false);

  const registry = (await h.request('/api/health-subjects')).j;
  const created = await h.request('/api/health-subjects', { label: '虚构家属来源隔离', relationship: 'family', expected_version: registry.version });
  const family = created.j.subjects.find(subject => subject.relationship === 'family');
  const switched = await h.request('/api/health-subjects/active', { subject_id: family.subject_id, expected_version: created.j.version });
  assert.equal(switched.r.status, 200);
  let familyConversation = await h.start();
  assert.equal(familyConversation.subject_id, family.subject_id);
  assert.equal(familyConversation.controller.non_health_sources, undefined, 'a different member starts without prior source classifications');
  familyConversation = await h.say(familyConversation, '今天天气晴，我准备出门。');
  const familyPayload = JSON.parse(h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body);
  assert.equal(familyPayload.subject_id, family.subject_id);
  assert.equal(familyPayload.controller.non_health_sources?.some(source => source.turn_id === weather.turn_id) || false, false);
});

test('a 200 response with empty or Mock model text cannot be presented as a successful reply', async () => {
  for (const response of [{ action: 'reply', assistant_text: '' }, { action: 'reply', assistant_text: '模拟回答', provider: 'MockProvider' }]) {
    const h = await harness();
    h.setResponse('/api/ai/conversation-turn', response);
    const c = await h.say(await h.start(), '虚构描述');
    assert.equal(c.turns.at(-1).ai_failed, true);
    assert.equal(c.last_ai_metadata.ai_failed, true);
  }
});

test('existing local urgent rule remains visible without a model connection and without uploading the utterance', async () => {
  const h = await harness(); h.setAuthenticated(false);
  const c = await h.say(await h.start(), '虚构规则测试：突然呼吸困难');
  assert.equal(c.turns.at(-1).action, 'urgent');
  assert.equal(c.turns.at(-1).text, safety.DANGER_REMINDER);
  assert.equal(c.turns.at(-1).ai_failed, false);
  assert.equal(h.calls.length, 0);
  assert.match(c.report.body, /紧急提醒/);
});


test('recognized audio remains a source-review draft and never queues an automatic conversation reply', async () => {
  const h = await harness(), c = await h.start(), media = await savedAudio(h, c);
  h.setResponse('/api/ai/media/recognize', { recognition: { is_mock: false, text: '昨天左膝疼' } });
  const ready = await recognize(h,media);
  assert.equal(ready.link_pending_reason,'audio_source_review_required');
  assert.ok(ready.record_id);
  assert.equal(ready.conversation_turn_id, undefined);
  const saved = (await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation;
  assert.equal(saved.turns.filter(turn => turn.role === 'elder').length, 0);
  assert.equal(saved.report,null);
  assert.equal(h.calls.filter(call=>call.path==='/api/ai/conversation-turn').length,0);
  assert.ok(await h.api.vault.get('media-binary:'+media.media_id));
});

test('a worry stays a patient question, while sleep and walking answers use their grounded categories', async () => {
  const h = await harness();
  let c = await h.say(await h.start(), '昨天右膝疼');
  c = await h.say(c, '是酸痛，不红不肿，晚上睡得还好，平地能走');
  c = await h.say(c, '我有点担心，会不会很严重？');
  const patients = c.turns.filter(turn => turn.role === 'elder');
  const known = ref => ({ status: 'known', evidence_turn_ids: [ref] });
  await h.api.vault.put('conversation:' + c.conversation_id, { ...c, report: { ...c.report, format_version: 3 }, completeness: { clinical_state: {
    main_complaint: known(patients[0].turn_id), onset_course: known(patients[0].turn_id),
    symptom_character: known(patients[1].turn_id), functional_impact: known(patients[1].turn_id),
  } }, analysis_sources: { turns: patients.map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
    selected_context_ids: [], context_version: 0, context: [] } });
  const report = (await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation.report;
  const symptoms = report.sections.find(section => section.key === 'symptoms_impact');
  assert.ok(symptoms.lines.some(line => line.text.includes('睡得还好')));
  assert.equal(report.sections.find(section => section.key === 'onset_course')?.lines.some(line => line.text.includes('睡得还好')) || false, false);
  const question = report.sections.find(section => section.key === 'patient_questions');
  assert.equal(question.lines[0].text, patients[2].text);
  assert.equal(symptoms.lines.some(line => line.text.includes('担心')), false);
});

test('an explanation request cannot become a contradictory patient fact in a migrated report', async () => {
  const h = await harness();
  let c = await h.say(await h.start(), '昨天右膝疼');
  c = await h.say(c, '我没听懂，为什么要问是什么感觉？');
  const patients = c.turns.filter(turn => turn.role === 'elder');
  await h.api.vault.put('conversation:' + c.conversation_id, { ...c,
    report: { ...c.report, format_version: 3 },
    completeness: { ...c.completeness, contradictions: [{
      text: '模型误报的矛盾', evidence_turn_ids: patients.map(turn => turn.turn_id), context_ids: [],
    }] },
  });
  const report = (await h.request(`/api/conversations/${c.conversation_id}`)).j.conversation.report;
  assert.equal(report.format_version, 5);
  assert.doesNotMatch(report.body, /原话有出入|这些原话可能有出入/);
  assert.ok(report.transcript.some(turn => turn.text === patients[1].text), 'the original explanation request remains in the full transcript');
});

test('a confirmed natural correction replaces only the manually selected full sentence locally and removes the correction from later model context', async () => {
  const h = await harness();
  const base = await h.start();
  const original = '左手腕抬高会疼。最近端碗和开门都得慢一点。晚上睡觉暂时还没受什么影响。';
  const correctionText = '更正一下，刚才说晚上睡觉没受影响不准确，昨晚翻身时左手腕疼醒过一次。';
  const event = (await h.request('/api/events', { raw_text: original, source_kind: 'elder' })).j.event;
  const target = { turn_id: 'target-original', role: 'elder', source_kind: 'elder', text: original, original_text: original,
    record_id: event.record_id, version: 1, timestamp: new Date().toISOString() };
  const correction = { turn_id: 'correction-natural', role: 'elder', source_kind: 'elder', text: correctionText,
    original_text: correctionText, version: 1, timestamp: new Date().toISOString() };
  const turns = [base.turns[0], target, { turn_id: 'assistant-between', role: 'assistant', text: '我记下了。', version: 1 },
    correction, { turn_id: 'assistant-pending', role: 'assistant', text: '请问还有什么补充？', version: 1 }];
  const pending = { ...base, turns, version: 8, completeness: { contradictions: [{
    text: '自然更正无法唯一定位旧原话，待核实。', evidence_turn_ids: [target.turn_id, correction.turn_id], context_ids: [],
  }], clinical_state: { functional_impact: { status: 'known', summary: '最近端碗和开门都得慢一点。', evidence_turn_ids: [target.turn_id] } } } };
  await h.api.vault.put(`conversation:${base.conversation_id}`, pending);
  const current = (await h.request(`/api/conversations/${base.conversation_id}`)).j.conversation;
  const currentTarget = current.turns.find(turn => turn.turn_id === target.turn_id);
  const currentCorrection = current.turns.find(turn => turn.turn_id === correction.turn_id);
  const beforeAi = h.calls.filter(call => call.path === '/api/ai/conversation-turn').length;
  const route = `/api/conversations/${base.conversation_id}/corrections/${correction.turn_id}`;
  const result = await h.request(route, { expected_conversation_version: current.version, expected_correction_version: currentCorrection.version,
    target_turn_id: target.turn_id, expected_target_version: currentTarget.version, expected_event_version: event.version,
    old_quote: '晚上睡觉暂时还没受什么影响。', confirmed: true });
  assert.equal(result.r.status, 200);
  assert.equal(result.j.model_called, false);
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, beforeAi, 'local correction never calls AI');
  const saved = result.j.conversation;
  const savedTarget = saved.turns.find(turn => turn.turn_id === target.turn_id);
  assert.equal(savedTarget.text, '左手腕抬高会疼。最近端碗和开门都得慢一点。昨晚翻身时左手腕疼醒过一次。');
  assert.equal(savedTarget.version, currentTarget.version + 1);
  assert.equal(savedTarget.versions.at(-1).text, original);
  assert.equal(saved.turns.find(turn => turn.turn_id === correction.turn_id).superseded, true);
  assert.equal(saved.turns.find(turn => turn.turn_id === 'assistant-pending').superseded, true);
  assert.equal(saved.completeness, null);
  assert.equal(saved.manual_correction_analysis_pending, true);
  assert.equal(saved.report.status_label, '原话已修订 · 自动整理待更新');
  assert.match(saved.report.body, /自动整理待更新/);
  assert.match(saved.report.body, /使用者确认的原话修订（不代表医学结论）/);
  assert.match(saved.report.body, /文字修订，不代表医学判断/);
  assert.match(saved.report.body, /晚上睡觉暂时还没受什么影响。/);
  assert.match(saved.report.body, /昨晚翻身时左手腕疼醒过一次。/);
  assert.match(saved.report.body, /更正一下，刚才说晚上睡觉没受影响不准确/);
  assert.match(saved.report.body, /端碗和开门都得慢一点/);
  const updatedEvent = (await h.request(`/api/events/${event.record_id}`)).j.event;
  assert.equal(updatedEvent.raw_text, savedTarget.text);
  assert.equal(updatedEvent.version, event.version + 1);

  h.setResponse('/api/ai/conversation-turn', { action: 'reply', assistant_text: '我记下了。', provider: 'SyntheticTestProvider',
    completeness: { clinical_state: { functional_impact: { status: 'known',
      summary: '最近端碗和开门都得慢一点；昨晚翻身时左手腕疼醒过一次', evidence_turn_ids: [target.turn_id], context_ids: [] } },
      relevant_context_ids: [], contradictions: [], unknowns: [] } });
  const laterEdit = await h.request(`/api/conversations/${base.conversation_id}/turns/${target.turn_id}`, {
    text: `${savedTarget.text} 后来又补充了一句。`, expected_version: savedTarget.version,
    expected_conversation_version: saved.version,
  });
  assert.equal(laterEdit.r.status, 200);
  const laterHistory = laterEdit.j.conversation.report.sections.find(section => section.key === 'correction_history').lines[0];
  assert.match(laterHistory.text, /本次修订后的原句（第 2 版）/);
  assert.doesNotMatch(laterHistory.text, /本人选择后的当前原话/);
  assert.match(laterHistory.source_versions.find(version => version.version === 2).quote, /昨晚翻身时左手腕疼醒过一次/);

  const added = await h.say(laterEdit.j.conversation, '还有一点不舒服。');
  assert.equal(added.report.status_label, '自动整理 · 本人未核对');
  const impact = added.report.sections.find(section => section.key === 'symptoms_impact').lines.find(line => line.kind === 'summary');
  assert.match(impact.text, /端碗和开门都得慢一点/);
  assert.match(impact.text, /昨晚翻身时左手腕疼醒过一次/);
  assert.doesNotMatch(impact.text, /睡觉暂时还没受什么影响/);
  assert.equal(impact.source_versions[0].version, 3);
  const modelCall = h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1);
  const payload = JSON.parse(modelCall.body);
  assert.ok(payload.turns.some(turn => turn.text.includes('最近端碗和开门都得慢一点')));
  assert.ok(payload.turns.some(turn => turn.text.includes('昨晚翻身时左手腕疼醒过一次')));
  assert.ok(payload.turns.some(turn => turn.text === '还有一点不舒服。'));
  assert.equal(payload.turns.some(turn => turn.text === correctionText), false);
  assert.ok(added.turns.find(turn => turn.turn_id === correction.turn_id).superseded);
});

test('confirmed correction route rejects guessed replacement text, missing confirmation, stale versions, and non-sentence targets', async () => {
  const h = await harness();
  const base = await h.start();
  const text = '昨天左手腕疼。';
  const event = (await h.request('/api/events', { raw_text: text, source_kind: 'elder' })).j.event;
  const target = { turn_id: 'target-guard', role: 'elder', source_kind: 'elder', text, original_text: text, record_id: event.record_id, version: 1 };
  const correctionText = '更正一下，刚才说昨天左手腕疼不准确，应该是右手腕疼。';
  const correction = { turn_id: 'correction-guard', role: 'elder', source_kind: 'elder', text: correctionText, original_text: correctionText, version: 1 };
  const conversation = { ...base, turns: [base.turns[0], target, correction], version: 4,
    completeness: { contradictions: [{ text: '自然更正无法唯一定位旧原话，待核实。', evidence_turn_ids: [target.turn_id, correction.turn_id] }] } };
  await h.api.vault.put(`conversation:${base.conversation_id}`, conversation);
  const invoke = body => h.request(`/api/conversations/${base.conversation_id}/corrections/${correction.turn_id}`, body);
  const common = { expected_conversation_version: conversation.version, expected_correction_version: correction.version,
    target_turn_id: target.turn_id, expected_target_version: target.version, expected_event_version: event.version,
    old_quote: text, confirmed: true };
  assert.equal((await invoke({ ...common, replacement: '左手腕疼。' })).j.error, 'correction_replacement_must_come_from_source');
  assert.equal((await invoke({ ...common, confirmed: false })).j.error, 'correction_confirmation_required');
  assert.equal((await invoke({ ...common, expected_conversation_version: conversation.version - 1 })).j.error, 'stale_conversation');
  assert.equal((await invoke({ ...common, expected_target_version: target.version + 1 })).j.error, 'correction_target_invalid');
  assert.equal((await invoke({ ...common, expected_target_version: true })).j.error, 'correction_target_invalid');
  assert.equal((await invoke({ ...common, expected_correction_version: true })).j.error, 'stale_correction');
  assert.equal((await invoke({ ...common, old_quote: '左手腕疼' })).j.error, 'correction_target_invalid');
  assert.equal((await h.request(`/api/conversations/${base.conversation_id}`)).j.conversation.turns.find(turn => turn.turn_id === target.turn_id).text, text);
  assert.equal((await h.request(`/api/events/${event.record_id}`)).j.event.raw_text, text);
});

test('a failed correction transaction is atomic and a different active subject cannot read or apply it', async () => {
  const h = await harness();
  const base = await h.start();
  const text = '昨天左手腕疼。';
  const event = (await h.request('/api/events', { raw_text: text, source_kind: 'elder' })).j.event;
  const target = { turn_id: 'target-atomic', role: 'elder', source_kind: 'elder', text, original_text: text,
    record_id: event.record_id, version: 1 };
  const correctionText = '更正一下，刚才说昨天左手腕疼不准确，应该是右手腕疼。';
  const correction = { turn_id: 'correction-atomic', role: 'elder', source_kind: 'elder', text: correctionText,
    original_text: correctionText, version: 1 };
  const conversation = { ...base, turns: [base.turns[0], target, correction], version: 5,
    completeness: { contradictions: [{ text: '自然更正无法唯一定位旧原话，待核实。', evidence_turn_ids: [target.turn_id, correction.turn_id] }] } };
  await h.api.vault.put(`conversation:${base.conversation_id}`, conversation);
  const payload = { expected_conversation_version: conversation.version, expected_correction_version: correction.version,
    target_turn_id: target.turn_id, expected_target_version: target.version, expected_event_version: event.version,
    old_quote: text, confirmed: true };
  const path = `/api/conversations/${base.conversation_id}/corrections/${correction.turn_id}`;
  const driver = h.api.vault.driver, mutate = driver.mutateDocs.bind(driver);
  driver.mutateDocs = async () => { throw Object.assign(new Error('synthetic transaction abort'), { name: 'AbortError' }); };
  const failed = await h.request(path, payload);
  assert.equal(failed.j.error, 'correction_save_failed');
  assert.equal((await h.api.vault.get(`conversation:${base.conversation_id}`)).turns.find(turn => turn.turn_id === target.turn_id).text, text);
  assert.equal((await h.api.vault.get(`event:${event.record_id}`)).raw_text, text);
  driver.mutateDocs = mutate;

  const registry = (await h.request('/api/health-subjects')).j;
  const created = await h.request('/api/health-subjects', { label: '虚构家属校验', relationship: 'family', expected_version: registry.version });
  const family = created.j.subjects.find(subject => subject.relationship === 'family');
  const switched = await h.request('/api/health-subjects/active', { subject_id: family.subject_id, expected_version: created.j.version });
  assert.equal(switched.r.status, 200);
  assert.notEqual((await h.request(`/api/conversations/${base.conversation_id}`)).r.status, 200);
  assert.notEqual((await h.request(path, payload)).r.status, 200);
  assert.equal((await h.api.vault.get(`conversation:${base.conversation_id}`)).turns.find(turn => turn.turn_id === target.turn_id).text, text);
  assert.equal((await h.api.vault.get(`event:${event.record_id}`)).raw_text, text);
});
