// Goal regressions found during the independent 2026-10-08 frontend audit.
// All payloads are synthetic; only local persistence is exercised. HTTP and
// DOM are controlled test doubles, so these do not certify browser/provider use.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

const passphrase = 'synthetic-audit-only-passphrase';
const reply = { provider: 'SyntheticProvider', action: 'ask', assistant_text: '什么时候开始的？', question_category: 'onset_course' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function localHarness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {},
      classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const responses = new Map();
  const called = new Map();
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL,
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null },
    fetch: async path => {
      if (called.has(path)) called.get(path).resolve();
      const body = responses.has(path) ? responses.get(path)
        : path === '/api/app/session' ? { authenticated: true, csrf_token: 'synthetic-csrf' } : reply;
      return { ok: true, status: 200, json: async () => await body };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal;
  await api.vault.setup(passphrase);
  const ready = api.initialise();
  await new Promise(setImmediate);
  element('vaultPassphrase').value = passphrase;
  await element('vaultForm').onsubmit({ preventDefault() {} });
  await ready;
  const request = (path, body, headers = {}) => api.request(path, body === undefined ? {}
    : { method: 'POST', body: JSON.stringify(body), headers });
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-08' })).j.conversation;
  const say = async (conversation, text) => request(`/api/conversations/${conversation.conversation_id}/turns`,
    { text, expected_version: conversation.version }, { 'Idempotency-Key': webcrypto.randomUUID() });
  return { api, request, start, say, defer(path) {
    const response = deferred(), invocation = deferred();
    responses.set(path, response.promise); called.set(path, invocation);
    return { arrived: invocation.promise, finish: body => response.resolve(body) };
  } };
}

test('restoring another backup cannot resurrect a conversation from an in-flight reply', async () => {
  const h = await localHarness();
  const conversation = await h.start();
  const remote = h.defer('/api/ai/conversation-turn');
  const sending = h.say(conversation, '纯虚构：昨天左膝酸痛');
  await remote.arrived;

  const backup = new core.EncryptedVault(new core.MemoryDocumentStore());
  await backup.setup(passphrase);
  await backup.put('event:rec_backup_synthetic', { record_id: 'rec_backup_synthetic', raw_text: '纯虚构：备份中的独立记录', source_kind: 'elder', recorded_at: new Date().toISOString(), version: 1, state: 'inbox' });
  const archive = await backup.exportArchive();
  const restoring = h.api.restoreBackup({ archive }, passphrase).then(() => ({ restored: true }), error => ({ error }));
  await Promise.race([restoring, new Promise(resolve => setTimeout(resolve, 200))]);
  remote.finish(reply);
  await sending;
  const restoreResult = await restoring;
  if (restoreResult.error) {
    assert.match(restoreResult.error.message, /busy|pending|active|in.flight/,
      'a blocked restore must clearly explain the still-running operation');
    assert.ok(await h.api.vault.get(`conversation:${conversation.conversation_id}`));
    return;
  }

  assert.equal(await h.api.vault.get(`conversation:${conversation.conversation_id}`), undefined,
    'a completed restore must not bring back pre-restore patient text or reports');
  assert.equal((await h.api.vault.get('event:rec_backup_synthetic')).raw_text, '纯虚构：备份中的独立记录');
});

test('an unlocked second tab cannot write ciphertext with a replaced vault key', async () => {
  const driver = new core.MemoryDocumentStore();
  const firstTab = new core.EncryptedVault(driver);
  await firstTab.setup(passphrase);
  const staleTab = new core.EncryptedVault(driver);
  await staleTab.unlock(passphrase);
  const backup = new core.EncryptedVault(new core.MemoryDocumentStore());
  await backup.setup('synthetic-other-backup-passphrase');
  await backup.put('event:backup', { raw_text: '纯虚构：目标备份' });
  await firstTab.restoreArchive(await backup.exportArchive(), 'synthetic-other-backup-passphrase');

  await assert.rejects(staleTab.put('event:late-tab', { raw_text: '纯虚构：旧标签内容' }),
    /vault|stale|changed|locked/, 'a stale unlocked tab must be stopped before writing with the old data key');
  assert.deepEqual(await firstTab.list('event:'), [{ raw_text: '纯虚构：目标备份' }]);
});

