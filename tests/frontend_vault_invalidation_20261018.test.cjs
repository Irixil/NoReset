const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');

const storeSource = fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
const passA = 'fictional-local-vault-passphrase-A';
const passB = 'fictional-local-vault-passphrase-B';

class ChannelBus {
  constructor() { this.channels = new Map(); this.messages = []; }
  open(name) {
    const bus = this;
    const channel = { listeners: new Set(), addEventListener(type, fn) {
      if (type === 'message') this.listeners.add(fn);
    }, postMessage(data) {
      bus.messages.push(structuredClone(data));
      for (const peer of bus.channels.get(name) || []) {
        if (peer !== channel) for (const listener of peer.listeners) listener({ data: structuredClone(data) });
      }
    } };
    if (!this.channels.has(name)) this.channels.set(name, new Set());
    this.channels.get(name).add(channel);
    return channel;
  }
}

function makeLocalTab(store, bus, { broadcast = true } = {}) {
  const elements = new Map(), shell = { inert: false };
  const values = new Map();
  const globalListeners = new Map(), documentListeners = new Map(), vaultStates = [];
  const sessionStorage = { getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); }, removeItem(key) { values.delete(key); } };
  let gate = null;
  const makeElement = id => {
    const classes = new Set();
    return { id, value: '', textContent: '', disabled: false, hidden: false, files: [],
      autocomplete: '', innerHTML: '', focus() {}, setAttribute() {},
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); } },
    };
  };
  const getElement = id => {
    if (id === 'localVaultGate') return gate;
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const document = {
    visibilityState: 'visible',
    getElementById: getElement,
    querySelector: selector => selector === '.app-shell' ? shell : null,
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    createElement: () => makeElement(''),
    body: { append(node) {
      if (node.id !== 'localVaultGate') return;
      gate = node;
      for (const match of node.innerHTML.matchAll(/id="([^"]+)"[^>]*>([^<]*)/g)) {
        const [, id, text] = match, child = getElement(id);
        if (text.trim()) child.textContent = text;
      }
    } },
  };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: class extends core.MemoryDocumentStore {
      constructor() { super(); return store; }
    } },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto,
    BroadcastChannel: broadcast ? class { constructor(name) { return bus.open(name); } } : undefined,
    FormData, Blob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    navigator: { storage: { persist: async () => true } }, document, sessionStorage, location: { reload() {} },
    addEventListener(type, fn) {
      if (!globalListeners.has(type)) globalListeners.set(type, []);
      globalListeners.get(type).push(fn);
    },
  });
  vm.runInContext(storeSource, context);
  context.HealthLocal.onVaultState(state => vaultStates.push(state));
  return { api: context.HealthLocal, getElement, shell, sessionStorage, vaultStates,
    dispatchGlobal(type, event = {}) { for (const fn of globalListeners.get(type) || []) fn(event); },
    dispatchDocument(type, event = {}) { for (const fn of documentListeners.get(type) || []) fn(event); },
    get gate() { return gate; } };
}

async function unlock(tab, passphrase) {
  const ready = tab.api.initialise();
  await new Promise(setImmediate);
  tab.getElement('vaultPassphrase').value = passphrase;
  await tab.getElement('vaultForm').onsubmit({ preventDefault() {} });
  assert.equal(await ready, true);
}

function makeAppStateHarness() {
  const calls = [], shell = { style: { visibility: '' }, inert: false }, session = new Map();
  const sessionStorage = { getItem(key) { return session.get(key) ?? null; },
    setItem(key, value) { session.set(key, String(value)); }, removeItem(key) { session.delete(key); } };
  const mode = { textContent: '' };
  let listener;
  const context = vm.createContext({
    localMode: true, vaultRecoveryPromise: null, vaultWasInvalidated: false,
    healthSubjects: [], healthSubjectsVersion: 3, activeHealthSubjectId: 'subject_old',
    healthSubjectLoaded: true, healthSubjectChanged: true, healthSubjectsLoadPromise: {}, healthSubjectUiEpoch: 0, healthSubjectsRequestId: 0,
    healthSubjectSwitchBusy: true, mediaRecorder: { state: 'recording', stop() { calls.push('recorder-stop'); }, stream: { getTracks() { return [{ stop() { calls.push('track-stop'); } }]; } } }, voicePermissionPending: true,
    voiceUploadPending: true, cancelPendingMicrophone: () => calls.push('cancel-permission'), timerId: 7,
    pendingRecordingBlob: { fictional: true }, sessionStorage, clearInterval: () => calls.push('clear-timer'),
    document: { querySelector: () => shell },
    $: id => id === 'modePill' ? mode : null,
    HealthLocal: { active: true, onVaultState(fn) { listener = fn; },
      initialise: async () => { calls.push('unlock'); return true; },
      lock() { calls.push('lock'); this.active = false; } },
    location: { reload() { calls.push('reload'); } },
  });
  const start = appSource.indexOf('function resetHealthSubjectScope(){');
  const end = appSource.indexOf('\nasync function activateHealthSubject', start);
  assert.ok(start >= 0 && end > start, 'the app must bind its current vault invalidation handler');
  const expose = '\nthis.bindVaultHandler=()=>globalThis.HealthLocal.onVaultState(handleLocalVaultState);';
  vm.runInContext(appSource.slice(start, end) + expose, context);
  context.bindVaultHandler();
  return { calls, context, shell, mode, sessionStorage, emit: listener };
}

