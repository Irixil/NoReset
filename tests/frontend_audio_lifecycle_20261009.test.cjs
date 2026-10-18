// Offline synthetic responses + real encrypted MemoryDocumentStore.
// No browser, physical microphone, real ASR/LLM, credentials or billing.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),core=require('../frontend/local-store-core.js'),safety=require('../frontend/safety.js');
async function harness(){
  const driver=new core.MemoryDocumentStore(),elements=new Map(),calls=[];let release,asrTrial=null,configReads=0;
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',focus(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)};
  const response=new Promise(r=>release=r);
  const context=vm.createContext({HealthLocalCore:{...core,IndexedDbDocumentStore:class{constructor(){return driver}}},HealthSafety:safety,
    indexedDB:{},crypto:webcrypto,FormData,Blob,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,navigator:{storage:{}},document:{getElementById:el,querySelector:()=>null},
    fetch:async(path,options)=>{calls.push(path);const result=path==='/api/app/session'?{authenticated:true,csrf_token:'synthetic-only'}:
      path==='/api/app/config'?{asr_trial:await Promise.resolve(typeof asrTrial==='function'?asrTrial(++configReads):asrTrial)}:
      path==='/api/ai/media/recognize'?await response:{provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:'我已保存您说的原话。'};
      return{ok:!(result.__status>=400),status:result.__status||200,json:async()=>result};}});
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'),'utf8'),context);
  const api=context.HealthLocal;await api.vault.setup('synthetic-audio-lifecycle');const ready=api.initialise();await new Promise(setImmediate);el('vaultPassphrase').value='synthetic-audio-lifecycle';await el('vaultForm').onsubmit({preventDefault(){}});await ready;
  const request=(path,body)=>api.request(path,body===undefined?{}:{method:'POST',headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify(body)});
  const c=(await request('/api/conversations/start',{mode:'new',local_date:'2026-10-09'})).j.conversation;
  const media={media_id:'media_'+webcrypto.randomUUID().replaceAll('-',''),kind:'audio',content_type:'audio/wav',original_filename:'synthetic-only.wav',temporary:true,conversation_id:c.conversation_id,save_status:'saved',recognition_status:'not_started',link_status:'not_linked',version:1};
  await api.vault.put('media:'+media.media_id,media);await api.vault.putBinary('media-binary:'+media.media_id,new Uint8Array([1,2,3,4]).buffer,{content_type:'audio/wav'});
  const get=async()=>(await request('/api/conversations/'+c.conversation_id)).j.conversation;
  const begin=async()=>{await request('/api/media/'+media.media_id+'/recognize',{});await until(()=>calls.includes('/api/ai/media/recognize'))};
  return{api,driver,request,c,media,get,begin,calls,release,setAsrTrial(value){asrTrial=value;configReads=0},callsFor(path){return calls.filter(item=>item===path).length}};
}
async function until(check){for(let i=0;i<120;i++){if(await check())return;await new Promise(r=>setTimeout(r,3))}assert.fail('synthetic async operation did not settle')}
const raw='合成测试：膝盖痛三天，其他变化不清楚。',success={recognition:{text:raw,is_mock:false}},count=(h,path)=>h.calls.filter(p=>p===path).length;
for(const action of ['pause','finish'])test(`ordinary late ASR after ${action} keeps an unreviewed draft and original without a turn/model`,async()=>{
  const h=await harness();await h.begin();await h.request('/api/conversations/'+h.c.conversation_id+'/'+action,{});h.release(success);
  await until(async()=> (await h.api.vault.get('media:'+h.media.media_id))?.recognition_status==='succeeded');
  const c=await h.get(),media=(await h.request('/api/media/'+h.media.media_id)).j.media,event=(await h.request('/api/events/'+media.event_link.record_id)).j.event;
  assert.equal(c.status,action==='pause'?'paused':'finished');assert.equal(c.turns.filter(t=>t.role==='elder').length,0);assert.equal(c.report,null);
  assert.equal(event.raw_text,raw);assert.equal(h.calls.filter(path=>path==='/api/ai/conversation-turn').length,0);assert.equal(count(h,'/api/ai/media/recognize'),1);
  assert.equal(media.link_pending_reason,'audio_source_review_required');assert.deepEqual([...new Uint8Array((await h.api.vault.get('media-binary:'+h.media.media_id)).bytes)],[1,2,3,4]);
});
test('ordinary ASR failure arriving after pause retains the original and creates no patient transcript',async()=>{
  const h=await harness();await h.begin();await h.request('/api/conversations/'+h.c.conversation_id+'/pause',{});h.release({__status:503,error:'provider_not_configured',retryable:true});
  await until(async()=> (await h.api.vault.get('media:'+h.media.media_id))?.recognition_status==='failed');
  const c=await h.get(),original=await h.api.vault.get('media-binary:'+h.media.media_id);assert.equal(c.status,'paused');assert.equal(c.turns.filter(t=>t.role==='elder').length,0);assert.equal(c.report,null);
  assert.deepEqual([...new Uint8Array(original.bytes)],[1,2,3,4]);assert.equal(count(h,'/api/ai/media/recognize'),1);assert.equal(count(h,'/api/ai/conversation-turn'),0);
});
test('a new recording begun after returning to an already paused conversation still waits for review',async()=>{
  const h=await harness();await h.request('/api/conversations/'+h.c.conversation_id+'/pause',{});await h.begin();h.release(success);
  await until(async()=> (await h.api.vault.get('media:'+h.media.media_id))?.recognition_status==='succeeded');
  const c=await h.get(),media=(await h.request('/api/media/'+h.media.media_id)).j.media;assert.equal(c.status,'paused');assert.equal(c.turns.filter(t=>t.role==='elder').length,0);assert.equal(c.report,null);
  assert.equal(count(h,'/api/ai/media/recognize'),1);assert.equal(count(h,'/api/ai/conversation-turn'),0);assert.ok(await h.api.vault.get('media-binary:'+h.media.media_id));assert.equal(media.link_pending_reason,'audio_source_review_required');
});

