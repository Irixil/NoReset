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
  return { api, calls, driver, request, responses, context };
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

test('linked audio revision cannot rewrite an older own turn after a later own message', async () => {
  const h = await harness(), x = await linkedCase(h, { revise: false });
  const before = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  const currentEvent = (await h.request(`/api/events/${x.event.record_id}`)).j.event;
  const revision = await h.request(`/api/events/${x.event.record_id}/revise`, {
    raw_text: x.correctedText, reason: '合成验证旧消息修订保护', expected_version: currentEvent.version,
  });
  assert.equal(revision.r.status, 409);
  assert.equal(revision.j.error, 'conversation_turn_not_latest');
  const after = (await h.request(`/api/conversations/${x.conversation.conversation_id}`)).j.conversation;
  assert.equal(after.version, before.version);
  assert.deepEqual(Array.from(after.turns, turn => [turn.turn_id, turn.text, turn.superseded]),
    Array.from(before.turns, turn => [turn.turn_id, turn.text, turn.superseded]));
  assert.equal((await h.request(`/api/events/${x.event.record_id}`)).j.event.raw_text, x.originalText);
});

test('a latest linked audio revision invalidates stale analysis without rewriting unrelated turns', async () => {
  const h = await harness(), x = await linkedCase(h, { followup: false });
  const liveElders = x.latest.turns.filter(turn => turn.role === 'elder' && !turn.superseded);
  const revisedAudio = liveElders.find(turn => turn.source_kind === 'audio_transcript' && turn.record_id === x.revised.record_id);
  assert.ok(revisedAudio, 'the current conversation should contain the revised source pending review');
  assert.equal(revisedAudio.text, x.correctedText);
  assert.equal(revisedAudio.audio_source_reviewed, false);
  assert.equal(revisedAudio.original_text, x.originalText);
  assert.ok(revisedAudio.versions.some(version => version.text === x.originalText));
  assert.equal(x.latest.manual_correction_analysis_pending, true);
  assert.equal(x.latest.completeness, null);
  assert.equal(x.latest.analysis_sources, null);
  assert.deepEqual(Array.from(x.latest.relevant_health_context || []), []);
  assert.equal(x.latest.report, null, 'the revised text stays out of the report until its source is confirmed');
  assert.ok(x.latest.turns.some(turn => turn.role === 'assistant' && turn.superseded), 'stale assistant replies must be archived');
  const savedMedia = (await h.request('/api/media/' + x.media.media_id)).j.media;
  assert.equal(savedMedia.recognition.text, x.originalText);
  assert.deepEqual(Array.from(new Uint8Array((await h.api.vault.get('media-binary:' + x.media.media_id)).bytes)), Array.from(wav));
  assert.equal(safety.audioNeedsReview(x.revised), true);
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, 0, 'mechanical replay makes no network or model calls');
});

test('unreviewed linked audio blocks resume and corrected reorganization before any model request', async () => {
  const h = await harness(), x = await linkedCase(h, { followup: false });
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
  const h = await harness(), x = await linkedCase(h, { followup: false });
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
  assert.equal(first.manual_correction_analysis_pending, true);
  assert.equal(first.report.manual_correction_analysis_pending, true);
  assert.match(first.report.body, /晚上明显些/);
  assert.doesNotMatch(first.report.body, /晚上明先些/);
  assert.equal(second.version, first.version, 'normal GET must not add a revision on repeated reopen');
  assert.equal(JSON.stringify(second.report), JSON.stringify(first.report));
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, 0);
});

