const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

const localStoreSource = fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');

function element() {
  return { disabled: false, hidden: false, textContent: '', value: '', autocomplete: '',
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, focus() {},
    addEventListener() {}, removeEventListener() {} };
}

function localHarness(Store = core.MemoryDocumentStore) {
  const elements = new Map(), shell = { inert: false };
  let gate = null;
  const getElement = id => {
    if (id === 'localVaultGate') return gate;
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const document = {
    getElementById: getElement,
    querySelector: selector => selector === '.app-shell' ? shell : null,
    createElement: tag => {
      const node = element();
      node.tagName = tag.toUpperCase();
      node.id = '';
      node.innerHTML = '';
      return node;
    },
      body: { append(node) {
        if (node.id !== 'localVaultGate') return;
        gate = node;
        for (const match of node.innerHTML.matchAll(/id="([^"]+)"[^>]*>([^<]*)/g)) {
          const [, id, text] = match;
          const child = getElement(id);
          if (text.trim()) child.textContent = text;
        }
      } },
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: Store }, HealthSafety: safety,
    indexedDB: {}, crypto: webcrypto, FormData, Blob, URL, URLSearchParams, AbortController,
    setTimeout, clearTimeout, navigator: { storage: { persist: async () => true } }, document,
    location: { reload() { context.reloads = (context.reloads || 0) + 1; } },
  });
  vm.runInContext(localStoreSource, context);
  return { api: context.HealthLocal, context, document, getElement, shell };
}