test('restoring an older snapshot of the same vault invalidates the other unlocked tab', async () => {
  const driver = new core.MemoryDocumentStore();
  const firstTab = new core.EncryptedVault(driver);
  await firstTab.setup(passphrase);
  await firstTab.put('event:backup', { raw_text: '纯虚构：恢复目标' });
  const archive = await firstTab.exportArchive();
  const staleTab = new core.EncryptedVault(driver);
  await staleTab.unlock(passphrase);
  await firstTab.put('event:later', { raw_text: '纯虚构：导出之后的记录' });
  await firstTab.restoreArchive(archive, passphrase);
  await assert.rejects(staleTab.put('event:late-tab', { raw_text: '纯虚构：迟到写入' }), /vault|stale|changed|locked/);
  assert.deepEqual(await firstTab.list('event:'), [{ raw_text: '纯虚构：恢复目标' }]);
  await staleTab.unlock(passphrase);
  await staleTab.put('event:after-reunlock', { raw_text: '纯虚构：重新解锁后可以正常使用' });
  assert.equal((await firstTab.get('event:after-reunlock')).raw_text, '纯虚构：重新解锁后可以正常使用');
});

test('a restore between key validation and document commit rejects the old ciphertext', async () => {
  const driver = new core.MemoryDocumentStore(), vault = new core.EncryptedVault(driver);
  await vault.setup(passphrase);
  await vault.put('event:backup', { raw_text: '纯虚构：恢复目标' });
  const archive = await vault.exportArchive();
  const entered = deferred(), release = deferred(), mutate = driver.mutateDocs.bind(driver);
  driver.mutateDocs = async (...args) => {
    if (args[0].some(doc => doc.key === 'event:late')) { entered.resolve(); await release.promise; }
    return mutate(...args);
  };
  const late = vault.put('event:late', { raw_text: '纯虚构：迟到密文' });
  const rejected = assert.rejects(late, /vault_changed_requires_unlock/);
  await entered.promise;
  await vault.restoreArchive(archive, passphrase);
  release.resolve();
  await rejected;
  assert.equal(await driver.getDoc('event:late'), undefined);
  await vault.unlock(passphrase);
  assert.deepEqual(await vault.list('event:'), [{ raw_text: '纯虚构：恢复目标' }]);
});

test('IndexedDB checks the current vault in the document transaction before staging writes', async () => {
  const source = new core.EncryptedVault(new core.MemoryDocumentStore());
  await source.setup(passphrase);
  const originalConfig = await source.driver.getMeta('vault');
  const request = { result: { ...originalConfig, restore_generation: 'synthetic-replaced-generation' } };
  const staged = [];
  let stores;
  const transaction = { objectStore(name) {
    if (name === 'meta') return { get: () => request };
    assert.equal(name, 'docs');
    return { put(value) { staged.push(value); }, delete(key) { staged.push(key); } };
  }, abort() { this.onabort(); } };
  const driver = new core.IndexedDbDocumentStore();
  driver.database = { transaction(names, mode) { stores = names; assert.equal(mode, 'readwrite'); return transaction; } };
  const writing = driver.mutateDocs([{ key: 'event:late' }], ['event:backup'], source.vaultFingerprint);
  const rejected = assert.rejects(writing, /vault_changed_requires_unlock/);
  await Promise.resolve();
  assert.deepEqual(stores, ['meta', 'docs']);
  assert.deepEqual(staged, []);
  request.onsuccess();
  await rejected;
  assert.deepEqual(staged, [], 'neither deletion nor ciphertext is staged for the old key/generation');
});

test('restore refuses background recognition until its original and result have finished saving', async () => {
  const h = await localHarness();
  const media = { media_id: 'media_audit_synthetic', kind: 'image', content_type: 'image/png',
    original_filename: 'synthetic.png', save_status: 'saved', recognition_status: 'not_started', version: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await h.api.vault.put(`media:${media.media_id}`, media);
  await h.api.vault.putBinary(`media-binary:${media.media_id}`, new Uint8Array([1, 2, 3]).buffer);
  const archive = await h.api.vault.exportArchive();
  const remote = h.defer('/api/ai/media/recognize');
  const started = await h.request(`/api/media/${media.media_id}/recognize`, {});
  assert.equal(started.r.status, 202);
  await remote.arrived;
  await assert.rejects(h.api.restoreBackup({ archive }, passphrase), /local_operations_busy/);
  assert.ok(await h.api.vault.get(`media-binary:${media.media_id}`));
  remote.finish({ recognition: { is_mock: false, text: '纯虚构：合成照片文字' } });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const saved = await h.api.vault.get(`media:${media.media_id}`);
    if (saved.recognition_status === 'succeeded') break;
    await new Promise(setImmediate);
  }
  await new Promise(setImmediate);
  assert.equal((await h.api.vault.get(`media:${media.media_id}`)).recognition_status, 'succeeded');
  await h.api.restoreBackup({ archive }, passphrase);
  assert.equal((await h.api.vault.get(`media:${media.media_id}`)).recognition_status, 'not_started');
});

