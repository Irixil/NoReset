// Synthetic-only regression: linked archive audio correction in the same conversation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

// Public, deterministic one-second PCM WAV fixture. This is mechanical test data,
// not speech and not a private natural-audio/UI fixture.
const wav = (() => {
  const sampleRate = 8000, samples = Buffer.alloc(sampleRate * 2), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
})();

async function harness(driver = new core.MemoryDocumentStore(), responses = new Map()) {
  const elements = new Map(), calls = [];
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: '', focus() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: class { constructor() { return driver; } } },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: el, querySelector: () => null },
    fetch: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ path, body });
      const configured = responses.get(path);
      const json = typeof configured === 'function' ? await configured({ path, options, body })
        : configured || (path === '/api/app/session' ? { authenticated: false }
          : { provider: 'SyntheticMechanicalFixture', action: 'reply', assistant_text: '合成回复，仅用于本地机械测试。' });
      return { ok: true, status: 200, json: async () => json };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal, pass = 'synthetic-linked-audio-revision';
  if (!await driver.getMeta('vault')) await api.vault.setup(pass);
  const ready = api.initialise(); await new Promise(setImmediate);
  el('vaultPassphrase').value = pass; await el('vaultForm').onsubmit({ preventDefault() {} }); await ready;
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') => api.request(path, {
    method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Idempotency-Key': webcrypto.randomUUID() },
  });
  return { api, calls, driver, request, responses };
}

async function linkedCase(h, { revise = true, followup = true } = {}) {
  const originalText = '我咳嗽两天了，晚上明先些。';
  const correctedText = '我咳嗽两天了，晚上明显些。';
  const laterText = '刚才说的晚上咳嗽更明显。';
  const event = (await h.request('/api/events', { raw_text: originalText, source_kind: 'audio_transcript' })).j.event;
  const media = { media_id: 'media_' + webcrypto.randomUUID().replaceAll('-', ''), subject_id: event.subject_id,
    kind: 'audio', content_type: 'audio/wav', original_filename: 'synthetic-clear.wav', save_status: 'saved',
    recognition_status: 'succeeded', recognition: { text: originalText, is_mock: false },
    event_link: { record_id: event.record_id }, record_id: event.record_id, version: 2 };
  await h.api.vault.put('media:' + media.media_id, media);
  await h.api.vault.putBinary('media-binary:' + media.media_id, wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength), { content_type: 'audio/wav' });
  const reviewed = (await h.request('/api/events/' + event.record_id + '/source-review', {
    expected_version: event.version, compared_with_original: true,
  })).j.event;
  const currentMedia = (await h.request('/api/media/' + media.media_id)).j.media;
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const linked = await h.request('/api/conversations/' + conversation.conversation_id + '/turns', {
    text: originalText, record_id: event.record_id, media_id: media.media_id, source_kind: 'audio_transcript',
    source_version: reviewed.version, media_version: currentMedia.version, expected_version: conversation.version,
  });
  assert.equal(linked.r.ok, true, JSON.stringify(linked.j));
  if (followup === 'store') {
    const laterEvent = await h.request('/api/events', { raw_text: laterText, source_kind: 'elder' });
    assert.equal(laterEvent.r.ok, true, JSON.stringify(laterEvent.j));
    const key = `conversation:${conversation.conversation_id}`;
    const raw = await h.api.vault.get(key);
    const laterTurn = { turn_id: 'turn_synthetic_later_elder', role: 'elder', original_text: laterText, text: laterText,
      source_kind: 'elder', record_id: laterEvent.j.event.record_id, media_id: null,
      local_safety: laterEvent.j.event.local_safety, created_at: new Date().toISOString(), version: 1, versions: [] };
    await h.api.vault.put(key, { ...raw, turns: [...raw.turns, laterTurn], version: raw.version + 1, updated_at: new Date().toISOString() });
  } else if (followup) {
    const afterFollowup = await h.request('/api/conversations/' + conversation.conversation_id + '/turns', {
      text: laterText, source_kind: 'elder', expected_version: linked.j.conversation.version,
    });
    assert.equal(afterFollowup.r.ok, true, JSON.stringify(afterFollowup.j));
  }
  const revision = revise ? await h.request('/api/events/' + event.record_id + '/revise', {
    raw_text: correctedText, reason: '合成核对后模拟修正识别文字', expected_version: reviewed.version,
  }) : null;
  if (revision) assert.equal(revision.r.ok, true, JSON.stringify(revision.j));
  const latest = (await h.request('/api/conversations/' + conversation.conversation_id)).j.conversation;
  return { originalText, correctedText, laterText, event, media, conversation, revised: revision?.j.event || null, latest };
}