function coreWithFakeIndexedDB(indexedDB) {
  const context = vm.createContext({ module: { exports: {} }, indexedDB, crypto: webcrypto,
    TextEncoder, TextDecoder, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store-core.js'), 'utf8'), context);
  return context.module.exports;
}

test('IndexedDB blocked rejects once and closes only a late handle from its own request', async () => {
  let request;
  const fakeIndexedDB = { open() { request = { error: null, result: null }; return request; } };
  const { IndexedDbDocumentStore } = coreWithFakeIndexedDB(fakeIndexedDB);
  const driver = new IndexedDbDocumentStore();
  const opening = driver.open();
  assert.equal(typeof request.onblocked, 'function', 'an explicit blocked event handler is required');
  request.onblocked({ target: request });
  await assert.rejects(opening, error => error.message === 'indexeddb_open_blocked');
  let closeCount = 0, createCount = 0, abortCount = 0;
  request.result = { objectStoreNames: { contains() { return false; } },
    createObjectStore() { createCount += 1; }, close() { closeCount += 1; } };
  request.transaction = { abort() { abortCount += 1; } };
  request.onupgradeneeded({ target: request });
  assert.equal(abortCount, 1, 'a late version upgrade must abort its own transaction');
  assert.equal(createCount, 0, 'a rejected request must not create stores in a late upgrade');
  request.onsuccess();
  assert.equal(closeCount, 1, 'a late result from the rejected request must be closed exactly once');
  assert.equal(driver.database, null);
});

test('a storage-status read failure stays visible, rejects dependent work and offers a reload retry', async () => {
  let statusReads = 0, writes = 0, vaultReads = 0, restores = 0;
  class FailingStore extends core.MemoryDocumentStore {
    async getMeta() { statusReads += 1; throw new Error('indexeddb_open_failed'); }
    async setMeta() { writes += 1; }
    async apply() { writes += 1; }
  }
  const h = localHarness(FailingStore);
  await assert.rejects(h.api.initialise(), /local_store_status_unavailable/);
  assert.equal(h.shell.inert, true);
  assert.equal(h.getElement('vaultSubmit').disabled, true);
  assert.equal(h.getElement('vaultRestoreSubmit').disabled, true);
  assert.match(h.getElement('vaultStatus').textContent, /读取本机资料失败/);
  const retry = h.getElement('vaultRetryRead');
  assert.equal(retry.textContent, '重新读取');
  retry.onclick();
  assert.equal(h.context.reloads, 1);
  assert.equal(h.api.active, false);
  h.api.vault.get = async () => { vaultReads += 1; };
  h.api.vault.exportArchive = async () => { vaultReads += 1; };
  h.api.vault.previewArchive = async () => { vaultReads += 1; };
  h.api.vault.restoreArchive = async () => { restores += 1; };
  const requestResult = await h.api.request('/api/events');
  assert.equal(requestResult.r.status, 400);
  await assert.rejects(h.api.originalObjectUrl('synthetic-media'));
  await assert.rejects(h.api.downloadBackup());
  await assert.rejects(h.api.previewBackup({ size: 1, text: async () => '{}' }, 'fictional-passphrase'));
  await assert.rejects(h.api.restoreBackup({ archive: {} }, 'fictional-passphrase'));
  await assert.rejects(h.api.saveFeedback('fictional startup failure', 'home'));
  assert.equal(statusReads, 1, 'the cached failed initialization must not start extra status reads');
  assert.equal(vaultReads, 0, 'dependent reads and archive operations must not run after initialization failure');
  assert.equal(writes, 0, 'no encrypted-store writes may start after initialization failure');
  assert.equal(restores, 0, 'backup restore must not run after initialization failure');
});

test('the password form remains inert until the storage-status read completes', async () => {
  let finishStatus;
  class DeferredStore extends core.MemoryDocumentStore {
    constructor() { super(); this.first = true; }
    getMeta() {
      if (this.first) { this.first = false; return new Promise(resolve => { finishStatus = resolve; }); }
      return super.getMeta(...arguments);
    }
  }
  const h = localHarness(DeferredStore);
  const ready = h.api.initialise();
  await Promise.resolve();
  assert.equal(h.getElement('vaultSubmit').disabled, true);
  assert.match(h.getElement('vaultStatus').textContent, /正在读取本机资料/);
  assert.equal(h.shell.inert, true);
  assert.equal(h.getElement('vaultForm').onsubmit, undefined);
  finishStatus(undefined);
  await new Promise(setImmediate);
  assert.equal(typeof h.getElement('vaultForm').onsubmit, 'function');
  assert.equal(h.getElement('vaultSubmit').disabled, false);
  h.getElement('vaultPassphrase').value = 'fictional-deferred-startup-passphrase';
  h.getElement('vaultPassphraseConfirm').value = 'fictional-deferred-startup-passphrase';
  await h.getElement('vaultForm').onsubmit({ preventDefault() {} });
  assert.equal(await ready, true);
  assert.equal(h.api.active, true);
});

test('configured and unconfigured vaults retain their normal local unlock/setup flow', async t => {
  for (const configured of [false, true]) await t.test(configured ? 'configured' : 'unconfigured', async () => {
    const h = localHarness();
    const passphrase = 'fictional-vault-startup-passphrase';
    if (configured) await h.api.vault.setup(passphrase);
    const ready = h.api.initialise();
    await new Promise(setImmediate);
    assert.equal(h.getElement('vaultSubmit').disabled, false);
    assert.match(h.getElement('vaultSubmit').textContent, configured ? /解锁/ : /建立并进入/);
    h.getElement('vaultPassphrase').value = passphrase;
    h.getElement('vaultPassphraseConfirm').value = passphrase;
    await h.getElement('vaultForm').onsubmit({ preventDefault() {} });
    assert.equal(await ready, true);
    assert.equal(h.api.active, true);
    assert.equal(h.shell.inert, false);
    assert.equal((await h.api.vault.status()).configured, true);
  });
});

test('local health startup turns an initialization rejection into not-ready without a health request', async () => {
  let healthRequests = 0;
  const pill = element();
  const healthStart = appSource.indexOf('async function health()');
  const modeStart = appSource.indexOf('function setModeLabel()', healthStart);
  const modeEnd = appSource.indexOf('\n}', modeStart) + 2;
  const context = vm.createContext({
    localMode: true, demoMode: false, modelProvider: '', API: '', localStartupFailed: false,
    globalThis: { HealthLocal: { initialise: async () => { throw new Error('storage_failure'); } } },
    fetch: async () => { healthRequests += 1; return { ok: true, json: async () => ({ provider: 'unexpected' }) }; },
    $: id => id === 'modePill' ? pill : null,
  });
  vm.runInContext(`${appSource.slice(healthStart, modeEnd)}; this.runHealth = health;`, context);
  const result = await context.runHealth();
  assert.equal(result, false);
  assert.equal(healthRequests, 0);
  assert.match(pill.textContent, /本机资料读取失败/);
  assert.doesNotMatch(pill.textContent, /本机加密保存/);
});

test('page startup does not load subjects or records unless health initialization succeeds', async () => {
  const called = [];
  const start = appSource.indexOf('health().then(');
  const end = appSource.indexOf("if(typeof navigator!=='undefined'", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    health: async () => false, localMode: true,
    loadHealthSubjects: async () => { called.push('subjects'); return true; },
    loadEvents: async () => { called.push('events'); },
  });
  vm.runInContext(appSource.slice(start, end), context);
  await new Promise(setImmediate);
  assert.deepEqual(called, []);
});