test('chat correction and a concurrent event deletion cannot resurrect a deleted event', async () => {
  const h = await localHarness();
  const conversation = (await h.say(await h.start(), '纯虚构：昨天左膝酸痛')).j.conversation;
  const turn = conversation.turns.find(item => item.role === 'elder');
  const entered = deferred(), release = deferred();
  const driver = h.api.vault.driver;
  const originalMutate = driver.mutateDocs.bind(driver);
  let blocked = false;
  driver.mutateDocs = async (...args) => {
    if (!blocked && args[0].some(document => document.key === `event:${turn.record_id}`)) {
      blocked = true; entered.resolve(); await release.promise;
    }
    return originalMutate(...args);
  };
  const editing = h.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}`, {
    text: '纯虚构更正：昨天右膝酸痛', expected_version: turn.version,
    expected_conversation_version: conversation.version,
  });
  await entered.promise;
  const deletion = h.api.request(`/api/events/${turn.record_id}`, { method: 'DELETE', body: JSON.stringify({ delete_scope_confirmed: true }) });
  await Promise.race([deletion, new Promise(resolve => setTimeout(resolve, 100))]);
  release.resolve();
  await editing;
  const deleting = await deletion;
  // A linked event may alternatively be rejected with a conflict, but it must
  // never report deletion success and then silently return the event.
  if (deleting.r.ok) assert.equal(await h.api.vault.get(`event:${turn.record_id}`), undefined,
    'successful deletion cannot be undone by an unsynchronized chat correction');
  else assert.equal(deleting.r.status, 409, 'linked/concurrent deletion must clearly report a conflict');
});

test('a failed correction transaction retains both original conversation and event', async () => {
  const h = await localHarness();
  const conversation = (await h.say(await h.start(), '纯虚构：昨天左膝酸痛')).j.conversation;
  const turn = conversation.turns.find(item => item.role === 'elder');
  const mutate = h.api.vault.driver.mutateDocs.bind(h.api.vault.driver);
  h.api.vault.driver.mutateDocs = async () => { throw new Error('synthetic_quota_abort'); };
  const edited = await h.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}`, {
    text: '纯虚构更正：昨天右膝酸痛', expected_version: turn.version,
    expected_conversation_version: conversation.version,
  });
  assert.equal(edited.r.ok, false);
  h.api.vault.driver.mutateDocs = mutate;
  assert.equal((await h.api.vault.get(`event:${turn.record_id}`)).raw_text, turn.text);
  const saved = await h.api.vault.get(`conversation:${conversation.conversation_id}`);
  assert.equal(saved.version, conversation.version);
  assert.equal(saved.turns.find(item => item.turn_id === turn.turn_id).text, turn.text);
  assert.equal(saved.report.version, conversation.report.version);
});

test('a correction refuses an event already changed on the archive page', async () => {
  const h = await localHarness();
  const conversation = (await h.say(await h.start(), '纯虚构：昨天左膝酸痛')).j.conversation;
  const turn = conversation.turns.find(item => item.role === 'elder');
  const event = await h.api.vault.get(`event:${turn.record_id}`);
  const revision = await h.request(`/api/events/${turn.record_id}/revise`, {
    raw_text: '纯虚构：档案页已修正', reason: '合成纠错', expected_version: event.version,
  });
  assert.equal(revision.r.ok, true);
  const correction = await h.request(`/api/conversations/${conversation.conversation_id}/turns/${turn.turn_id}`, {
    text: '纯虚构：旧聊天页修改', expected_version: turn.version,
    expected_conversation_version: conversation.version,
  });
  assert.equal(correction.r.status, 409);
  assert.ok(['conversation_source_changed', 'stale_version'].includes(correction.j.error),
    'archive correction changes the source and turn version; stale chat input cannot overwrite it');
  assert.equal((await h.api.vault.get(`event:${turn.record_id}`)).state, 'superseded');
  assert.equal((await h.api.vault.get(`event:${revision.j.event.record_id}`)).raw_text, '纯虚构：档案页已修正');
  const synchronized = await h.api.vault.get(`conversation:${conversation.conversation_id}`);
  const updatedTurn = synchronized.turns.find(item => item.turn_id === turn.turn_id);
  assert.equal(updatedTurn.text, '纯虚构：档案页已修正');
  assert.equal(updatedTurn.record_id, revision.j.event.record_id);
  assert.equal(updatedTurn.version, turn.version + 1);
});
