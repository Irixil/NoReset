// Synthetic-only local encrypted API; no microphone or supplier requests.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),core=require('../frontend/local-store-core.js'),safety=require('../frontend/safety.js');
async function harness(driver=new core.MemoryDocumentStore()){
  const elements=new Map(),calls=[];const el=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,focus(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)};
  const context=vm.createContext({HealthLocalCore:{...core,IndexedDbDocumentStore:class{constructor(){return driver}}},HealthSafety:safety,indexedDB:{},crypto:webcrypto,FormData,Blob,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,navigator:{storage:{}},document:{getElementById:el,querySelector:()=>null},fetch:async(path,options)=>{calls.push({path,...options});return{ok:true,status:200,json:async()=>path==='/api/app/session'?{authenticated:false}:{provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:'虚构测试记录已保存。'}}}});
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'),'utf8'),context);const api=context.HealthLocal,pass='synthetic-audio-revision-test';
  if(!await driver.getMeta('vault'))await api.vault.setup(pass);
  const ready=api.initialise();await new Promise(setImmediate);el('vaultPassphrase').value=pass;await el('vaultForm').onsubmit({preventDefault(){}});await ready;
  const request=(path,body,method=body===undefined?'GET':'POST')=>api.request(path,{method,...(body!==undefined?{body:JSON.stringify(body)}:{}),headers:{'Idempotency-Key':webcrypto.randomUUID()}});
  const create=async()=>{
    const event=(await request('/api/events',{raw_text:'虚构：上妇这?两天不舒服',source_kind:'audio_transcript'})).j.event;
    const media={media_id:'media_'+webcrypto.randomUUID().replaceAll('-',''),subject_id:event.subject_id,kind:'audio',content_type:'audio/wav',original_filename:'synthetic.wav',save_status:'saved',recognition_status:'succeeded',recognition:{text:event.raw_text,is_mock:false},event_link:{record_id:event.record_id},record_id:event.record_id,version:2};
    await api.vault.put('media:'+media.media_id,media);await api.vault.putBinary('media-binary:'+media.media_id,new Uint8Array([1,3,3,7]).buffer,{content_type:'audio/wav'});return{event,media};
  };
  const revise=async(event,text='虚构：上腹这两天不舒服')=>request('/api/events/'+event.record_id+'/revise',{raw_text:text,source_kind:'elder',reason:'对照虚构原音纠错',expected_version:event.version});
  const confirm=event=>request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true});
  const current=async media=>safety.currentAudioSource((await request('/api/media/'+media.media_id)).j.media,(await request('/api/events')).j.events);
  const start=async()=>(await request('/api/conversations/start',{mode:'new',local_date:'2026-10-10'})).j.conversation;
  const link=async(c,event,media,extra={})=>{const latest=(await request('/api/media/'+media.media_id)).j?.media||media;return request('/api/conversations/'+c.conversation_id+'/turns',{text:event.raw_text,record_id:event.record_id,media_id:latest.media_id,source_kind:'audio_transcript',source_version:event.version,media_version:latest.version,expected_version:c.version,...extra})};
  return{api,driver,calls,request,create,revise,confirm,current,start,link};
}
test('repeated corrections resolve from original link, preserve raw ASR and require fresh source confirmation',async()=>{
  const h=await harness(),{event:root,media}=await h.create();let event=(await h.revise(root)).j.event;
  assert.equal(event.source_kind,'audio_transcript');assert.equal((await h.current(media)).record_id,event.record_id);assert.equal(safety.audioNeedsReview(event),true);
  event=(await h.confirm(event)).j.event;assert.equal(safety.audioNeedsReview(event),false);assert.equal(event.state,'inbox');assert.equal(event.confirmation_scope,null);
  const confirmedId=event.record_id;event=(await h.revise(event,'虚构：上腹三天不舒服')).j.event;
  assert.equal(event.supersedes_id,confirmedId);assert.equal((await h.current(media)).record_id,event.record_id);assert.equal(safety.audioNeedsReview(event),true);
  const raw=(await h.request('/api/media/'+media.media_id)).j.media;assert.equal(raw.recognition.text,root.raw_text);assert.equal(raw.event_link.record_id,root.record_id);
  assert.equal((await h.request('/api/events/'+root.record_id)).j.event.raw_text,root.raw_text);assert.equal((await h.request('/api/events/'+root.record_id)).j.event.state,'superseded');
  assert.ok((await h.request('/api/events/'+event.record_id+'/history')).j.history.length);assert.deepEqual(Array.from(new Uint8Array((await h.api.vault.get('media-binary:'+media.media_id)).bytes)),[1,3,3,7]);
  assert.equal(h.calls.length,0);
});
test('save failure leaves current source and confirmation intact; confirmation failure never enables reuse',async()=>{
  const h=await harness(),{event:root,media}=await h.create();let event=(await h.confirm(root)).j.event;
  const mutate=h.driver.mutateDocs.bind(h.driver);h.driver.mutateDocs=async()=>{throw Error('synthetic_save_failed')};
  assert.equal((await h.revise(event)).r.ok,false);assert.equal((await h.current(media)).record_id,event.record_id);assert.equal(safety.audioNeedsReview(await h.current(media)),false);
  h.driver.mutateDocs=mutate;event=(await h.revise(event)).j.event;h.driver.mutateDocs=async()=>{throw Error('synthetic_save_failed')};
  assert.equal((await h.confirm(event)).r.ok,false);assert.equal(safety.audioNeedsReview(await h.current(media)),true);assert.equal(h.calls.length,0);
});
test('fresh realm unlock resolves original entry to latest confirmed revision and new conversation uses only that source',async()=>{
  const h=await harness(),{event:root,media}=await h.create();let event=(await h.revise(root)).j.event;event=(await h.confirm(event)).j.event;h.api.lock();
  const fresh=await harness(h.driver);assert.equal((await fresh.current(media)).record_id,event.record_id);assert.equal(safety.audioNeedsReview(await fresh.current(media)),false);
  const c=await fresh.start(),x=await fresh.link(c,event,media);assert.equal(x.r.ok,true);
  const turn=x.j.conversation.turns.find(t=>t.role==='elder');assert.equal(turn.text,event.raw_text);assert.equal(turn.record_id,event.record_id);assert.equal(turn.media_id,media.media_id);
  assert.match(x.j.conversation.report.body,/上腹/);assert.doesNotMatch(x.j.conversation.report.body,/上妇/);assert.equal(fresh.calls.some(c=>c.path.startsWith('/api/ai/')),false);
});
test('unconfirmed, old and concurrently superseded versions cannot be reused even through direct local API',async()=>{
  const h=await harness(),{event:root,media}=await h.create(),c=await h.start();
  assert.equal((await h.link(c,root,media)).j.error,'audio_source_review_required');
  let event=(await h.confirm(root)).j.event;assert.equal((await h.link(c,event,media,{source_version:event.version-1})).j.error,'audio_source_changed');
  const old=event;event=(await h.revise(event)).j.event;assert.equal((await h.link(c,old,media)).j.error,'conversation_source_invalid');
  assert.equal((await h.confirm(old)).r.ok,false);assert.equal((await h.link(c,event,media)).j.error,'audio_source_review_required');
  assert.equal((await h.request('/api/conversations/'+c.conversation_id)).j.conversation.turns.some(t=>t.role==='elder'),false);assert.equal(h.calls.length,0);
});
test('deleting from current revision removes its whole source lineage and audio; save rejection leaves them usable',async()=>{
  const h=await harness(),{event:root,media}=await h.create(),event=(await h.revise(root)).j.event;
  const mutate=h.driver.mutateDocs.bind(h.driver);h.driver.mutateDocs=async()=>{throw Error('synthetic_delete_failed')};
  assert.equal((await h.request('/api/events/'+event.record_id,{delete_scope_confirmed:true},'DELETE')).r.ok,false);assert.equal((await h.current(media)).record_id,event.record_id);
  h.driver.mutateDocs=mutate;assert.equal((await h.request('/api/events/'+event.record_id,{delete_scope_confirmed:true},'DELETE')).r.ok,true);
  assert.equal((await h.request('/api/media/'+media.media_id)).r.status,404);assert.equal((await h.request('/api/events/'+root.record_id)).r.status,404);assert.equal(await h.api.vault.get('media-binary:'+media.media_id),undefined);
});
test('family and separate vaults cannot resolve, confirm, revise or reuse another person audio source',async()=>{
  const h=await harness(),{event:root,media}=await h.create();let event=(await h.revise(root)).j.event;event=(await h.confirm(event)).j.event;
  let reg=(await h.request('/api/health-subjects')).j;const family=await h.request('/api/health-subjects',{label:'虚构家属',relationship:'family',expected_version:reg.version});
  reg=(await h.request('/api/health-subjects')).j;const member=family.j.subject||family.j.subjects?.at(-1);assert.ok(member);
  await h.request('/api/health-subjects/active',{subject_id:member.subject_id,expected_version:reg.version});
  assert.equal((await h.request('/api/media/'+media.media_id)).r.status,403);assert.equal((await h.confirm(event)).r.status,403);assert.equal((await h.revise(event)).r.status,403);
  const c=await h.start();assert.equal((await h.link(c,event,media)).r.ok,false);assert.equal(h.calls.some(c=>c.path.startsWith('/api/ai/')),false);
  const independent=await harness();assert.equal((await independent.request('/api/media/'+media.media_id)).r.status,404);assert.equal((await independent.confirm(event)).r.status,404);
});
test('ambiguous, cyclic, wrong-owner and relabeled chains resolve to no usable source',()=>{
  const root={record_id:'a',source_kind:'audio_transcript',subject_id:'s',state:'superseded'},media={kind:'audio',subject_id:'s',event_link:{record_id:'a'}};
  const leaf={record_id:'b',supersedes_id:'a',source_kind:'audio_transcript',subject_id:'s',state:'inbox'};
  for(const events of [[root], [root,leaf,{...leaf,record_id:'c'}], [root,{...leaf,state:'superseded'},{...root,supersedes_id:'b'}], [root,{...leaf,subject_id:'other'}], [root,{...leaf,source_kind:'elder'}]])assert.equal(safety.currentAudioSource(media,events),null);
});