test('linked audio revision preserves current patient text and replaces only stale audio-derived analysis', async () => {
  const h = await harness(), x = await linkedCase(h);
  const liveElders = x.latest.turns.filter(turn => turn.role === 'elder' && !turn.superseded);
  const revisedAudio = liveElders.find(turn => turn.source_kind === 'audio_transcript' && turn.record_id === x.revised.record_id);
  const later = liveElders.find(turn => turn.text === x.laterText);
  assert.ok(revisedAudio, 'the current conversation should contain the revised source pending review');
  assert.equal(revisedAudio.text, x.correctedText);
  assert.equal(revisedAudio.audio_source_reviewed, false);
  assert.equal(revisedAudio.original_text, x.originalText);
  assert.ok(revisedAudio.versions.some(version => version.text === x.originalText));
  assert.ok(later, 'later patient wording must remain current and unchanged');
  assert.equal(x.latest.manual_correction_analysis_pending, true);
  assert.equal(x.latest.completeness, null);
  assert.equal(x.latest.analysis_sources, null);
  assert.deepEqual(Array.from(x.latest.relevant_health_context || []), []);
  assert.equal(x.latest.report, null, 'the revised text stays out of the report until its source is confirmed');
  assert.ok(x.latest.turns.some(turn => turn.text === x.laterText && !turn.superseded));
  assert.ok(x.latest.turns.some(turn => turn.role === 'assistant' && turn.superseded), 'stale assistant replies must be archived');
  const savedMedia = (await h.request('/api/media/' + x.media.media_id)).j.media;
  assert.equal(savedMedia.recognition.text, x.originalText);
  assert.deepEqual(Array.from(new Uint8Array((await h.api.vault.get('media-binary:' + x.media.media_id)).bytes)), Array.from(wav));
  assert.equal(safety.audioNeedsReview(x.revised), true);
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, 0, 'mechanical replay makes no network or model calls');
});

test('unreviewed linked audio blocks resume and corrected reorganization before any model request', async () => {
  const h = await harness(), x = await linkedCase(h);
  const resume = await h.request(`/api/conversations/${x.conversation.conversation_id}/resume-assistant`, {});
  assert.equal(resume.r.ok, true);
  assert.equal(resume.j.pending_reason, 'audio_source_review_required');
  const registry = (await h.request('/api/health-subjects')).j;
  const context = (await h.request('/api/health-context')).j.health_context;
  const organize = await h.request(`/api/conversations/${x.conversation.conversation_id}/reorganize-corrected`, {
    expected_conversation_version: x.latest.version, expected_subject_id: x.latest.subject_id,
    expected_subject_version: registry.version, expected_context_version: context.version,
  });
  assert.equal(organize.r.status, 409);
  assert.equal(organize.j.error, 'audio_source_review_required');
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, 0);
});

test('source confirmation restores the same conversation report and source versions without an automatic model call', async () => {
  const h = await harness(), x = await linkedCase(h);
  const confirmed = await h.request(`/api/events/${x.revised.record_id}/source-review`, {
    expected_version: x.revised.version, compared_with_original: true,
  });
  assert.equal(confirmed.r.ok, true, JSON.stringify(confirmed.j));
  const first = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  const second = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  const audioTurn = first.turns.find(turn => turn.role === 'elder' && turn.record_id === x.revised.record_id);
  assert.equal(audioTurn.text, x.correctedText);
  assert.equal(audioTurn.audio_source_reviewed, true);
  assert.equal(audioTurn.audio_source_version, confirmed.j.event.version);
  assert.equal(audioTurn.audio_source_media_version, (await h.request(`/api/media/${x.media.media_id}`)).j.media.version);
  assert.equal(audioTurn.audio_source_conversation_version, first.version);
  assert.ok(first.turns.some(turn => turn.text === x.laterText && !turn.superseded));
  assert.equal(first.manual_correction_analysis_pending, true);
  assert.equal(first.report.manual_correction_analysis_pending, true);
  assert.match(first.report.body, /晚上明显些/);
  assert.match(first.report.body, /刚才说的晚上咳嗽更明显/);
  assert.doesNotMatch(first.report.body, /晚上明先些/);
  assert.equal(second.version, first.version, 'normal GET must not add a revision on repeated reopen');
  assert.equal(JSON.stringify(second.report), JSON.stringify(first.report));
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, 0);
});