test('editing an older own turn is rejected even when the request carries the current conversation version', async () => {
  const h = await harness();
  let conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const first = await h.request(`/api/conversations/${conversation.conversation_id}/turns`, {
    text: '虚构原话甲：早上咳嗽。', source_kind: 'elder', expected_version: conversation.version,
  });
  assert.equal(first.r.ok, true, JSON.stringify(first.j));
  conversation = first.j.conversation;
  const firstTurn = conversation.turns.find(turn => turn.role === 'elder');
  const second = await h.request(`/api/conversations/${conversation.conversation_id}/turns`, {
    text: '虚构原话乙：晚上更明显。', source_kind: 'elder', expected_version: conversation.version,
  });
  assert.equal(second.r.ok, true, JSON.stringify(second.j));
  conversation = second.j.conversation;
  const saved = await h.request(`/api/conversations/${conversation.conversation_id}/turns/${firstTurn.turn_id}`, {
    text: '虚构改写：早上没有咳嗽。', expected_version: firstTurn.version,
    expected_conversation_version: conversation.version,
  });
  assert.equal(saved.r.ok, false);
  assert.equal(saved.r.status, 409);
  assert.match(saved.j.error, /latest|editable|old_turn/);
  const reopened = (await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.equal(reopened.turns.find(turn => turn.turn_id === firstTurn.turn_id).text, '虚构原话甲：早上咳嗽。');
  assert.ok(reopened.turns.some(turn => turn.text === '虚构原话乙：晚上更明显。' && !turn.superseded));
});

test('editing the latest own turn remains allowed after an assistant response', async () => {
  const h = await harness();
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const sent = await h.request(`/api/conversations/${conversation.conversation_id}/turns`, {
    text: '虚构最新原话：膝盖不舒服。', source_kind: 'elder', expected_version: conversation.version,
  });
  assert.equal(sent.r.ok, true, JSON.stringify(sent.j));
  const latest = sent.j.conversation.turns.find(turn => turn.role === 'elder');
  assert.ok(sent.j.conversation.turns.some(turn => turn.role === 'assistant' && !turn.superseded));
  const edited = await h.request(`/api/conversations/${conversation.conversation_id}/turns/${latest.turn_id}`, {
    text: '虚构修正：膝盖有些不舒服。', expected_version: latest.version,
    expected_conversation_version: sent.j.conversation.version,
  });
  assert.equal(edited.r.ok, true, JSON.stringify(edited.j));
});

test('an older pending audio turn cannot hide the newest own text from store edit checks', async () => {
  const h = await harness();
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const key = `conversation:${conversation.conversation_id}`;
  const stored = await h.api.vault.get(key);
  const turns = [
    { turn_id: 'turn_synthetic_old_pending_audio', role: 'elder', source_kind: 'audio_transcript',
      audio_source_reviewed: false, text: '旧的虚构待核对录音。', version: 1, versions: [] },
    { turn_id: 'turn_synthetic_new_text', role: 'elder', source_kind: 'elder',
      text: '后来补充的虚构文字。', version: 1, versions: [] },
  ];
  await h.api.vault.put(key, { ...stored, status: 'paused', turns, version: stored.version + 1 });
  const saved = await h.request(`/api/conversations/${conversation.conversation_id}/turns/turn_synthetic_new_text`, {
    text: '后来补充的虚构文字，改了标点。', expected_version: 1, expected_conversation_version: stored.version + 1,
  });
  assert.equal(saved.r.ok, true, JSON.stringify(saved.j));
  assert.equal(saved.j.conversation.turns.find(turn => turn.turn_id === 'turn_synthetic_new_text').text,
    '后来补充的虚构文字，改了标点。');
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, 0);
});

test('conversation deletion follows only media explicitly linked from its turns', async () => {
  const h = await harness();
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const linkedId = 'media_synthetic_reverse_link';
  const unrelatedId = 'media_synthetic_unlinked';
  const media = id => ({ media_id: id, subject_id: 'subject_self', kind: 'audio', save_status: 'saved', version: 1 });
  await h.api.vault.put(`media:${linkedId}`, media(linkedId));
  await h.api.vault.putBinary(`media-binary:${linkedId}`, new Uint8Array([1, 2, 3]).buffer, { content_type: 'audio/wav' });
  await h.api.vault.put(`media:${unrelatedId}`, media(unrelatedId));
  await h.api.vault.putBinary(`media-binary:${unrelatedId}`, new Uint8Array([4, 5, 6]).buffer, { content_type: 'audio/wav' });
  const key = `conversation:${conversation.conversation_id}`;
  const stored = await h.api.vault.get(key);
  await h.api.vault.put(key, { ...stored, turns: [...stored.turns, {
    turn_id: 'turn_synthetic_media_owner', role: 'elder', text: '虚构录音消息。', source_kind: 'elder',
    media_id: linkedId, version: 1, created_at: new Date().toISOString(),
  }], version: stored.version + 1 });
  const removed = await h.request(`/api/conversations/${conversation.conversation_id}`, {
    delete_scope_confirmed: true, expected_version: conversation.version + 1,
  }, 'DELETE');
  assert.equal(removed.r.ok, true, JSON.stringify(removed.j));
  assert.deepEqual(Array.from(removed.j.deleted.media_ids), [linkedId]);
  assert.equal(await h.api.vault.get(`media:${linkedId}`), undefined);
  assert.equal(await h.api.vault.get(`media-binary:${linkedId}`), undefined);
  assert.ok(await h.api.vault.get(`media:${unrelatedId}`));
  assert.ok(await h.api.vault.get(`media-binary:${unrelatedId}`));
});

