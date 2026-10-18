// Real AES-GCM, independent JS realms, synthetic shared MemoryDocumentStore.
// This is an atomic vault test, not a browser/IndexedDB or model-quality claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const source = fs.readFileSync(require.resolve('../frontend/local-store-core.js'), 'utf8');
const passphrase = 'only synthetic CAS shared vault';
const docKey = 'conversation:synthetic-cas';
const v1 = {conversation_id:'synthetic-cas',turns:[{turn_id:'elder-one',version:1,text:'原创虚构旧原话'}],report:{version:1,text:'旧报告'}};
const v2 = {conversation_id:'synthetic-cas',turns:[{turn_id:'elder-one',version:2,text:'原创虚构已纠正原话'}],report:{version:2,text:'纠正后的报告'}};
const lateReply = {...v1,report:{version:2,text:'旧来源迟到推断'}};
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve=done;});
  return {promise,resolve};
}
function realm() {
  let barrier = null;
  const subtle = new Proxy(webcrypto.subtle, {get(target,name) {
    if(name==='encrypt') return async (...args) => {
      const actual = target.encrypt(...args);
      const waiting = barrier;
      if(waiting && new TextDecoder().decode(args[0].additionalData)===`bingli:doc:${docKey}`) {
        barrier=null;
        waiting.entered.resolve();
        await waiting.release.promise;
      }
      return actual;
    };
    const value=Reflect.get(target,name,target);
    return typeof value==='function'?value.bind(target):value;
  }});
  const context=vm.createContext({crypto:{subtle,getRandomValues:bytes=>webcrypto.getRandomValues(bytes)},TextEncoder,TextDecoder,structuredClone,Uint8Array,ArrayBuffer,btoa,atob});
  vm.runInContext(source,context);
  return {core:context.HealthLocalCore,holdNextDocEncryption() {
    assert.equal(barrier,null);
    barrier={entered:deferred(),release:deferred()};
    return barrier;
  }};
}
async function pair() {
  const leftRealm=realm(),rightRealm=realm(),driver=new core.MemoryDocumentStore();
  const left=new leftRealm.core.EncryptedVault(driver),right=new rightRealm.core.EncryptedVault(driver);
  await left.setup(passphrase);await right.unlock(passphrase);
  assert.equal(typeof left.putIfUnchanged,'function','CAS is required; no fallback to put');
  await left.put(docKey,v1);
  return {left,right,leftRealm,rightRealm,driver};
}

test('matching plaintext clone commits true across independent vault realms', {timeout:5000}, async () => {
  const h=await pair(),expected=await h.left.get(docKey),before=await h.driver.getDoc(docKey);
  assert.equal(await h.right.putIfUnchanged(docKey,plain(expected),v2),true);
  assert.deepEqual(plain(await h.left.get(docKey)),v2);
  assert.notDeepEqual(await h.driver.getDoc(docKey),before);
  assert.ok(!Buffer.from((await h.driver.getDoc(docKey)).encrypted.cipher).includes(Buffer.from(v2.turns[0].text)));
});

test('changed plaintext fails false and preserves the entire current encrypted document', {timeout:5000}, async () => {
  const h=await pair();await h.right.put(docKey,v2);
  const saved=await h.driver.getDoc(docKey);
  assert.equal(await h.left.putIfUnchanged(docKey,v1,lateReply),false);
  assert.deepEqual(await h.driver.getDoc(docKey),saved);
  assert.deepEqual(plain(await h.right.get(docKey)),v2);
});

test('a deleted source fails false without resurrecting the conversation', {timeout:5000}, async () => {
  const h=await pair();await h.right.remove(docKey);
  assert.equal(await h.left.putIfUnchanged(docKey,v1,lateReply),false);
  assert.equal(await h.driver.getDoc(docKey),undefined);
  assert.equal(await h.right.get(docKey),undefined);
});

for(const change of ['revise','delete','same-plaintext-reencrypt']) {
  test(`realm B ${change} during realm A AES await prevents stale envelope commit`, {timeout:5000}, async () => {
    const h=await pair(),hold=h.leftRealm.holdNextDocEncryption();
    const late=h.left.putIfUnchanged(docKey,v1,lateReply);
    try {
      await hold.entered.promise;
      if(change==='delete')await h.right.remove(docKey);
      else await h.right.put(docKey,change==='revise'?v2:v1);
      const current=await h.driver.getDoc(docKey);
      hold.release.resolve();
      assert.equal(await late,false,'atomic commit must compare the original encrypted envelope, including same-plaintext ABA');
      assert.deepEqual(await h.driver.getDoc(docKey),current);
      assert.deepEqual(plain(await h.right.get(docKey)),change==='delete'?undefined:change==='revise'?v2:v1);
    } finally {hold.release.resolve();}
  });
}

test('two competing CAS replies from the same source allow only one commit', {timeout:5000}, async () => {
  const h=await pair(),hold=h.leftRealm.holdNextDocEncryption(),winner={...v1,report:{version:2,text:'另一realm已保存推断'}};
  const left=h.left.putIfUnchanged(docKey,v1,lateReply);
  try {
    await hold.entered.promise;
    const right=await h.right.putIfUnchanged(docKey,v1,winner);
    hold.release.resolve();
    assert.deepEqual([await left,right],[false,true]);
    assert.deepEqual(plain(await h.left.get(docKey)),winner);
  } finally {hold.release.resolve();}
});

test('a second document guard changed during AES rejects the reply and preserves both current records', {timeout:5000}, async () => {
  const h=await pair(),contextKey='health-context:synthetic-cas';
  const oldContext=[{context_id:'synthetic-background',version:1,raw_text:'原创虚构旧背景'}];
  const newContext=[{context_id:'synthetic-background',version:2,raw_text:'原创虚构纠正后背景'}];
  await h.right.put(contextKey,oldContext);
  const conversationBefore=await h.driver.getDoc(docKey),hold=h.leftRealm.holdNextDocEncryption();
  const late=h.left.putIfUnchanged(docKey,v1,lateReply,[{key:contextKey,value:oldContext}]);
  try {
    await hold.entered.promise;
    await h.right.put(contextKey,newContext);
    const contextNow=await h.driver.getDoc(contextKey);
    hold.release.resolve();
    assert.equal(await late,false);
    assert.deepEqual(await h.driver.getDoc(docKey),conversationBefore);
    assert.deepEqual(await h.driver.getDoc(contextKey),contextNow);
    assert.deepEqual(plain(await h.right.get(docKey)),v1);
    assert.deepEqual(plain(await h.left.get(contextKey)),newContext);
  } finally {hold.release.resolve();}
});

test('restore of the same archive invalidates an AES-in-flight CAS and locks the old realm', {timeout:5000}, async () => {
  const h=await pair(),archive=await h.right.exportArchive(),hold=h.leftRealm.holdNextDocEncryption();
  const late=h.left.putIfUnchanged(docKey,v1,lateReply);
  const rejected=assert.rejects(late,/vault_changed_requires_unlock/);
  try {
    await hold.entered.promise;
    await h.right.restoreArchive(archive,passphrase);
    const restored=await h.driver.getDoc(docKey);
    hold.release.resolve();await rejected;
    assert.deepEqual(await h.driver.getDoc(docKey),restored);
    assert.deepEqual(plain(await h.right.get(docKey)),v1);
    assert.equal((await h.left.status()).locked,true);
    await assert.rejects(h.left.get(docKey),/vault_locked/);
    await h.left.unlock(passphrase);
    assert.deepEqual(plain(await h.left.get(docKey)),v1);
  } finally {hold.release.resolve();}
});