test('cross-tab restore invalidates stale page, rejects old writes, then unlocks only the replacement vault', async () => {
  const bus = new ChannelBus(), sharedStore = new core.MemoryDocumentStore();
  const restoringTab = makeLocalTab(sharedStore, bus), staleTab = makeLocalTab(sharedStore, bus, { broadcast: false });
  await restoringTab.api.vault.setup(passA);
  await unlock(restoringTab, passA);
  await restoringTab.api.vault.put('event:old-A', { raw_text: 'fictional marker A' });
  await unlock(staleTab, passA);
  assert.equal((await staleTab.api.vault.get('event:old-A')).raw_text, 'fictional marker A');
  staleTab.dispatchGlobal('pageshow');
  await new Promise(setImmediate);
  assert.equal(staleTab.api.active, true, 'a pageshow check against the current generation keeps this page active');
  assert.ok(staleTab.vaultStates.includes('current'));

  const replacement = new core.EncryptedVault(new core.MemoryDocumentStore());
  await replacement.setup(passB);
  await replacement.put('event:new-B', { raw_text: 'fictional marker B' });
  const archive = await replacement.exportArchive();
  const beforeMessages = bus.messages.length;
  await assert.rejects(restoringTab.api.vault.previewArchive(archive, passA), /decrypt_failed/,
    'a failed preview must leave the current vault and other tab untouched');
  await new Promise(setImmediate);
  assert.equal(bus.messages.length, beforeMessages);
  assert.equal(staleTab.api.active, true);

  await restoringTab.api.restoreBackup({ archive }, passB);
  await new Promise(setImmediate);
  assert.equal(bus.messages.at(-1).type, 'vault-restored');
  assert.equal(Object.keys(bus.messages.at(-1)).sort().join(','), 'tabId,type',
    'the cross-tab notice carries no health data or key material');
  assert.equal(restoringTab.api.active, true, 'the page performing a valid restore stays unlocked');
  assert.equal(staleTab.api.active, true, 'this page intentionally missed the broadcast');
  staleTab.dispatchDocument('visibilitychange');
  await new Promise(setImmediate);
  assert.equal(staleTab.api.active, false, 'visibility restoration checks the real generation and locks the stale page');
  assert.ok(staleTab.vaultStates.includes('checking'));
  assert.ok(staleTab.vaultStates.includes('invalidated'));
  await assert.rejects(staleTab.api.vault.put('event:late-A', { raw_text: 'must not be written' }), /vault_locked/);
  assert.equal(await sharedStore.getDoc('event:late-A'), undefined);

  staleTab.sessionStorage.setItem('bingli-vault-lock-notice', 'restored');
  const staleGate = staleTab.api.initialise();
  await new Promise(setImmediate);
  assert.equal(staleTab.gate.classList.contains('hidden'), false);
  assert.match(staleTab.getElement('vaultStatus').textContent, /资料库已在其他页面恢复，请重新解锁/);
  staleTab.getElement('vaultPassphrase').value = passB;
  await staleTab.getElement('vaultForm').onsubmit({ preventDefault() {} });
  assert.equal(await staleGate, true);
  assert.equal((await staleTab.api.vault.get('event:new-B')).raw_text, 'fictional marker B');
  assert.equal(await staleTab.api.vault.get('event:old-A'), undefined);
});

test('the actual app handler hides the old realm, stops capture, records only a fixed reason, and reloads', () => {
  const app = makeAppStateHarness();
  app.emit('checking');
  assert.equal(app.shell.style.visibility, 'hidden');
  assert.equal(app.shell.inert, true);
  app.emit('current');
  assert.equal(app.shell.style.visibility, '');
  assert.equal(app.shell.inert, false, 'a page whose vault generation is unchanged stays unlocked');
  app.emit('invalidated');
  assert.equal(app.shell.style.visibility, 'hidden');
  assert.equal(app.shell.inert, true);
  assert.deepEqual(app.calls, ['cancel-permission', 'recorder-stop', 'track-stop', 'clear-timer', 'lock', 'reload']);
  assert.equal(app.sessionStorage.getItem('bingli-vault-lock-notice'), 'restored');
  assert.equal(app.context.pendingRecordingBlob, null);
  assert.equal(app.context.mediaRecorder, null);
});

test('an unavailable generation read reloads through the ordinary startup gate without a misleading restore notice', () => {
  const app = makeAppStateHarness();
  app.emit('unavailable');
  assert.deepEqual(app.calls, ['cancel-permission', 'recorder-stop', 'track-stop', 'clear-timer', 'lock', 'reload']);
  assert.equal(app.shell.style.visibility, 'hidden');
  assert.equal(app.shell.inert, true);
  assert.equal(app.sessionStorage.getItem('bingli-vault-lock-notice'), null);
});