test('conversation deletion preserves media that another conversation also references', async () => {
  const h = await harness();
  const first = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const second = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-11' })).j.conversation;
  const mediaId = 'media_synthetic_shared_turn_reference';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved', version: 1 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([1, 2, 3]).buffer, { content_type: 'audio/wav' });
  for (const conversation of [first, second]) {
    const key = `conversation:${conversation.conversation_id}`, stored = await h.api.vault.get(key);
    await h.api.vault.put(key, { ...stored, turns: [...stored.turns, {
      turn_id: 'turn_synthetic_shared_' + conversation.conversation_id, role: 'elder', text: '虚构共享来源消息。',
      source_kind: 'elder', media_id: mediaId, version: 1, created_at: new Date().toISOString(),
      ...(conversation === second ? { superseded: true } : {}),
    }], version: stored.version + 1 });
  }
  const current = (await h.request(`/api/conversations/${first.conversation_id}`)).j.conversation;
  const result = await h.request(`/api/conversations/${first.conversation_id}`, {
    delete_scope_confirmed: true, expected_version: current.version,
  }, 'DELETE');
  assert.equal(result.r.status, 409);
  assert.equal(result.j.error, 'conversation_source_shared');
  assert.ok(await h.api.vault.get(`media:${mediaId}`));
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
  assert.ok(await h.api.vault.get(`conversation:${first.conversation_id}`));
});

test('conversation deletion refuses to remove an explicitly referenced original owned by another subject', async () => {
  const h = await harness();
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const mediaId = 'media_synthetic_other_subject';
  const foreignMedia = { media_id: mediaId, subject_id: 'subject_fictional_family', kind: 'audio',
    save_status: 'saved', recognition_status: 'failed', link_status: 'not_linked', version: 1 };
  await h.api.vault.put(`media:${mediaId}`, foreignMedia);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([5, 6]).buffer, { content_type: 'audio/wav' });
  const key = `conversation:${conversation.conversation_id}`, stored = await h.api.vault.get(key);
  await h.api.vault.put(key, { ...stored, turns: [...stored.turns, {
    turn_id: 'turn_synthetic_wrong_owner', role: 'elder', source_kind: 'audio_transcript',
    media_id: mediaId, text: '虚构原话错误引用了其他所属人的原件。', version: 1,
  }], version: stored.version + 1 });

  const result = await h.request(`/api/conversations/${conversation.conversation_id}`, {
    delete_scope_confirmed: true, expected_version: conversation.version + 1,
  }, 'DELETE');
  assert.equal(result.r.status, 409);
  assert.equal(result.j.error, 'conversation_media_owner_mismatch');
  assert.ok(await h.api.vault.get(`conversation:${conversation.conversation_id}`));
  assert.deepEqual(await h.api.vault.get(`media:${mediaId}`), foreignMedia);
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
});

test('standalone media deletion requires confirmation and removes only its own local bytes and operation records', async () => {
  const h = await harness();
  const target = { media_id: 'media_synthetic_standalone', subject_id: 'subject_self', kind: 'audio',
    save_status: 'saved', recognition_status: 'failed', link_status: 'not_linked', version: 3 };
  const keep = { ...target, media_id: 'media_synthetic_keep', version: 1 };
  await h.api.vault.put(`media:${target.media_id}`, target);
  await h.api.vault.putBinary(`media-binary:${target.media_id}`, new Uint8Array([1, 2]).buffer, { content_type: 'audio/wav' });
  await h.api.vault.put(`media:${keep.media_id}`, keep);
  await h.api.vault.putBinary(`media-binary:${keep.media_id}`, new Uint8Array([3, 4]).buffer, { content_type: 'audio/wav' });
  await h.api.vault.put('operation:media-recognition:synthetic-delete', { media_id: target.media_id });
  const denied = await h.request(`/api/media/${target.media_id}`, { expected_version: target.version }, 'DELETE');
  assert.equal(denied.r.status, 400);
  const deleted = await h.request(`/api/media/${target.media_id}`, {
    expected_version: target.version, delete_scope_confirmed: true,
  }, 'DELETE');
  assert.equal(deleted.r.ok, true, JSON.stringify(deleted.j));
  assert.equal(await h.api.vault.get(`media:${target.media_id}`), undefined);
  assert.equal(await h.api.vault.get(`media-binary:${target.media_id}`), undefined);
  assert.equal(await h.api.vault.get('operation:media-recognition:synthetic-delete'), undefined);
  assert.ok(await h.api.vault.get(`media:${keep.media_id}`));
  assert.ok(await h.api.vault.get(`media-binary:${keep.media_id}`));
});