test('archive revision uses the stored conversation snapshot when its read projection refreshes a stale report', async () => {
  const h = await harness(), x = await linkedCase(h, { revise: false, followup: false });
  const key = `conversation:${x.conversation.conversation_id}`;
  const raw = await h.api.vault.get(key);
  await h.api.vault.put(key, { ...raw, report: { ...(raw.report || {}), format_version: 1, body: 'STALE REPORT PROJECTION' } });
  const projected = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  assert.doesNotMatch(projected.report.body, /STALE REPORT PROJECTION/);
  const currentEvent = (await h.request(`/api/events/${x.event.record_id}`)).j.event;
  const revision = await h.request(`/api/events/${x.event.record_id}/revise`, {
    raw_text: x.correctedText, reason: '合成报告投影视图刷新测试', expected_version: currentEvent.version,
  });
  assert.equal(revision.r.ok, true, JSON.stringify(revision.j));
  const after = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  assert.ok(after.turns.some(turn => turn.text === x.correctedText && !turn.superseded));
});

test('an explicitly reviewed audio correction can be reorganized once as analysis-only with exact current turns', async () => {
  const h = await harness(), x = await linkedCase(h, { followup: 'store' });
  const confirmed = await h.request(`/api/events/${x.revised.record_id}/source-review`, {
    expected_version: x.revised.version, compared_with_original: true,
  });
  assert.equal(confirmed.r.ok, true, JSON.stringify(confirmed.j));
  const current = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  h.responses.set('/api/app/session', { authenticated: true, csrf_token: 'synthetic-csrf' });
  h.responses.set('/api/app/config', { text_trial_required: false, text_trial: null });
  h.responses.set('/api/ai/conversation-turn', {
    action: 'reply', assistant_text: '合成整理结果，不进入患者对话。', provider: 'SyntheticMechanicalFixture',
    trace_id: 'synthetic-audio-correction-reorg',
    completeness: { clinical_state: {}, relevant_context_ids: [], contradictions: [], unknowns: [], evidence_turn_ids: [] },
  });
  const beforeCalls = h.calls.filter(call => call.path === '/api/ai/conversation-turn').length;
  const snapshot = await h.request('/api/health-subjects');
  const context = await h.request('/api/health-context');
  const result = await h.request(`/api/conversations/${current.conversation_id}/reorganize-corrected`, {
    expected_conversation_version: current.version, expected_subject_id: current.subject_id,
    expected_subject_version: snapshot.j.version, expected_context_version: context.j.health_context.version,
  });
  assert.equal(result.r.ok, true, JSON.stringify(result.j));
  assert.equal(result.j.reason, 'completed');
  const payload = h.calls.filter(call => call.path === '/api/ai/conversation-turn').at(-1).body;
  const sentTexts = payload.turns.map(turn => turn.text);
  assert.equal(sentTexts.filter(text => text === x.correctedText).length, 1);
  assert.equal(sentTexts.filter(text => text === x.laterText).length, 1);
  assert.equal(JSON.stringify(payload).includes(x.originalText), false);
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, beforeCalls + 1);
  assert.equal(result.j.conversation.manual_correction_analysis_pending, false);
  assert.equal(result.j.conversation.turns.filter(turn => turn.role === 'elder').length, 2);
  assert.equal(result.j.conversation.turns.some(turn => turn.text === '合成整理结果，不进入患者对话。'), false);
  assert.equal(result.j.conversation.manual_correction_reorganization.result_provenance, 'operation_analysis_only_v1');
});

