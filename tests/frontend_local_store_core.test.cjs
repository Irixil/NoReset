const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EncryptedVault,
  IndexedDbDocumentStore,
  MemoryDocumentStore,
} = require('../frontend/local-store-core.js');

test('vault encrypts health text at rest and requires unlock after lock', async () => {
  const driver = new MemoryDocumentStore();
  const vault = new EncryptedVault(driver);
  await vault.setup('a long local recovery passphrase');
  await vault.put('event:one', { raw_text: '胸口疼，需要记下来' });

  const stored = driver.docs.get('event:one');
  assert.equal(JSON.stringify(stored).includes('胸口疼'), false);
  assert.deepEqual(await vault.get('event:one'), { raw_text: '胸口疼，需要记下来' });

  vault.lock();
  await assert.rejects(vault.get('event:one'), /vault_locked/);
  await assert.rejects(vault.unlock('the wrong passphrase'), /decrypt_failed/);
  await vault.unlock('a long local recovery passphrase');
  assert.equal((await vault.get('event:one')).raw_text, '胸口疼，需要记下来');
});

test('IndexedDB writes stay pending until commit and reject a later abort', async () => {
  for (const abort of [false, true]) {
    const request = { result: 'event:one' };
    const transaction = { objectStore: () => ({ put: () => request }) };
    const driver = new IndexedDbDocumentStore();
    driver.database = { transaction: () => transaction };
    let settled = false;
    const write = driver.putDoc({ key: 'event:one' });
    write.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    request.onsuccess?.();
    await new Promise(setImmediate);
    assert.equal(settled, false, 'request success is not a committed transaction');
    if (abort) {
      transaction.error = new Error('quota abort');
      transaction.onabort();
      await assert.rejects(write, /quota abort/);
    } else {
      transaction.oncomplete();
      assert.equal(await write, 'event:one');
    }
  }
});

test('IndexedDB atomic delete-and-put batch is rejected as one aborted transaction', async () => {
  const documents = new Map([['event:keep', { key: 'event:keep', value: 'old' }]]);
  let stagedPuts = [];
  let stagedDeletes = [];
  let transactionCount = 0;
  const transaction = {
    error: new Error('quota abort'),
    objectStore: () => ({
      put(value) { stagedPuts.push(value); return {}; },
      delete(key) { stagedDeletes.push(key); return {}; },
    }),
    onabort: null,
  };
  const driver = new IndexedDbDocumentStore();
  driver.database = { transaction: (store, mode) => {
    transactionCount += 1;
    assert.equal(store, 'docs');
    assert.equal(mode, 'readwrite');
    setImmediate(() => transaction.onabort());
    return transaction;
  } };

  await assert.rejects(driver.mutateDocs([{ key: 'event:new', value: 'new' }], ['event:keep']), /quota abort/);
  assert.equal(transactionCount, 1);
  assert.equal(stagedPuts.length, 1);
  assert.deepEqual(stagedDeletes, ['event:keep']);
  assert.deepEqual([...documents], [['event:keep', { key: 'event:keep', value: 'old' }]], 'an aborted transaction commits neither side');
});

test('memory document batch does not partially apply when cloning a put fails', async () => {
  const driver = new MemoryDocumentStore();
  await driver.putDoc({ key: 'event:keep', value: 'old' });
  await assert.rejects(driver.mutateDocs([{ key: 'event:new', invalid: () => {} }], ['event:keep']), error => error.name === 'DataCloneError');
  assert.equal((await driver.getDoc('event:keep')).value, 'old');
  assert.equal(await driver.getDoc('event:new'), undefined);
});

test('vault batch encrypts binary originals and JSON metadata under one document mutation', async () => {
  const vault = new EncryptedVault(new MemoryDocumentStore());
  await vault.setup('a long local recovery passphrase');
  await vault.put('upload:temporary', { upload_id: 'temporary' });
  await vault.mutate({
    puts: [
      { key: 'media-binary:photo', format: 'binary', value: new Uint8Array([2, 4, 6]).buffer, metadata: { content_type: 'image/jpeg' } },
      { key: 'media:photo', value: { media_id: 'photo', save_status: 'saved' } },
    ],
    deletes: ['upload:temporary'],
  });
  const original = await vault.get('media-binary:photo');
  assert.deepEqual([...new Uint8Array(original.bytes)], [2, 4, 6]);
  assert.deepEqual(original.metadata, { content_type: 'image/jpeg' });
  assert.deepEqual(await vault.get('media:photo'), { media_id: 'photo', save_status: 'saved' });
  assert.equal(await vault.get('upload:temporary'), undefined);
});

test('restore validates conversation and original media before replacing the current vault', async () => {
  const passphrase = 'a synthetic backup passphrase';
  const original = new EncryptedVault(new MemoryDocumentStore());
  await original.setup(passphrase);
  await original.put('event:one', { raw_text: 'synthetic source' });
  await original.put('conversation:one', { turns: [{ text: 'synthetic conversation' }] });
  await original.putBinary('media-binary:one', new Uint8Array([1, 2, 3]).buffer);
  const archive = await original.exportArchive();
  const destination = new EncryptedVault(new MemoryDocumentStore());
  await destination.setup(passphrase);
  await destination.put('event:keep', { raw_text: 'must survive failed restore' });

  for (const key of ['conversation:one', 'media-binary:one']) {
    const corrupt = structuredClone(archive);
    corrupt.docs.find(doc => doc.key === key).encrypted.cipher.__health_bytes__ = 'AAAA';
    await assert.rejects(destination.restoreArchive(corrupt, passphrase), /decrypt_failed/);
    assert.equal((await destination.get('event:keep')).raw_text, 'must survive failed restore');
  }

  const duplicate = structuredClone(archive);
  duplicate.docs.push(duplicate.docs[0]);
  await assert.rejects(destination.restoreArchive(duplicate, passphrase), /invalid_backup/);
  assert.equal((await destination.get('event:keep')).raw_text, 'must survive failed restore');
  await destination.restoreArchive(archive, passphrase);
  assert.equal((await destination.get('conversation:one')).turns[0].text, 'synthetic conversation');
  assert.deepEqual([...new Uint8Array((await destination.get('media-binary:one')).bytes)], [1, 2, 3]);
});

test('encrypted backup previews before restore and rejects corruption', async () => {
  const original = new EncryptedVault(new MemoryDocumentStore());
  await original.setup('a different recovery passphrase');
  await original.put('event:one', { raw_text: '原话一' });
  await original.putBinary('media:one', new Uint8Array([1, 2, 3]).buffer, { contentType: 'image/png' });

  const archive = await original.exportArchive();
  const destination = new EncryptedVault(new MemoryDocumentStore());
  const preview = await destination.previewArchive(archive, 'a different recovery passphrase');
  assert.deepEqual(
    { eventCount: preview.eventCount, mediaCount: preview.mediaCount },
    { eventCount: 1, mediaCount: 1 },
  );
  assert.equal((await destination.status()).configured, false);

  await destination.restoreArchive(archive, 'a different recovery passphrase');
  assert.equal((await destination.get('event:one')).raw_text, '原话一');
  assert.deepEqual([...new Uint8Array((await destination.get('media:one')).bytes)], [1, 2, 3]);

  const corrupt = structuredClone(archive);
  corrupt.docs[0].encrypted.cipher.__health_bytes__ = 'AAAA';
  await assert.rejects(destination.previewArchive(corrupt, 'a different recovery passphrase'), /decrypt_failed/);
});