test('standalone media deletion rejects event-linked and currently processing originals without removing them', async () => {
  const h = await harness();
  const event = (await h.request('/api/events', { raw_text: '虚构关联原话。', source_kind: 'elder' })).j.event;
  const linked = { media_id: 'media_synthetic_linked', subject_id: 'subject_self', kind: 'audio',
    save_status: 'saved', recognition_status: 'failed', link_status: 'linked', event_link: { record_id: event.record_id },
    record_id: event.record_id, version: 2 };
  const processing = { media_id: 'media_synthetic_processing', subject_id: 'subject_self', kind: 'audio',
    save_status: 'saved', recognition_status: 'processing', updated_at: new Date().toISOString(), version: 4 };
  for (const media of [linked, processing]) {
    await h.api.vault.put(`media:${media.media_id}`, media);
    await h.api.vault.putBinary(`media-binary:${media.media_id}`, new Uint8Array([8, 9]).buffer, { content_type: 'audio/wav' });
  }
  for (const media of [linked, processing]) {
    const result = await h.request(`/api/media/${media.media_id}`, {
      expected_version: media.version, delete_scope_confirmed: true,
    }, 'DELETE');
    assert.equal(result.r.ok, false);
    assert.equal(result.r.status, 409);
    assert.ok(await h.api.vault.get(`media:${media.media_id}`));
    assert.ok(await h.api.vault.get(`media-binary:${media.media_id}`));
  }
});

test('standalone media deletion rejects an original explicitly referenced by another synthetic owner', async () => {
  const h = await harness();
  const mediaId = 'media_synthetic_foreign_conversation_ref';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
    recognition_status: 'failed', link_status: 'not_linked', version: 1 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([5, 6]).buffer, { content_type: 'audio/wav' });
  const foreignId = 'conversation_synthetic_foreign_owner';
  await h.api.vault.put(`conversation:${foreignId}`, { conversation_id: foreignId, subject_id: 'subject_fictional_family',
    turns: [{ turn_id: 'turn_synthetic_foreign_owner', role: 'elder', source_kind: 'audio_transcript', media_id: mediaId,
      record_id: null, text: '虚构家属原件关联。', version: 1 }], version: 1 });
  const result = await h.request(`/api/media/${mediaId}`, { delete_scope_confirmed: true, expected_version: 1 }, 'DELETE');
  assert.equal(result.r.status, 409);
  assert.equal(result.j.error, 'media_linked');
  assert.ok(await h.api.vault.get(`media:${mediaId}`));
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
});

test('an unused original with a stale conversation pointer can be deleted without changing that conversation', async () => {
  const h = await harness();
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const mediaId = 'media_synthetic_stale_conversation_pointer';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
    recognition_status: 'failed', link_status: 'not_linked', conversation_id: conversation.conversation_id, version: 3 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([7, 8, 9]).buffer, { content_type: 'audio/wav' });
  const beforeConversation = await h.api.vault.get(`conversation:${conversation.conversation_id}`);

  const listed = await h.request('/api/media');
  const projection = listed.j.media.find(item => item.media_id === mediaId);
  assert.equal(JSON.stringify(projection.delete_eligibility), JSON.stringify({ allowed: true, reason: 'eligible' }));
  const deleted = await h.request(`/api/media/${mediaId}`, {
    expected_version: media.version, delete_scope_confirmed: true,
  }, 'DELETE');
  assert.equal(deleted.r.ok, true, JSON.stringify(deleted.j));
  assert.equal(await h.api.vault.get(`media:${mediaId}`), undefined);
  assert.equal(await h.api.vault.get(`media-binary:${mediaId}`), undefined);
  assert.deepEqual(await h.api.vault.get(`conversation:${conversation.conversation_id}`), beforeConversation);
});