test('a second realm correction wins over a late confirmation or new conversation source commit',async()=>{
  for(const phase of ['confirm','link']){
    const h=await harness(),{event:root,media}=await h.create();let event=phase==='link'?(await h.confirm(root)).j.event:root;
    const other=await harness(h.driver),c=phase==='link'?await h.start():null,mutate=h.driver.mutateDocs.bind(h.driver);let revised,armed=true;
    h.driver.mutateDocs=async(...args)=>{
      const puts=args[0]||[];
      if(armed&&puts.some(doc=>phase==='confirm'?doc.key==='event:'+event.record_id:doc.key==='conversation:'+c.conversation_id)){armed=false;revised=(await other.revise(event,'虚构：再次更正为上腹三天')).j.event;}
      return mutate(...args);
    };
    const x=phase==='confirm'?await h.confirm(event):await h.link(c,event,media);assert.equal(x.r.ok,false);assert.ok(revised);assert.equal((await h.current(media)).record_id,revised.record_id);assert.equal(safety.audioNeedsReview(await h.current(media)),true);
    if(c)assert.equal((await h.request('/api/conversations/'+c.conversation_id)).j.conversation.turns.some(t=>t.role==='elder'),false);
    assert.equal(h.calls.some(c=>c.path.startsWith('/api/ai/')),false);
  }
});
test('confirmation needs an existing original and an explicit declaration; it never clears medical danger',async()=>{
  const h=await harness(),{event:root,media}=await h.create();let event=(await h.revise(root,'虚构：胸痛伴呼吸困难')).j.event;
  assert.equal((await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version})).j.error,'source_review_confirmation_required');
  event=(await h.confirm(event)).j.event;assert.equal(event.local_safety.danger_detected,true);assert.equal(event.state,'inbox');assert.equal(event.confirmation_scope,null);
  await h.api.vault.remove('media-binary:'+media.media_id);event=(await h.revise(event)).j.event;assert.equal((await h.confirm(event)).j.error,'audio_original_unavailable');assert.equal(safety.audioNeedsReview(await h.current(media)),true);
});

