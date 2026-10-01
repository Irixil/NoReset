(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HealthLocalCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const VAULT_VERSION = 1;
  const ARCHIVE_VERSION = 1;
  const PBKDF2_ITERATIONS = 310000;

  function webCrypto() {
    const value = globalThis.crypto;
    if (!value || !value.subtle || !value.getRandomValues) {
      throw new Error('secure_crypto_unavailable');
    }
    return value;
  }

  function randomBytes(length) {
    const value = new Uint8Array(length);
    webCrypto().getRandomValues(value);
    return value;
  }

  function toBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function serialise(value) {
    if (value instanceof ArrayBuffer) return { __health_bytes__: toBase64(value) };
    if (ArrayBuffer.isView(value)) {
      return { __health_bytes__: toBase64(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
    }
    if (Array.isArray(value)) return value.map(serialise);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialise(item)]));
    }
    return value;
  }

  function deserialise(value) {
    if (Array.isArray(value)) return value.map(deserialise);
    if (value && typeof value === 'object') {
      if (Object.keys(value).length === 1 && typeof value.__health_bytes__ === 'string') {
        return fromBase64(value.__health_bytes__).buffer;
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deserialise(item)]));
    }
    return value;
  }

  async function deriveWrappingKey(passphrase, salt, usages) {
    if (typeof passphrase !== 'string' || passphrase.length < 10) throw new Error('passphrase_too_short');
    const subtle = webCrypto().subtle;
    const material = await subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      usages,
    );
  }

  async function encryptBytes(key, bytes, additionalData) {
    const iv = randomBytes(12);
    const cipher = await webCrypto().subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(additionalData) },
      key,
      bytes,
    );
    return { iv: iv.buffer, cipher };
  }

  async function decryptBytes(key, envelope, additionalData) {
    try {
      return await webCrypto().subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(envelope.iv), additionalData: encoder.encode(additionalData) },
        key,
        envelope.cipher,
      );
    } catch {
      throw new Error('decrypt_failed');
    }
  }

  class MemoryDocumentStore {
    constructor() {
      this.meta = new Map();
      this.docs = new Map();
    }
    async getMeta(key) { return this.meta.get(key); }
    async setMeta(key, value) { this.meta.set(key, structuredClone(value)); }
    async getDoc(key) { return this.docs.has(key) ? structuredClone(this.docs.get(key)) : undefined; }
    async putDoc(value) { this.docs.set(value.key, structuredClone(value)); }
    async deleteDoc(key) { this.docs.delete(key); }
    async mutateDocs(puts = [], deletes = []) {
      const next = new Map(this.docs);
      for (const key of deletes) next.delete(key);
      for (const value of puts) next.set(value.key, structuredClone(value));
      this.docs = next;
    }
    async listDocs(prefix = '') {
      return [...this.docs.values()].filter(item => item.key.startsWith(prefix)).map(item => structuredClone(item));
    }
    async replace(metaEntries, docs) {
      this.meta = new Map(metaEntries.map(([key, value]) => [key, structuredClone(value)]));
      this.docs = new Map(docs.map(item => [item.key, structuredClone(item)]));
    }
    async snapshot() {
      return { vault: await this.getMeta('vault'), docs: await this.listDocs() };
    }
  }

  class IndexedDbDocumentStore {
    constructor(name = 'bingli-local-v1') {
      this.name = name;
      this.database = null;
    }
    async open() {
      if (this.database) return this.database;
      if (!globalThis.indexedDB) throw new Error('indexeddb_unavailable');
      this.database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
          if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
      });
      return this.database;
    }
    async request(storeName, mode, run) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let request;
        try { request = run(store); } catch (error) { reject(error); return; }
        // A successful request can still be rolled back before transaction commit.
        transaction.oncomplete = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
        transaction.onabort = () => reject(transaction.error || new Error('indexeddb_transaction_failed'));
      });
    }
    getMeta(key) { return this.request('meta', 'readonly', store => store.get(key)); }
    setMeta(key, value) { return this.request('meta', 'readwrite', store => store.put(value, key)); }
    getDoc(key) { return this.request('docs', 'readonly', store => store.get(key)); }
    putDoc(value) { return this.request('docs', 'readwrite', store => store.put(value)); }
    deleteDoc(key) { return this.request('docs', 'readwrite', store => store.delete(key)); }
    async mutateDocs(puts = [], deletes = []) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('docs', 'readwrite');
        const store = transaction.objectStore('docs');
        let settled = false;
        const fail = error => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        transaction.onerror = () => fail(transaction.error || new Error('indexeddb_transaction_failed'));
        transaction.onabort = () => fail(transaction.error || new Error('indexeddb_transaction_failed'));
        try {
          for (const key of deletes) store.delete(key);
          for (const value of puts) store.put(value);
        } catch (error) {
          try { transaction.abort(); } catch {}
          fail(error);
        }
      });
    }
    async listDocs(prefix = '') {
      const docs = await this.request('docs', 'readonly', store => store.getAll());
      return docs.filter(item => item.key.startsWith(prefix));
    }
    async replace(metaEntries, docs) {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['meta', 'docs'], 'readwrite');
        const meta = transaction.objectStore('meta');
        const documents = transaction.objectStore('docs');
        meta.clear(); documents.clear();
        metaEntries.forEach(([key, value]) => meta.put(value, key));
        docs.forEach(value => documents.put(value));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('indexeddb_restore_failed'));
        transaction.onabort = () => reject(transaction.error || new Error('indexeddb_restore_failed'));
      });
    }
    async snapshot() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['meta', 'docs'], 'readonly');
        const vaultRequest = transaction.objectStore('meta').get('vault');
        const docsRequest = transaction.objectStore('docs').getAll();
        transaction.oncomplete = () => resolve({ vault: vaultRequest.result, docs: docsRequest.result });
        transaction.onerror = () => reject(transaction.error || new Error('indexeddb_snapshot_failed'));
        transaction.onabort = () => reject(transaction.error || new Error('indexeddb_snapshot_failed'));
      });
    }
  }

  class EncryptedVault {
    constructor(driver) {
      this.driver = driver;
      this.dataKey = null;
    }
    async status() {
      const config = await this.driver.getMeta('vault');
      return { configured: Boolean(config), locked: !this.dataKey, version: config?.version || null };
    }
    async setup(passphrase) {
      if ((await this.status()).configured) throw new Error('vault_already_configured');
      const subtle = webCrypto().subtle;
      const rawDataKey = randomBytes(32);
      const dataKey = await subtle.importKey('raw', rawDataKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const salt = randomBytes(16);
      const wrappingKey = await deriveWrappingKey(passphrase, salt, ['encrypt', 'decrypt']);
      const wrapped = await encryptBytes(wrappingKey, rawDataKey, 'bingli:vault-key:v1');
      await this.driver.setMeta('vault', {
        version: VAULT_VERSION,
        kdf: 'PBKDF2-SHA256',
        iterations: PBKDF2_ITERATIONS,
        salt: salt.buffer,
        wrapped,
        createdAt: new Date().toISOString(),
      });
      this.dataKey = dataKey;
    }
    async unlock(passphrase) {
      const config = await this.driver.getMeta('vault');
      if (!config || config.version !== VAULT_VERSION) throw new Error('vault_not_configured');
      const wrappingKey = await deriveWrappingKey(passphrase, new Uint8Array(config.salt), ['decrypt']);
      const raw = await decryptBytes(wrappingKey, config.wrapped, 'bingli:vault-key:v1');
      this.dataKey = await webCrypto().subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }
    lock() { this.dataKey = null; }
    requireKey() {
      if (!this.dataKey) throw new Error('vault_locked');
      return this.dataKey;
    }
    async put(key, value) {
      const encrypted = await encryptBytes(this.requireKey(), encoder.encode(JSON.stringify(value)), `bingli:doc:${key}`);
      await this.driver.putDoc({ key, format: 'json', encrypted, updatedAt: new Date().toISOString() });
    }
    async putBinary(key, value, metadata = {}) {
      const bytes = value instanceof ArrayBuffer ? value : await value.arrayBuffer();
      const encrypted = await encryptBytes(this.requireKey(), bytes, `bingli:binary:${key}`);
      const meta = await encryptBytes(this.requireKey(), encoder.encode(JSON.stringify(metadata)), `bingli:binary-meta:${key}`);
      await this.driver.putDoc({ key, format: 'binary', encrypted, meta, updatedAt: new Date().toISOString() });
    }
    async decode(document) {
      if (!document) return undefined;
      if (document.format === 'json') {
        const plain = await decryptBytes(this.requireKey(), document.encrypted, `bingli:doc:${document.key}`);
        return JSON.parse(decoder.decode(plain));
      }
      if (document.format === 'binary') {
        const bytes = await decryptBytes(this.requireKey(), document.encrypted, `bingli:binary:${document.key}`);
        const meta = await decryptBytes(this.requireKey(), document.meta, `bingli:binary-meta:${document.key}`);
        return { bytes, metadata: JSON.parse(decoder.decode(meta)) };
      }
      throw new Error('unsupported_document_format');
    }
    async get(key) { return this.decode(await this.driver.getDoc(key)); }
    async list(prefix = '') {
      const docs = await this.driver.listDocs(prefix);
      return Promise.all(docs.map(document => this.decode(document)));
    }
    async remove(key) { this.requireKey(); await this.driver.deleteDoc(key); }
    async mutate({ puts = [], deletes = [] } = {}) {
      const key = this.requireKey();
      if (typeof this.driver.mutateDocs !== 'function') throw new Error('atomic_storage_unavailable');
      const documents = await Promise.all(puts.map(async item => {
        if (item.format === 'binary') {
          const value = item.value;
          const isArrayBuffer = value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
          const bytes = isArrayBuffer ? Uint8Array.from(new Uint8Array(value)).buffer : ArrayBuffer.isView(value)
            ? Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer : await value.arrayBuffer();
          const metadata = item.metadata || {};
          return {
            key: item.key,
            format: 'binary',
            encrypted: await encryptBytes(key, bytes, `bingli:binary:${item.key}`),
            meta: await encryptBytes(key, encoder.encode(JSON.stringify(metadata)), `bingli:binary-meta:${item.key}`),
            updatedAt: new Date().toISOString(),
          };
        }
        return {
          key: item.key,
          format: 'json',
          encrypted: await encryptBytes(key, encoder.encode(JSON.stringify(item.value)), `bingli:doc:${item.key}`),
          updatedAt: new Date().toISOString(),
        };
      }));
      await this.driver.mutateDocs(documents, deletes);
    }
    async exportArchive() {
      this.requireKey();
      const snapshot = this.driver.snapshot ? await this.driver.snapshot() : { vault: await this.driver.getMeta('vault'), docs: await this.driver.listDocs() };
      return {
        product: 'bingli-beta',
        archiveVersion: ARCHIVE_VERSION,
        exportedAt: new Date().toISOString(),
        vault: serialise(snapshot.vault),
        docs: serialise(snapshot.docs),
      };
    }
    async previewArchive(archive, passphrase) {
      if (!archive || archive.product !== 'bingli-beta' || archive.archiveVersion !== ARCHIVE_VERSION) {
        throw new Error('invalid_backup');
      }
      const vaultConfig = deserialise(archive.vault);
      const docs = deserialise(archive.docs);
      if (!vaultConfig || vaultConfig.version !== VAULT_VERSION || !Array.isArray(docs)) throw new Error('invalid_backup');
      if (docs.some(doc => !doc || typeof doc.key !== 'string' || !doc.key)
        || new Set(docs.map(doc => doc.key)).size !== docs.length) throw new Error('invalid_backup');
      const candidate = new EncryptedVault(new MemoryDocumentStore());
      await candidate.driver.replace([['vault', vaultConfig]], docs);
      await candidate.unlock(passphrase);
      // Validate every encrypted document before restore replaces the current vault.
      for (const document of docs) await candidate.decode(document);
      return { candidate, eventCount: docs.filter(doc => doc.key.startsWith('event:')).length,
        mediaCount: docs.filter(doc => doc.key.startsWith('media:')).length, exportedAt: archive.exportedAt };
    }
    async restoreArchive(archive, passphrase) {
      const preview = await this.previewArchive(archive, passphrase);
      const vaultConfig = deserialise(archive.vault);
      const docs = deserialise(archive.docs);
      await this.driver.replace([['vault', vaultConfig]], docs);
      this.dataKey = preview.candidate.dataKey;
      return { eventCount: preview.eventCount, mediaCount: preview.mediaCount };
    }
  }

  return {
    ARCHIVE_VERSION,
    EncryptedVault,
    IndexedDbDocumentStore,
    MemoryDocumentStore,
    deserialise,
    serialise,
  };
});