test('an unused original with a dangling conversation id can be deleted without creating or deleting a conversation', async () => {
  const h = await harness();
  const mediaId = 'media_synthetic_dangling_conversation_pointer';
  const missingConversationId = 'conversation_synthetic_deleted_before_original';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
    recognition_status: 'interrupted', link_status: 'not_linked', conversation_id: missingConversationId, version: 2 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([3, 1, 4]).buffer, { content_type: 'audio/wav' });
  assert.equal(await h.api.vault.get(`conversation:${missingConversationId}`), undefined);
  const listed = await h.request('/api/media');
  assert.equal(JSON.stringify(listed.j.media.find(item => item.media_id === mediaId).delete_eligibility),
    JSON.stringify({ allowed: true, reason: 'eligible' }));
  const deleted = await h.request(`/api/media/${mediaId}`, {
    expected_version: media.version, delete_scope_confirmed: true,
  }, 'DELETE');
  assert.equal(deleted.r.ok, true, JSON.stringify(deleted.j));
  assert.equal(await h.api.vault.get(`conversation:${missingConversationId}`), undefined);
  assert.equal(await h.api.vault.get(`media:${mediaId}`), undefined);
  assert.equal(await h.api.vault.get(`media-binary:${mediaId}`), undefined);
});

test('an original whose stored conversation pointer belongs to another subject is not deletable', async () => {
  const h = await harness();
  const mediaId = 'media_synthetic_wrong_owner_pointer';
  const conversationId = 'conversation_synthetic_other_subject_pointer';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
    recognition_status: 'failed', link_status: 'not_linked', conversation_id: conversationId, version: 1 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([6]).buffer, { content_type: 'audio/wav' });
  await h.api.vault.put(`conversation:${conversationId}`, { conversation_id: conversationId, subject_id: 'subject_synthetic_family', turns: [] });
  const listed = await h.request('/api/media');
  assert.equal(JSON.stringify(listed.j.media.find(item => item.media_id === mediaId).delete_eligibility),
    JSON.stringify({ allowed: false, reason: 'owner_unknown' }));
  const denied = await h.request(`/api/media/${mediaId}`, { expected_version: 1, delete_scope_confirmed: true }, 'DELETE');
  assert.equal(denied.r.status, 409);
  assert.equal(denied.j.error, 'media_owner_unknown');
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
});

test('an original explicitly referenced only from turn history stays protected', async () => {
  const h = await harness();
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const mediaId = 'media_synthetic_historical_version_reference';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
    recognition_status: 'failed', link_status: 'not_linked', conversation_id: conversation.conversation_id, version: 1 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([2, 4]).buffer, { content_type: 'audio/wav' });
  const key = `conversation:${conversation.conversation_id}`, stored = await h.api.vault.get(key);
  await h.api.vault.put(key, { ...stored, turns: [...stored.turns, {
    turn_id: 'turn_synthetic_old_audio_version', role: 'elder', text: '虚构的历史原话版本。',
    versions: [{ version: 1, media_id: mediaId }],
  }] });

  const listed = await h.request('/api/media');
  assert.equal(JSON.stringify(listed.j.media.find(item => item.media_id === mediaId).delete_eligibility),
    JSON.stringify({ allowed: false, reason: 'linked' }));
  const denied = await h.request(`/api/media/${mediaId}`, {
    expected_version: media.version, delete_scope_confirmed: true,
  }, 'DELETE');
  assert.equal(denied.r.status, 409);
  assert.equal(denied.j.error, 'media_linked');
  assert.ok(await h.api.vault.get(`media:${mediaId}`));
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
});

test('an original referenced only by a retained event-history snapshot stays protected', async () => {
  const h = await harness();
  const mediaId = 'media_synthetic_event_history_reference';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
    recognition_status: 'interrupted', link_status: 'not_linked', version: 1 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([8, 3]).buffer, { content_type: 'audio/wav' });
  await h.api.vault.put('history:record_synthetic_old_audio:1:fixture', {
    action: 'synthetic_fixture', snapshot: { record_id: 'record_synthetic_old_audio', source_media_id: mediaId },
  });
  const listed = await h.request('/api/media');
  assert.equal(JSON.stringify(listed.j.media.find(item => item.media_id === mediaId).delete_eligibility),
    JSON.stringify({ allowed: false, reason: 'linked' }));
  const denied = await h.request(`/api/media/${mediaId}`, { expected_version: 1, delete_scope_confirmed: true }, 'DELETE');
  assert.equal(denied.r.status, 409);
  assert.equal(denied.j.error, 'media_linked');
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
});