test('a media version change while corrected audio reorganization is in flight prevents applying its analysis', async () => {
  const h = await harness(), x = await linkedCase(h, { followup: 'store' });
  const confirmed = await h.request(`/api/events/${x.revised.record_id}/source-review`, {
    expected_version: x.revised.version, compared_with_original: true,
  });
  assert.equal(confirmed.r.ok, true, JSON.stringify(confirmed.j));
  const current = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  h.responses.set('/api/app/session', { authenticated: true, csrf_token: 'synthetic-csrf' });
  h.responses.set('/api/app/config', { text_trial_required: false, text_trial: null });
  h.responses.set('/api/ai/conversation-turn', async () => {
    const media = await h.api.vault.get(`media:${x.media.media_id}`);
    await h.api.vault.put(`media:${x.media.media_id}`, { ...media, version: media.version + 1 });
    return { action: 'reply', assistant_text: '此结果因来源版本变化不得写入。', provider: 'SyntheticMechanicalFixture',
      trace_id: 'synthetic-stale-audio-reorg',
      completeness: { clinical_state: {}, relevant_context_ids: [], contradictions: [], unknowns: [], evidence_turn_ids: [] } };
  });
  const beforeCalls = h.calls.filter(call => call.path === '/api/ai/conversation-turn').length;
  const registry = await h.request('/api/health-subjects'), context = await h.request('/api/health-context');
  const result = await h.request(`/api/conversations/${current.conversation_id}/reorganize-corrected`, {
    expected_conversation_version: current.version, expected_subject_id: current.subject_id,
    expected_subject_version: registry.j.version, expected_context_version: context.j.health_context.version,
  });
  assert.equal(result.r.ok, true, JSON.stringify(result.j));
  assert.equal(result.j.dispatched, true);
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, beforeCalls + 1);
  assert.equal(result.j.conversation.manual_correction_analysis_pending, true);
  assert.equal(result.j.conversation.completeness, null);
  assert.equal(result.j.conversation.turns.some(turn => turn.text === '此结果因来源版本变化不得写入。'), false);
  assert.equal(result.j.conversation.turns.filter(turn => turn.role === 'elder').length, 2);
});

test('storage failure while revising leaves event, linked conversation, audio and history unchanged', async () => {
  const h = await harness(), x = await linkedCase(h, { revise: false });
  const beforeEvent = (await h.request(`/api/events/${x.event.record_id}`)).j.event;
  const beforeConversation = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  const mutate = h.driver.mutateDocs.bind(h.driver);
  h.driver.mutateDocs = async () => { throw new Error('synthetic_write_failure'); };
  const failed = await h.request(`/api/events/${x.event.record_id}/revise`, {
    raw_text: x.correctedText, reason: '合成核对后模拟修正识别文字', expected_version: beforeEvent.version,
  });
  h.driver.mutateDocs = mutate;
  assert.equal(failed.r.ok, false);
  assert.equal((await h.request(`/api/events/${x.event.record_id}`)).j.event.raw_text, beforeEvent.raw_text);
  const after = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  assert.equal(after.version, beforeConversation.version);
  assert.deepEqual(Array.from(after.turns, turn => [turn.turn_id, turn.text, turn.superseded]),
    Array.from(beforeConversation.turns, turn => [turn.turn_id, turn.text, turn.superseded]));
  assert.equal((await h.request(`/api/media/${x.media.media_id}`)).j.media.recognition.text, x.originalText);
  assert.deepEqual(Array.from(new Uint8Array((await h.api.vault.get('media-binary:' + x.media.media_id)).bytes)), Array.from(wav));
});

test('a cross-realm conversation append wins over late archive revision and is not overwritten', async () => {
  const h = await harness(), x = await linkedCase(h, { revise: false }), other = await harness(h.driver);
  const conversationBefore = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  const eventBefore = (await h.request(`/api/events/${x.event.record_id}`)).j.event;
  const appendText = '虚构并发追加：刚刚又补充了一句。';
  const mutate = h.driver.mutateDocs.bind(h.driver); let armed = true, concurrent = null;
  h.driver.mutateDocs = async (puts, deletes, expectedVault, expectedDocuments) => {
    if (armed && puts?.some(item => item.key === `event:${x.event.record_id}`)) {
      armed = false;
      concurrent = await other.request(`/api/conversations/${x.conversation.conversation_id}/turns`, {
        text: appendText, source_kind: 'elder', expected_version: conversationBefore.version,
      });
      assert.equal(concurrent.r.ok, true, JSON.stringify(concurrent.j));
    }
    return mutate(puts, deletes, expectedVault, expectedDocuments);
  };
  const revision = await h.request(`/api/events/${x.event.record_id}/revise`, {
    raw_text: x.correctedText, reason: '合成并发修订测试', expected_version: eventBefore.version,
  });
  h.driver.mutateDocs = mutate;
  assert.equal(armed, false, 'the race hook must observe the archive-revision commit');
  assert.equal(concurrent?.r.ok, true, JSON.stringify(concurrent?.j));
  assert.equal(revision.r.ok, false, JSON.stringify({ message: 'revision must reject its stale conversation snapshot', concurrent: concurrent?.j, revision: revision.j }));
  assert.equal((await h.request(`/api/events/${x.event.record_id}`)).j.event.state, 'inbox');
  const after = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  assert.ok(after.turns.some(turn => turn.text === appendText && !turn.superseded), JSON.stringify({ concurrent: concurrent?.j, revision: revision.j, turns: after.turns }));
  assert.equal(after.turns.some(turn => turn.text === x.correctedText), false);
});