test('actual media and composer functions persist only the confirmed current version through the real local API',async()=>{
  const h=await harness(),{event:root,media}=await h.create();let event=(await h.revise(root)).j.event;event=(await h.confirm(event)).j.event;
  const mediaSource=fs.readFileSync(require.resolve('../frontend/media.js'),'utf8'),appSource=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');
  const ctx=vm.createContext({HealthSafety:safety,crypto:webcrypto,Error,activeConversation:null,saveBusy:false,pendingConversationTurn:null,pendingFollowupTarget:null,handoffSelection:new Set(),
    api:(path,options)=>h.api.request(path,options),mediaRequest:async path=>{const x=await h.api.request(path);if(!x.r.ok)throw Error(x.j.error);return x.j},isMockMedia:()=>false,isMockContent:()=>false,mockText:()=>false,
    startSeparateConversation:async()=>{ctx.activeConversation=await h.start();return true},showView(){},setVoiceStatus(){},setVoiceComposerEnabled(){},renderVoiceConversation(){},syncConversation:c=>{ctx.activeConversation=c},loadEvents:async()=>{},loadConversation:async()=>{},trialVoiceMessage:()=>''});
  vm.runInContext(mediaSource.slice(mediaSource.indexOf('async function currentSavedAudioSource('),mediaSource.indexOf('function showRecognition(')),ctx);
  vm.runInContext(appSource.slice(appSource.indexOf('async function submitConversationText('),appSource.indexOf('async function saveVoiceSupplement(')),ctx);
  const currentMedia=(await h.request('/api/media/'+media.media_id)).j.media;
  assert.equal(await ctx.startConversationFromSavedAudio(currentMedia),true);const saved=(await h.request('/api/conversations/'+ctx.activeConversation.conversation_id)).j.conversation;
  const turn=saved.turns.find(t=>t.role==='elder');assert.equal(turn.text,event.raw_text);assert.equal(turn.record_id,event.record_id);assert.equal(turn.media_id,media.media_id);assert.equal(h.calls.some(c=>c.path.startsWith('/api/ai/')),false);
});
test('actual confirmation UI requires checkbox and leaves failed saves unconfirmed without duplicate clicks',async()=>{
  const app=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,{checked:false,disabled:false,textContent:'',innerHTML:'',querySelector:()=>null,classList:{remove(){}}});return elements.get(id)};
  let resolve,calls=0;const e={record_id:'rec_ui',source_kind:'audio_transcript',state:'inbox',version:1,raw_text:'虚构当前录音文字'};
  const ctx=vm.createContext({HealthSafety:safety,current:null,activeConversation:null,detailRequestSerial:1,handoffSelection:new Set(),localMode:true,recordRelationshipsSubjectId:null,activeHealthSubjectId:'subject_self',$:el,isMockContent:()=>false,documentNeedsReview:()=>false,audioNeedsReview:safety.audioNeedsReview,safetyBanner(){},detailHtml:()=>'',showAudioOriginals(){},showDocumentOriginals(){},organize(){},review(){},revise(){},historyView(){},toast(){},loadEvents:async()=>{},showDetail:async()=>{},api:async()=>{calls++;return new Promise(r=>resolve=r)}});
  vm.runInContext(app.slice(app.indexOf('function renderDetail('),app.indexOf('async function loadRelatedHistory(')),ctx);ctx.renderDetail(e);
  await el('audioSourceReviewBtn').onclick();assert.equal(calls,0);
  el('audioSourceReviewCheck').checked=true;el('audioSourceReviewCheck').onchange();const pending=el('audioSourceReviewBtn').onclick();assert.equal(el('audioSourceReviewCheck').disabled,true);
  await el('audioSourceReviewBtn').onclick();assert.equal(calls,1);resolve({r:{ok:false,status:409},j:{error:'stale_version'}});await pending;
  assert.match(el('audioSourceReviewStatus').textContent,/未保存/);assert.equal(el('audioSourceReviewCheck').disabled,false);assert.equal(safety.audioNeedsReview(e),true);
});