test('trial-controlled and uploading originals expose distinct delete blocks and remain intact', async () => {
  const h = await harness();
  const controlledId = 'media_synthetic_trial_controlled_delete';
  const globalTrialId = 'media_synthetic_global_trial_owner_delete';
  const pendingId = 'media_synthetic_link_pending_delete';
  const uploadingId = 'media_synthetic_uploading_delete';
  for (const media of [
    { media_id: controlledId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
      recognition_status: 'failed', link_status: 'not_linked', version: 1,
      trial_control: { state: 'stopped', media_id: controlledId } },
    { media_id: globalTrialId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
      recognition_status: 'failed', link_status: 'not_linked', version: 1 },
    { media_id: pendingId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
      recognition_status: 'not_started', link_status: 'pending', link_pending_reason: 'conversation_link_pending', version: 1 },
    { media_id: uploadingId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
      recognition_status: 'not_started', link_status: 'not_linked', version: 1 },
  ]) {
    await h.api.vault.put(`media:${media.media_id}`, media);
    await h.api.vault.putBinary(`media-binary:${media.media_id}`, new Uint8Array([1]).buffer, { content_type: 'audio/wav' });
  }
  await h.api.vault.put('trial-control:voice', { state: 'stopped', media_id: globalTrialId });
  await h.api.vault.put('upload:upload_synthetic_delete_gate', { upload_id: 'upload_synthetic_delete_gate', media_id: uploadingId });
  const listed = await h.request('/api/media');
  const byId = new Map(listed.j.media.map(item => [item.media_id, item.delete_eligibility]));
  assert.equal(JSON.stringify(byId.get(controlledId)), JSON.stringify({ allowed: false, reason: 'trial_controlled' }));
  assert.equal(JSON.stringify(byId.get(globalTrialId)), JSON.stringify({ allowed: false, reason: 'trial_controlled' }));
  assert.equal(JSON.stringify(byId.get(pendingId)), JSON.stringify({ allowed: false, reason: 'link_pending' }));
  assert.equal(JSON.stringify(byId.get(uploadingId)), JSON.stringify({ allowed: false, reason: 'upload_in_progress' }));
  for (const [mediaId, error] of [[controlledId, 'media_trial_controlled'], [globalTrialId, 'media_trial_controlled'],
    [pendingId, 'media_link_pending'], [uploadingId, 'media_upload_in_progress']]) {
    const denied = await h.request(`/api/media/${mediaId}`, { expected_version: 1, delete_scope_confirmed: true }, 'DELETE');
    assert.equal(denied.r.status, 409);
    assert.equal(denied.j.error, error);
    assert.ok(await h.api.vault.get(`media:${mediaId}`));
    assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
  }
});

test('stale processing projection stays protected only while the original audio lock is held', async () => {
  const h = await harness();
  const mediaId = 'media_synthetic_stale_but_active_audio';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', save_status: 'saved',
    recognition_status: 'processing', link_status: 'not_linked', updated_at: '2026-10-22T00:00:00.000Z', version: 2 };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([4, 2]).buffer, { content_type: 'audio/wav' });
  h.context.navigator.locks = { query: async () => ({
    held: [{ name: 'bingli-audio-recognition-active-v1' }], pending: [],
  }) };

  const listed = await h.request('/api/media');
  assert.equal(JSON.stringify(listed.j.media.find(item => item.media_id === mediaId).delete_eligibility),
    JSON.stringify({ allowed: false, reason: 'processing' }));
  const denied = await h.request(`/api/media/${mediaId}`, { expected_version: 2, delete_scope_confirmed: true }, 'DELETE');
  assert.equal(denied.r.status, 409);
  assert.equal(denied.j.error, 'media_processing');
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));

  h.context.navigator.locks.query = async () => ({ held: [], pending: [] });
  const releasedProjection = await h.request('/api/media');
  assert.equal(JSON.stringify(releasedProjection.j.media.find(item => item.media_id === mediaId).delete_eligibility),
    JSON.stringify({ allowed: true, reason: 'eligible' }));
  const removed = await h.request(`/api/media/${mediaId}`, { expected_version: 2, delete_scope_confirmed: true }, 'DELETE');
  assert.equal(removed.r.ok, true, JSON.stringify(removed.j));
  assert.equal(await h.api.vault.get(`media-binary:${mediaId}`), undefined);
});

