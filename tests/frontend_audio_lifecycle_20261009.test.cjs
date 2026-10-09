// Offline synthetic responses + real encrypted MemoryDocumentStore.
// No browser, physical microphone, real ASR/LLM, credentials or billing.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),core=require('../frontend/local-store-core.js'),safety=require('../frontend/safety.js');
async function harness(){
  const driver=new core.MemoryDocumentStore(),elements=new Map(),calls=[];let release;
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',focus(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)};
  const response=new Promise(r=>release=r);
  const context=vm.createContext({HealthLocalCore:{...core,IndexedDbDocumentStore:class{constructor(){return driver}}},HealthSafety:safety,
    indexedDB:{},crypto:webcrypto,FormData,Blob,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,navigator:{storage:{}},document:{getElementById:el,querySelector:()=>null},
    fetch:async(path,options)=>{calls.push(path);const result=path==='/api/app/session'?{authenticated:true,csrf_token:'synthetic-only'}:
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
  return{api,driver,request,c,media,get,begin,calls,release};
}
async function until(check){for(let i=0;i<120;i++){if(await check())return;await new Promise(r=>setTimeout(r,3))}assert.fail('synthetic async operation did not settle')}
const raw='合成测试：膝盖痛三天，其他变化不清楚。',success={recognition:{text:raw,is_mock:false}},count=(h,path)=>h.calls.filter(p=>p===path).length;
for(const action of ['pause','finish'])test(`ordinary late ASR after ${action} keeps sourced text and report, sends no model and cleans temporary original`,async()=>{
  const h=await harness();await h.begin();await h.request('/api/conversations/'+h.c.conversation_id+'/'+action,{});h.release(success);
  await until(async()=>{const c=await h.get();return c.turns.some(t=>t.role==='elder')&&await h.api.vault.get('media:'+h.media.media_id)===undefined});
  const c=await h.get(),turn=c.turns.find(t=>t.role==='elder');assert.equal(c.status,action==='pause'?'paused':'finished');assert.equal(turn.text,raw);assert.equal(turn.original_text,raw);assert.equal(turn.version,1);
  assert.equal(c.turns.filter(t=>t.role==='elder').length,1);assert.equal(count(h,'/api/ai/media/recognize'),1);assert.equal(count(h,'/api/ai/conversation-turn'),0);
  assert.equal((await h.request('/api/events/'+turn.record_id)).j.event.raw_text,raw);assert.ok(c.report.source_versions.some(s=>s.turn_id===turn.turn_id&&s.version===1&&s.quote===raw));assert.equal(c.report.status,'auto_unreviewed');
  assert.equal(await h.api.vault.get('media-binary:'+h.media.media_id),undefined);assert.equal(JSON.stringify(await h.driver.listDocs()).includes(raw),false);
});
test('ordinary ASR failure arriving after pause retains the original and creates no patient transcript',async()=>{
  const h=await harness();await h.begin();await h.request('/api/conversations/'+h.c.conversation_id+'/pause',{});h.release({__status:503,error:'provider_not_configured',retryable:true});
  await until(async()=> (await h.api.vault.get('media:'+h.media.media_id))?.recognition_status==='failed');
  const c=await h.get(),original=await h.api.vault.get('media-binary:'+h.media.media_id);assert.equal(c.status,'paused');assert.equal(c.turns.filter(t=>t.role==='elder').length,0);assert.equal(c.report,null);
  assert.deepEqual([...new Uint8Array(original.bytes)],[1,2,3,4]);assert.equal(count(h,'/api/ai/media/recognize'),1);assert.equal(count(h,'/api/ai/conversation-turn'),0);
});
test('a new recording begun after returning to an already paused conversation still receives one ordinary model reply',async()=>{
  const h=await harness();await h.request('/api/conversations/'+h.c.conversation_id+'/pause',{});await h.begin();h.release(success);
  await until(async()=> (await h.api.vault.get('media:'+h.media.media_id))?.conversation_turn_id);
  const c=await h.get();assert.equal(c.status,'active');assert.equal(c.turns.filter(t=>t.role==='elder').length,1);assert.equal(c.turns.at(-1).role,'assistant');assert.equal(c.turns.at(-1).ai_failed,false);
  assert.equal(count(h,'/api/ai/media/recognize'),1);assert.equal(count(h,'/api/ai/conversation-turn'),1);assert.ok(await h.api.vault.get('media-binary:'+h.media.media_id));assert.ok(c.report.source_versions.some(s=>s.quote===raw&&s.version===1));
});