const digest=async bytes=>Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
function oneAsrGrant(hash){return{kind:'asr',receipt_id:'synthetic-receipt-n05',receipt_sha256:'a'.repeat(64),expires_at:new Date(Date.now()+600000).toISOString(),source_sha256:[hash],remaining_requests:1}}
const oldN03={review_required:true,state:'review_required',media_id:'media_old_n03',conversation_id:'conversation_old_n03'};
test('a fresh exact N05 ASR grant permits only its distinct original without replacing the old N03 control',async()=>{
  const h=await harness(),bytes=new Uint8Array([1,2,3,4]),hash=await digest(bytes);h.media.sha256=hash;
  await h.api.vault.put('media:'+h.media.media_id,h.media);await h.api.vault.put('trial-control:voice',oldN03);h.setAsrTrial(oneAsrGrant(hash));
  const started=await h.request('/api/media/'+h.media.media_id+'/recognize',{});assert.equal(started.r.status,202);
  await until(()=>h.callsFor('/api/ai/media/recognize')===1);
  h.release({trial_control:{review_required:true},recognition:{text:raw,is_mock:false}});
  await until(async()=>(await h.api.vault.get('media:'+h.media.media_id))?.recognition_status==='succeeded');
  const media=(await h.request('/api/media/'+h.media.media_id)).j.media;
  assert.equal(media.trial_control.asr_trial_receipt_id,'synthetic-receipt-n05');assert.equal(media.trial_control.state,'review_required');
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),oldN03);assert.equal(h.callsFor('/api/ai/media/recognize'),1);
  assert.deepEqual([...new Uint8Array((await h.api.vault.get('media-binary:'+h.media.media_id)).bytes)],[1,2,3,4]);
});
test('the old source, missing or mismatched new grants, and a grant changed before dispatch never call ASR',async()=>{
  for(const mode of ['same_old_source','duplicate_old_source','missing','mismatch','expired','used','wrong_kind','bad_receipt','changed_before_dispatch']){
    const h=await harness(),hash=await digest(new Uint8Array([1,2,3,4]));h.media.sha256=hash;await h.api.vault.put('media:'+h.media.media_id,h.media);
    const oldSource=mode==='same_old_source'?{...oldN03,media_id:h.media.media_id}:mode==='duplicate_old_source'?{...oldN03,media_id:'media_old_n03'}:oldN03;
    if(mode==='duplicate_old_source'){
      await h.api.vault.put('media:media_old_n03',{media_id:'media_old_n03',kind:'audio',subject_id:'subject_self'});
      await h.api.vault.putBinary('media-binary:media_old_n03',new Uint8Array([1,2,3,4]).buffer,{});
    }
    await h.api.vault.put('trial-control:voice',oldSource);
    const grant=oneAsrGrant(hash);
    h.setAsrTrial(mode==='missing'?null:mode==='mismatch'?oneAsrGrant('b'.repeat(64)):
      mode==='expired'?{...grant,expires_at:'2000-01-01T00:00:00Z'}:mode==='used'?{...grant,remaining_requests:0}:
      mode==='wrong_kind'?{...grant,kind:'llm'}:mode==='bad_receipt'?{...grant,receipt_sha256:'bad'}:
      mode==='changed_before_dispatch'?reads=>reads===1?grant:null:grant);
    const result=await h.request('/api/media/'+h.media.media_id+'/recognize',{});
    if(mode==='changed_before_dispatch')await until(async()=>(await h.api.vault.get('media:'+h.media.media_id))?.recognition_status==='failed');
    assert.equal(h.callsFor('/api/ai/media/recognize'),0,mode);assert.ok(await h.api.vault.get('media-binary:'+h.media.media_id));
    assert.deepEqual(await h.api.vault.get('trial-control:voice'),oldSource);
    if(mode!=='changed_before_dispatch')assert.equal(result.r.status,409);
  }
});
test('a delayed grant recheck notices a changed owner version and an old continuing control still blocks other audio',async()=>{
  const h=await harness(),hash=await digest(new Uint8Array([1,2,3,4]));h.media.sha256=hash;await h.api.vault.put('media:'+h.media.media_id,h.media);
  await h.api.vault.put('trial-control:voice',oldN03);
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve}),delayed=new Promise(resolve=>{release=resolve});
  h.setAsrTrial(read=>read===2?(entered(),delayed):oneAsrGrant(hash));
  await h.request('/api/media/'+h.media.media_id+'/recognize',{});await waiting;
  const registry=(await h.request('/api/health-subjects')).j;
  await h.request('/api/health-subjects',{label:'虚构异步版本变更',relationship:'family',expected_version:registry.version});
  release(oneAsrGrant(hash));
  await until(async()=>(await h.api.vault.get('media:'+h.media.media_id))?.recognition_status==='failed');
  assert.equal(h.callsFor('/api/ai/media/recognize'),0);assert.deepEqual(await h.api.vault.get('trial-control:voice'),oldN03);
  assert.ok(await h.api.vault.get('media-binary:'+h.media.media_id));

  const continuing=await harness(),continuingHash=await digest(new Uint8Array([1,2,3,4]));
  continuing.media.sha256=continuingHash;await continuing.api.vault.put('media:'+continuing.media.media_id,continuing.media);
  await continuing.api.vault.put('trial-control:voice',{...oldN03,state:'continuing'});continuing.setAsrTrial(oneAsrGrant(continuingHash));
  const refused=await continuing.request('/api/media/'+continuing.media.media_id+'/recognize',{});
  assert.equal(refused.r.status,409);assert.equal(refused.j.error,'trial_review_required');assert.equal(continuing.callsFor('/api/ai/media/recognize'),0);
});
test('ASR stop and review errors have explicit Chinese recovery guidance',()=>{
  const media=fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');
  assert.match(media,/trial_stopped:'这次语音处理已停止；录音原件仍在本机，不会自动重发。'/);
  assert.match(media,/trial_review_required:'这段录音仍在待核对状态；原件已保留，请先处理核对停点。'/);
  assert.match(media,/trial_authorization_required:'没有匹配到这段录音的当前单次识别授权；原件已保留，不会自动重试。'/);
});