test('media deletion and a new conversation turn cannot race into a dangling source', async () => {
  const h = await harness();
  const conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  const mediaId = 'media_synthetic_delete_cas_race';
  const media = { media_id: mediaId, subject_id: 'subject_self', kind: 'audio', content_type: 'audio/wav',
    save_status: 'saved', recognition_status: 'failed', link_status: 'not_linked', version: 2,
    conversation_id: conversation.conversation_id };
  await h.api.vault.put(`media:${mediaId}`, media);
  await h.api.vault.putBinary(`media-binary:${mediaId}`, new Uint8Array([2, 7, 1, 8]).buffer, { content_type: 'audio/wav' });
  const key = `conversation:${conversation.conversation_id}`;
  const before = await h.api.vault.get(key);
  const originalMutate = h.api.vault.mutate.bind(h.api.vault);
  let injected = false;
  h.api.vault.mutate = async changes => {
    if (!injected && changes.deletes?.includes(`media:${mediaId}`)) {
      injected = true;
      await h.api.vault.put(key, { ...before, turns: [...before.turns, {
        turn_id: 'turn_synthetic_concurrent_media_reference', role: 'elder', media_id: mediaId,
        text: '合成并发引用。', version: 1,
      }] });
    }
    return originalMutate(changes);
  };
  const deleted = await h.request(`/api/media/${mediaId}`, {
    expected_version: media.version, delete_scope_confirmed: true,
  }, 'DELETE');
  const remains = await h.api.vault.get(`media:${mediaId}`);
  assert.equal(injected, true);
  assert.equal(deleted.r.status, 409);
  assert.equal(deleted.j.error, 'stale_version');
  assert.ok(remains);
  assert.ok(await h.api.vault.get(`media-binary:${mediaId}`));
  const savedConversation = await h.api.vault.get(key);
  assert.equal(savedConversation.turns.some(turn => turn.media_id === mediaId), true);
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

test('current machine transcript can refresh and export with provenance, then a user edit invalidates stale analysis without claiming review', async () => {
  const h = await harness(), conversation = (await h.request('/api/conversations/start', { mode: 'new', local_date: '2026-10-10' })).j.conversation;
  h.responses.set('/api/app/session', () => ({ authenticated: true, csrf_token: 'synthetic-session' }));
  const event = (await h.request('/api/events', { raw_text: '虚构录音：膝盖痛两天。', source_kind: 'audio_transcript' })).j.event;
  const media = { media_id: 'media_' + webcrypto.randomUUID().replaceAll('-', ''), subject_id: event.subject_id,
    kind: 'audio', content_type: 'audio/wav', original_filename: 'synthetic.wav', temporary: true,
    conversation_id: conversation.conversation_id, save_status: 'saved', recognition_status: 'succeeded',
    recognition: { text: event.raw_text, is_mock: false }, event_link: { record_id: event.record_id },
    record_id: event.record_id, version: 1 };
  await h.api.vault.put('media:' + media.media_id, media);
  await h.api.vault.putBinary('media-binary:' + media.media_id, wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength), { content_type: 'audio/wav' });
  h.responses.set('/api/ai/conversation-turn', () => ({ action: 'reply', assistant_text: '我记下了。', provider: 'SyntheticMechanicalFixture' }));
  const linked = await h.request('/api/conversations/' + conversation.conversation_id + '/turns', {
    text: event.raw_text, source_kind: 'audio_transcript', audio_source_status: 'machine_transcribed',
    record_id: event.record_id, media_id: media.media_id, source_version: event.version,
    media_version: media.version, expected_version: conversation.version,
  });
  assert.equal(linked.r.ok, true, JSON.stringify(linked.j));
  let current = linked.j.conversation;
  let sourceTurn = current.turns.find(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript');
  assert.equal(sourceTurn.audio_source_reviewed, false);
  assert.equal(sourceTurn.audio_source_status, 'machine_transcribed');
  const categories = ['main_complaint','onset_course','symptom_character','aggravating_relieving','associated_symptoms','functional_impact','relevant_history','prior_actions_results'];
  const clinicalState = Object.fromEntries(categories.map(key => [key, { status: 'missing', summary: '' }]));
  const liveElders = current.turns.filter(turn => turn.role === 'elder' && !turn.superseded);
  const key = 'conversation:' + conversation.conversation_id;
  const raw = await h.api.vault.get(key);
  await h.api.vault.put(key, { ...raw, analysis_sources: { turns: liveElders.map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
    selected_context_ids: [], context_version: 0, context: [] }, completeness: { clinical_state: clinicalState,
    contradictions: [], unknowns: [], relevant_context_ids: [], evidence_turn_ids: [] } });
  h.responses.set('/api/reports/reground', body => ({ ok: true, source_only: true, algorithm_version: 'literal-report-v129', clinical_state: body?.completeness?.clinical_state || clinicalState }));
  current = (await h.request('/api/conversations/' + conversation.conversation_id)).j.conversation;
  const context = (await h.request('/api/health-context')).j.health_context, subjects = (await h.request('/api/health-subjects')).j;
  const refreshed = await h.request('/api/conversations/' + conversation.conversation_id + '/refresh-report', {
    expected_conversation_version: current.version, expected_subject_id: current.subject_id,
    expected_subject_version: subjects.version, expected_context_version: context.version,
  });
  assert.equal(refreshed.r.ok, true, JSON.stringify(refreshed.j));
  sourceTurn = refreshed.j.conversation.turns.find(turn => turn.turn_id === sourceTurn.turn_id);
  assert.equal(sourceTurn.audio_source_reviewed, false);
  assert.equal(refreshed.j.conversation.report.transcript.find(turn => turn.turn_id === sourceTurn.turn_id).source_status, 'machine_transcribed');
  const handoff = (await h.request('/api/handoffs', {})).j.handoff.conversation_reports.find(item => item.conversation_id === current.conversation_id);
  const exported = handoff.transcript.find(turn => turn.turn_id === sourceTurn.turn_id);
  assert.equal(exported.source.status, 'machine_transcribed');
  assert.equal(exported.source.verified_by_user, false);

  const edited = await h.request(`/api/conversations/${conversation.conversation_id}/turns/${sourceTurn.turn_id}`, {
    text: '虚构录音：膝盖痛三天。', expected_version: sourceTurn.version,
    expected_conversation_version: refreshed.j.conversation.version,
  });
  assert.equal(edited.r.ok, true, JSON.stringify(edited.j));
  let editedTurn = edited.j.conversation.turns.find(turn => turn.turn_id === sourceTurn.turn_id);
  assert.equal(editedTurn.audio_source_status, 'user_edited');
  assert.equal(editedTurn.audio_source_reviewed, false);
  assert.equal(editedTurn.audio_source_invalidated, false);
  assert.equal(editedTurn.original_text, event.raw_text);
  assert.ok(editedTurn.versions.some(version => version.text === event.raw_text));
  assert.equal(edited.j.conversation.completeness, null);
  const reopened = (await h.request('/api/conversations/' + conversation.conversation_id)).j.conversation;
  editedTurn = reopened.turns.find(turn => turn.turn_id === sourceTurn.turn_id);
  assert.equal(editedTurn.audio_source_status, 'user_edited');
  assert.equal(editedTurn.audio_source_reviewed, false);
  assert.equal(reopened.report.transcript.find(turn => turn.turn_id === sourceTurn.turn_id).source_status, 'user_edited');
  assert.equal((await h.api.vault.get('media-binary:' + media.media_id)).bytes.byteLength, wav.byteLength);
});

test('an explicitly reviewed audio correction can be reorganized once as analysis-only with exact current turns', async () => {
  const h = await harness(), x = await linkedCase(h, { followup: false });
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
  assert.equal(sentTexts.includes(x.laterText), false);
  assert.equal(JSON.stringify(payload).includes(x.originalText), false);
  assert.equal(h.calls.filter(call => call.path === '/api/ai/conversation-turn').length, beforeCalls + 1);
  assert.equal(result.j.conversation.manual_correction_analysis_pending, false);
  assert.equal(result.j.conversation.turns.filter(turn => turn.role === 'elder').length, 1);
  assert.equal(result.j.conversation.turns.some(turn => turn.text === '合成整理结果，不进入患者对话。'), false);
  assert.equal(result.j.conversation.manual_correction_reorganization.result_provenance, 'operation_analysis_only_v1');
});

test('a media version change while corrected audio reorganization is in flight prevents applying its analysis', async () => {
  const h = await harness(), x = await linkedCase(h, { followup: false });
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
  assert.equal(result.j.conversation.turns.filter(turn => turn.role === 'elder').length, 1);
});

test('storage failure while revising leaves event, linked conversation, audio and history unchanged', async () => {
  const h = await harness(), x = await linkedCase(h, { revise: false, followup: false });
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
  const h = await harness(), x = await linkedCase(h, { revise: false, followup: false }), other = await harness(h.driver);
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
