// New single grant, encrypted local API and actual media entry; no real network.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto'),core=require('../frontend/local-store-core.js'),safety=require('../frontend/safety.js');
const path=require('node:path');
const TEXT='上腹这两天不舒服，吃完饭后明显。',sha=s=>createHash('sha256').update(s).digest('hex');
async function realm(driver=new core.MemoryDocumentStore(),control={}){
  const calls=[],elMap=new Map(),el=id=>{if(!elMap.has(id))elMap.set(id,{value:'',disabled:false,focus(){},classList:{add(){},remove(){},toggle(){}}});return elMap.get(id)};
  const ctx=vm.createContext({HealthLocalCore:{...core,IndexedDbDocumentStore:class{constructor(){return driver}}},HealthSafety:safety,indexedDB:{},crypto:webcrypto,TextEncoder,FormData,Blob,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,navigator:{storage:{}},document:{getElementById:el,querySelector:()=>null},fetch:async(path,options={})=>{
    calls.push({path,...options});if(control.onFetch)await control.onFetch(path,options);
    const value=path==='/api/app/session'?{authenticated:true,csrf_token:'synthetic-CSRF'}:path==='/api/app/saved-audio-trial'?{grant:control.grant||null}:{provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:control.reply||'这两天的不舒服在饭后更明显，我记下了。',model_id:'synthetic'};
    return{ok:true,status:200,json:async()=>value};
  }});vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'),'utf8'),ctx);
  const api=ctx.HealthLocal,pass='synthetic-new-audio-grant-only';if(!await driver.getMeta('vault'))await api.vault.setup(pass);
  const ready=api.initialise();await new Promise(setImmediate);el('vaultPassphrase').value=pass;await el('vaultForm').onsubmit({preventDefault(){}});await ready;
  const request=(path,body)=>api.request(path,{method:body===undefined?'GET':'POST',...(body!==undefined?{body:JSON.stringify(body)}:{}),headers:{'Idempotency-Key':webcrypto.randomUUID()}});
  return{api,driver,ctx,control,calls,request,ai:()=>calls.filter(c=>c.path==='/api/ai/conversation-turn')};
}
async function prepared(scenario="N03"){
  const reviewedAsr=scenario==='ReviewedAsr',cough=reviewedAsr||scenario==='N01'||scenario==='N01Reviewed'||scenario==='N03Reviewed',text=cough?'我咳嗽两天了，晚上明显些。':TEXT,sourceVersion=scenario==="N01"?1:reviewedAsr?4:2;
  const control={reply:cough?'您说的咳嗽两天、晚上更明显，我记下了。':'这两天的不舒服在饭后更明显，我记下了。'},h=await realm(undefined,control),event=(await h.request('/api/events',{raw_text:text,source_kind:'audio_transcript'})).j.event;
  let media={media_id:'media_'+webcrypto.randomUUID().replaceAll('-',''),subject_id:'subject_self',kind:'audio',content_type:'audio/wav',version:5,recognition_status:'succeeded',recognition:{text:cough?'我咳嗽两天了，晚上更明显。':'上妇这?两天不舒服，吃完饭后明显',is_mock:false},event_link:{record_id:event.record_id},trial_control:{review_required:true,state:'review_required',...(reviewedAsr?{asr_trial_receipt_id:'synthetic-asr-receipt',asr_trial_receipt_sha256:'d'.repeat(64)}:{})}};
  await h.api.vault.put('media:'+media.media_id,media);await h.api.vault.putBinary('media-binary:'+media.media_id,new Uint8Array([1,2,3]).buffer,{});
  // Explicitly invented imported first-revision attestation; never edits the actual N01 record.
  let reviewed=scenario==='N01'?{...event,source_review:{method:'original_comparison',record_id:event.record_id,text,confirmed_at:'2026-10-11T00:00:00Z'}}:(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event;
  if(reviewedAsr){reviewed={...reviewed,version:sourceVersion};await h.api.vault.put('event:'+reviewed.record_id,reviewed)}
  if(scenario!=='N01')media=(await h.request('/api/media/'+media.media_id)).j.media;
  if(scenario==='N01')await h.api.vault.put('event:'+event.record_id,reviewed);assert.equal(reviewed.version,sourceVersion);
  const previous=reviewedAsr?{review_required:true,state:'stopped',source_kind:'audio_transcript',conversation_id:null,turn_id:'turn_old_asr',turn_version:1,media_id:'media_'+ 'c'.repeat(32),asr_trial_receipt_id:'old-receipt',asr_trial_receipt_sha256:'c'.repeat(64)}:{review_required:true,state:'review_required',media_id:media.media_id,conversation_id:null};await h.api.vault.put('trial-control:voice',previous);
  const c=(await h.request('/api/conversations/start',{mode:'new',local_date:'2026-10-10'})).j.conversation,gid='a'.repeat(32);
  const payload={subject_id:'subject_self',turns:[{turn_id:'turn_saved_audio_'+gid,text,version:1,source:{kind:'audio_transcript',status:'original_comparison',record_id:reviewed.record_id,record_version:sourceVersion,media_id:media.media_id,media_version:media.version},responding_to:{turn_id:'turn_saved_audio_opening_'+gid,text:c.turns[0].text}}],controller:c.controller,health_context:[]};
  control.grant={schema_version:reviewedAsr?'noreset-reviewed-asr-saved-audio-llm-v1':scenario==='N01'?'noreset-n01-saved-audio-llm-v1':scenario==='N01Reviewed'?'noreset-n01-saved-audio-llm-reviewed-v2':scenario==='N03Reviewed'?'noreset-n03-cough-reviewed-saved-audio-llm-v1':'noreset-n03-saved-audio-llm-v1',grant_id:gid,receipt_sha256:'b'.repeat(64),expires_at:new Date(Date.now()+600000).toISOString(),requests:1,retries:0,
    source:{media_id:media.media_id,media_version:media.version,record_id:reviewed.record_id,source_version:sourceVersion,subject_id:'subject_self',text_sha256:sha(text),confirmed_at:reviewed.source_review.confirmed_at,audio_sha256:sha(Buffer.from([1,2,3]))},prior_media_control:media.trial_control,prior_global_control:previous,http_payload_sha256:sha(JSON.stringify(payload))};
  const input={media_id:media.media_id,media_version:media.version,record_id:reviewed.record_id,source_version:sourceVersion,local_date:'2026-10-10'};
  return {...h,media,event:reviewed,previous,input,payload,start:()=>h.request('/api/conversations/saved-audio-trial/start',input)};
}
async function assertMediaUnchanged(h){
  const {delete_eligibility:_derived,...expected}=h.media;
  assert.deepEqual(await h.api.vault.get('media:'+h.media.media_id),expected,'trial dispatch must not rewrite persisted media');
  const reread=(await h.request('/api/media/'+h.media.media_id)).j.media;
  assert.deepEqual(JSON.parse(JSON.stringify(reread.delete_eligibility)),{allowed:false,reason:'trial_controlled'},'read-time deletion eligibility is derived, not persisted');
}
test('new independent grant sends only corrected current source once; old stop, ASR, link and original remain intact',async()=>{
  const h=await prepared(),x=await h.start();assert.equal(x.r.status,201,JSON.stringify(x.j));assert.equal(x.j.ai_failed,false);assert.equal(h.ai().length,1);
  assert.deepEqual(JSON.parse(h.ai()[0].body),JSON.parse(JSON.stringify(h.payload)));assert.equal(h.ai()[0].headers['X-NoReset-Saved-Audio-Trial'],h.control.grant.grant_id);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);await assertMediaUnchanged(h);
  assert.equal(x.j.conversation.saved_audio_trial.state,'completed');assert.equal((await h.start()).j.created,false);assert.equal(h.ai().length,1);
  const fresh=await realm(h.driver,h.control);assert.equal((await fresh.request('/api/conversations/saved-audio-trial/start',h.input)).j.created,false);assert.equal(fresh.ai().length,0);
  assert.match(x.j.conversation.report.body,/上腹/);assert.doesNotMatch(x.j.conversation.report.body,/上妇/);
});
test('exact N03 reviewed schema accepts only the corrected v2 fixture and preserves the one-call payload',async()=>{
  const h=await prepared('N03Reviewed');
  assert.equal(h.control.grant.schema_version,'noreset-n03-cough-reviewed-saved-audio-llm-v1');
  assert.equal(h.input.source_version,2);assert.equal(h.event.raw_text,'我咳嗽两天了，晚上明显些。');
  const x=await h.start();assert.equal(x.r.status,201,JSON.stringify(x.j));assert.equal(x.j.ai_failed,false);assert.equal(h.ai().length,1);
  assert.deepEqual(JSON.parse(h.ai()[0].body),JSON.parse(JSON.stringify(h.payload)));
  assert.equal(x.j.conversation.saved_audio_trial.source_version,2);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
  const restarted=await realm(h.driver,h.control);await restarted.request('/api/conversations/saved-audio-trial/start',h.input);assert.equal(restarted.ai().length,0);
});
test('exact N03 reviewed schema rejects a different source revision or schema',async()=>{
  for(const mode of ['source_version','schema']){
    const h=await prepared('N03Reviewed');
    if(mode==='source_version')h.control.grant.source.source_version=1;
    else h.control.grant.schema_version='noreset-n03-cough-reviewed-saved-audio-llm-v2';
    assert.equal((await h.start()).r.ok,false);assert.equal(h.ai().length,0);
  }
});
test('reviewed ASR schema dispatches the exact current source while preserving different recording stop controls',async()=>{
  for(const state of ['stopped','review_required']){
    const h=await prepared('ReviewedAsr'),before=await h.api.vault.get('event:'+h.event.record_id);
    h.previous={...h.previous,state};h.control.grant.prior_global_control=h.previous;
    await h.api.vault.put('trial-control:voice',h.previous);
    assert.equal(h.control.grant.schema_version,'noreset-reviewed-asr-saved-audio-llm-v1');
    assert.equal(h.input.source_version,4);
    assert.equal(await h.api.savedAudioTrialAvailable(h.media.media_id),true);
    const x=await h.start();assert.equal(x.r.status,201,JSON.stringify(x.j));assert.equal(h.ai().length,1);
    assert.deepEqual(JSON.parse(h.ai()[0].body),JSON.parse(JSON.stringify(h.payload)));
    assert.deepEqual(await h.api.vault.get('event:'+h.event.record_id),before);
    await assertMediaUnchanged(h);
    assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
    assert.equal(await h.api.vault.get('saved-audio-trial:'+h.control.grant.grant_id).then(claim=>claim.state),'completed');
    const restarted=await realm(h.driver,h.control);await restarted.request('/api/conversations/saved-audio-trial/start',h.input);assert.equal(restarted.ai().length,0);
  }
});
test('reviewed ASR schema keeps current-source, owner, authenticity, and one-shot claim guards',async()=>{
  for(const mode of ['version','zero_version','string_version','unsafe_version','media','owner','text_hash','audio_hash','mock','unreviewed','claim',
    'completed_global','owned_global','same_media_global','completed_media','missing_media_review','missing_asr_receipt','nonstring_asr_receipt','malformed_asr_receipt_hash']){
    const h=await prepared('ReviewedAsr');
    if(mode==='version')h.control.grant.source.source_version=3;
    if(mode==='zero_version')h.control.grant.source.source_version=0;
    if(mode==='string_version')h.control.grant.source.source_version='4';
    if(mode==='unsafe_version'){
      const version=Number.MAX_SAFE_INTEGER+1,event=await h.api.vault.get('event:'+h.event.record_id);
      await h.api.vault.put('event:'+h.event.record_id,{...event,version});
      h.event={...h.event,version};h.input.source_version=version;h.control.grant.source.source_version=version;
    }
    if(mode==='media')h.control.grant.source.media_version--;
    if(mode==='owner')h.control.grant.source.subject_id='subject_family';
    if(mode==='text_hash')h.control.grant.source.text_sha256='0'.repeat(64);
    if(mode==='audio_hash')h.control.grant.source.audio_sha256='0'.repeat(64);
    if(mode==='mock')await h.api.vault.put('media:'+h.media.media_id,{...h.media,recognition:{...h.media.recognition,is_mock:true}});
    if(mode==='unreviewed')await h.api.vault.put('event:'+h.event.record_id,{...h.event,source_review:null});
    if(mode==='claim')await h.api.vault.put('saved-audio-trial:'+h.control.grant.grant_id,{state:'completed'});
    if(['completed_global','owned_global','same_media_global'].includes(mode)){
      const global={...h.previous,...(mode==='completed_global'?{state:'completed'}:{}),...(mode==='owned_global'?{conversation_id:'conversation_old_asr'}:{}),...(mode==='same_media_global'?{media_id:h.media.media_id}:{})};
      h.previous=global;h.control.grant.prior_global_control=global;await h.api.vault.put('trial-control:voice',global);
    }
    if(['completed_media','missing_media_review','missing_asr_receipt','nonstring_asr_receipt','malformed_asr_receipt_hash'].includes(mode)){
      const priorMedia={...h.media.trial_control,...(mode==='completed_media'?{state:'completed'}:{}),...(mode==='missing_media_review'?{review_required:false}:{}),
        ...(mode==='missing_asr_receipt'?{asr_trial_receipt_id:''}:{}),...(mode==='nonstring_asr_receipt'?{asr_trial_receipt_id:7}:{}),
        ...(mode==='malformed_asr_receipt_hash'?{asr_trial_receipt_sha256:'not-a-hash'}:{})};
      h.media={...h.media,trial_control:priorMedia};h.control.grant.prior_media_control=priorMedia;
      await h.api.vault.put('media:'+h.media.media_id,h.media);
    }
    const result=await h.start();assert.equal(result.r.ok,false,mode);assert.equal(h.ai().length,0,mode);
    assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous,mode);
  }
});
test('unrelated old terminal global control remains rejected by existing saved-audio schemas',async()=>{
  const h=await prepared('N03Reviewed');
  const unrelated={review_required:true,state:'stopped',source_kind:'audio_transcript',conversation_id:'conversation_old_asr',
    turn_id:'turn_old_asr',turn_version:1,media_id:'media_'+ 'c'.repeat(32)};
  h.previous=unrelated;h.control.grant.prior_global_control=unrelated;
  await h.api.vault.put('trial-control:voice',unrelated);
  const result=await h.start();assert.equal(result.r.ok,false);assert.equal(h.ai().length,0);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),unrelated);
});
for(const mode of ['missing','expired','version','unreviewed','confirmation','text','receipt','input','old_sending','family','original_missing','mock_media','changed_original'])test(mode+' cannot dispatch',async()=>{
  const h=await prepared();
  if(mode==='missing')h.control.grant=null;
  if(mode==='expired')h.control.grant.expires_at='2000-01-01T00:00:00Z';
  if(mode==='version')h.control.grant.source.source_version=1;
  if(mode==='confirmation')h.control.grant.source.confirmed_at='2000-01-01T00:00:00Z';
  if(mode==='text')h.control.grant.source.text_sha256='0'.repeat(64);
  if(mode==='receipt')h.control.grant.receipt_sha256='forged';
  if(mode==='input')h.control.grant.http_payload_sha256='0'.repeat(64);
  if(mode==='unreviewed')await h.api.vault.put('event:'+h.event.record_id,{...h.event,source_review:null});
  if(mode==='old_sending')await h.api.vault.put('trial-control:voice',{...h.previous,state:'continuing'});
  if(mode==='family')h.control.grant.source.subject_id='subject_family';
  if(mode==='original_missing')await h.api.vault.remove('media-binary:'+h.media.media_id);
  if(mode==='mock_media')await h.api.vault.put('media:'+h.media.media_id,{...h.media,recognition:{...h.media.recognition,is_mock:true}});
  if(mode==='changed_original')await h.api.vault.putBinary('media-binary:'+h.media.media_id,new Uint8Array([9,9]).buffer,{});
  assert.equal((await h.start()).r.ok,false);assert.equal(h.ai().length,0);assert.equal(await h.api.vault.get('saved-audio-trial:'+'a'.repeat(32)),undefined);
});
test('two pages and repeated clicks share an atomic local claim and one conversation',async()=>{
  const h=await prepared(),other=await realm(h.driver,h.control);
  const results=await Promise.all([h.start(),h.start(),other.request('/api/conversations/saved-audio-trial/start',h.input)]);
  assert.equal(h.ai().length+other.ai().length,1);assert.equal(new Set(results.filter(x=>x.r.ok).map(x=>x.j.conversation.conversation_id)).size,1);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
});
test('expiry or a correction after local claim but before supplier dispatch stops without retry after restart',async()=>{
  for(const mode of ['expiry','correction']){
    const h=await prepared();let grantReads=0;
    h.control.onFetch=async path=>{if(path==='/api/app/saved-audio-trial'&&++grantReads===2){
      if(mode==='expiry')h.control.grant.expires_at='2000-01-01T00:00:00Z';
      else await h.api.vault.put('event:'+h.event.record_id,{...h.event,version:3,source_review:null,raw_text:TEXT+'虚构修订'});
    }};
    const x=await h.start();assert.equal(x.j.ai_failed,true);assert.equal(h.ai().length,0);
    const fresh=await realm(h.driver,h.control);await fresh.request('/api/conversations/saved-audio-trial/start',h.input);assert.equal(fresh.ai().length,0);
    assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
  }
});
test('network failure or unknown interrupted local claim never causes automatic replay',async()=>{
  const h=await prepared();h.control.onFetch=async path=>{if(path==='/api/ai/conversation-turn')throw Error('synthetic transport loss')};
  const x=await h.start();assert.equal(x.j.ai_failed,true);assert.equal(h.ai().length,1);
  const key='saved-audio-trial:'+h.control.grant.grant_id,claim=await h.api.vault.get(key);await h.api.vault.put(key,{...claim,state:'sending'});
  const fresh=await realm(h.driver,h.control);await fresh.request('/api/conversations/saved-audio-trial/start',h.input);
  await fresh.request('/api/conversations/'+x.j.conversation.conversation_id+'/resume-assistant',{});assert.equal(fresh.ai().length,0);
});
test('normal media new-conversation entry uses the independent local route; no generic trial is cleared',async()=>{
  const h=await prepared(),source=fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');let current;
  const ctx=vm.createContext({HealthSafety:safety,HealthLocal:h.api,api:h.api.request,mediaRequest:async path=>(await h.request(path)).j,isMockMedia:()=>false,isMockContent:()=>false,
    localDateValue:()=>h.input.local_date,syncConversation:c=>{current=c},showView:()=>{},mediaMessage:()=>{},savedAudioTrialMessage:()=> '回复已保存；本次单次测试已结束。',setVoiceStatus:()=>{},setVoiceComposerEnabled:()=>{},loadEvents:async()=>{},startSeparateConversation:()=>{throw Error('must not use the old generic start')}});
  vm.runInContext(source.slice(source.indexOf('async function currentSavedAudioSource('),source.indexOf('function showRecognition(')),ctx);
  assert.equal(await ctx.startConversationFromSavedAudio(h.media),true);assert.equal(current.saved_audio_trial.state,'completed');assert.equal(h.ai().length,1);assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
});
test('record accuracy confirmation never clears an existing danger or forces a model request',async()=>{
  const h=await prepared();await h.api.vault.put('event:'+h.event.record_id,{...h.event,local_safety:{...h.event.local_safety,danger_detected:true}});
  const x=await h.start();assert.equal(h.ai().length,0);assert.equal(x.j.conversation.turns.at(-1).action,'urgent');
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);assert.equal((await h.api.vault.get('event:'+h.event.record_id)).local_safety.danger_detected,true);
});


test('N01 already reviewed version1 starts once with exact source and no invented second revision',async()=>{
  const h=await prepared('N01'),sourceBefore=await h.api.vault.get('event:'+h.event.record_id);
  const x=await h.start();assert.equal(x.r.status,201);assert.equal(h.ai().length,1);
  assert.deepEqual(JSON.parse(h.ai()[0].body),JSON.parse(JSON.stringify(h.payload)));
  assert.equal(x.j.conversation.saved_audio_trial.source_version,1);
  assert.match(x.j.conversation.report.body,/咳嗽/);assert.doesNotMatch(x.j.conversation.report.body,/上腹|饭后/);
  assert.equal(x.j.conversation.turns.find(t=>t.role==='elder').record_id,h.event.record_id);
  assert.deepEqual(await h.api.vault.get('event:'+h.event.record_id),sourceBefore);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
  const other=await realm(h.driver,h.control);await other.request('/api/conversations/saved-audio-trial/start',h.input);assert.equal(other.ai().length,0);
});
for(const mode of ['unreviewed','expired','version2','text','original','family','schema'])test('N01 version1 '+mode+' cannot dispatch',async()=>{
  const h=await prepared('N01');
  if(mode==='unreviewed')await h.api.vault.put('event:'+h.event.record_id,{...h.event,source_review:null});
  if(mode==='expired')h.control.grant.expires_at='2000-01-01T00:00:00Z';
  if(mode==='version2')h.control.grant.source.source_version=2;
  if(mode==='text')await h.api.vault.put('event:'+h.event.record_id,{...h.event,raw_text:'合成修改后的文字'});
  if(mode==='original')await h.api.vault.putBinary('media-binary:'+h.media.media_id,new Uint8Array([4,5]).buffer,{});
  if(mode==='family')h.control.grant.source.subject_id='subject_family';
  if(mode==='schema')h.control.grant.schema_version='noreset-n03-saved-audio-llm-v1';
  assert.equal((await h.start()).r.ok,false);assert.equal(h.ai().length,0);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
});
test('N01 version1 repeated pages share one durable claim even after transport interruption',async()=>{
  const h=await prepared('N01'),other=await realm(h.driver,h.control);
  h.control.onFetch=async path=>{if(path==='/api/ai/conversation-turn')throw Error('synthetic transport loss')};
  await Promise.all([h.start(),h.start(),other.request('/api/conversations/saved-audio-trial/start',h.input)]);
  assert.equal(h.ai().length+other.ai().length,1);
  const restarted=await realm(h.driver,h.control);await restarted.request('/api/conversations/saved-audio-trial/start',h.input);assert.equal(restarted.ai().length,0);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
});

test('N01 normal source-review advances to v2 and its exact independent grant dispatches once',async()=>{
  const h=await prepared('N01Reviewed'),before=await h.api.vault.get('event:'+h.event.record_id);
  assert.equal(before.version,2);assert.equal(before.source_review.text,'我咳嗽两天了，晚上明显些。');
  const x=await h.start();assert.equal(x.r.status,201);assert.equal(h.ai().length,1);
  assert.equal(x.j.conversation.saved_audio_trial.source_version,2);
  assert.deepEqual(await h.api.vault.get('event:'+h.event.record_id),before);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
  await assertMediaUnchanged(h);
  const restarted=await realm(h.driver,h.control);await restarted.request('/api/conversations/saved-audio-trial/start',h.input);assert.equal(restarted.ai().length,0);
});
for(const drift of ['version1','version3','schema','confirmation','unreviewed'])test('N01 reviewed v2 '+drift+' cannot dispatch',async()=>{
  const h=await prepared('N01Reviewed');
  if(drift==='version1')h.control.grant.source.source_version=1;
  if(drift==='version3')h.control.grant.source.source_version=3;
  if(drift==='schema')h.control.grant.schema_version='noreset-n01-saved-audio-llm-v1';
  if(drift==='confirmation')h.control.grant.source.confirmed_at='2000-01-01T00:00:00Z';
  if(drift==='unreviewed')await h.api.vault.put('event:'+h.event.record_id,{...h.event,source_review:null});
  assert.equal((await h.start()).r.ok,false);assert.equal(h.ai().length,0);
  assert.deepEqual(await h.api.vault.get('trial-control:voice'),h.previous);
});

test('grant availability for linked source is read-only and closes once claimed or changed',async()=>{
  const h=await prepared('N01Reviewed'),before=await h.driver.snapshot();
  assert.equal(await h.api.savedAudioTrialAvailable(h.media.media_id),true);assert.equal(h.ai().length,0);
  assert.deepEqual(await h.driver.snapshot(),before);
  await h.start();assert.equal(await h.api.savedAudioTrialAvailable(h.media.media_id),false);assert.equal(h.ai().length,1);
  const unreviewed=await prepared('N01Reviewed');await unreviewed.api.vault.put('event:'+unreviewed.event.record_id,{...unreviewed.event,source_review:null});
  assert.equal(await unreviewed.api.savedAudioTrialAvailable(unreviewed.media.media_id),false);assert.equal(unreviewed.ai().length,0);
});

async function preparedReviewedAsrWithoutGlobalControl(){
  const h=await prepared('ReviewedAsr');
  await h.api.vault.remove('trial-control:voice');
  h.previous=null;h.control.grant.prior_global_control=null;
  return h;
}
test('reviewed ASR saved-audio trial accepts an exactly-null prior control and leaves the key absent',async()=>{
  const h=await preparedReviewedAsrWithoutGlobalControl();
  assert.equal(await h.api.trialVoiceState(),null);
  assert.equal(await h.api.savedAudioTrialAvailable(h.media.media_id),true);
  const x=await h.start();
  assert.equal(x.r.status,201,'the local one-shot route should persist through the stub fetch');
  assert.equal(x.j.ai_failed,false);
  assert.equal(h.ai().length,1,'exactly one intercepted provider request');
  assert.equal(await h.api.vault.get('trial-control:voice'),undefined,'an absent global control stays absent');
  assert.equal((await h.api.vault.get('saved-audio-trial:'+h.control.grant.grant_id)).state,'completed');
  assert.equal((await h.api.vault.get('conversation:conversation_saved_audio_'+h.control.grant.grant_id)).saved_audio_trial.state,'completed');
});
test('reviewed ASR null grant cannot match a non-null prior control or a concurrent new control',async()=>{
  const mismatch=await preparedReviewedAsrWithoutGlobalControl();
  mismatch.control.grant.prior_global_control={state:'stopped'};
  assert.equal(await mismatch.api.savedAudioTrialAvailable(mismatch.media.media_id),false);
  assert.equal((await mismatch.start()).r.ok,false);assert.equal(mismatch.ai().length,0);

  const raced=await preparedReviewedAsrWithoutGlobalControl();
  raced.control.onFetch=async path=>{
    if(path==='/api/app/saved-audio-trial'&&!await raced.api.vault.get('trial-control:voice'))
      await raced.api.vault.put('trial-control:voice',{review_required:true,state:'stopped',conversation_id:'other',media_id:null});
  };
  const result=await raced.start();
  assert.equal(result.r.ok,false);assert.equal(raced.ai().length,0,'a concurrently added global control blocks dispatch');
  assert.equal((await raced.api.vault.get('trial-control:voice')).conversation_id,'other');

  const late=await preparedReviewedAsrWithoutGlobalControl();let grantReads=0;
  late.control.onFetch=async path=>{
    if(path==='/api/app/saved-audio-trial'&&++grantReads===2)
      await late.api.vault.put('trial-control:voice',null);
  };
  const lateResult=await late.start();
  assert.equal(lateResult.j.ai_failed,true);assert.equal(late.ai().length,0,'even an explicit null write changes the raw absent-key snapshot');
  assert.equal(await late.api.vault.get('trial-control:voice'),null);
});
test('the first atomic claim compares absent and explicit-null global-control snapshots distinctly',async()=>{
  const h=await preparedReviewedAsrWithoutGlobalControl();let installed=false;
  h.control.onFetch=async path=>{
    if(path==='/api/app/saved-audio-trial'&&!installed){installed=true;await h.api.vault.put('trial-control:voice',null)}
  };
  const result=await h.start();
  assert.equal(result.r.ok,false);assert.equal(h.ai().length,0);
  assert.equal(await h.api.vault.get('trial-control:voice'),null);
  assert.equal(await h.api.vault.get('saved-audio-trial:'+h.control.grant.grant_id),undefined,'the failed CAS writes no claim');
  assert.equal(await h.api.vault.get('conversation:conversation_saved_audio_'+h.control.grant.grant_id),undefined,'the failed CAS writes no conversation');
});
test('reviewed ASR still rejects non-empty old controls that are not an eligible prior stop',async()=>{
  const h=await preparedReviewedAsrWithoutGlobalControl();
  const old={review_required:true,state:'completed',source_kind:'elder',conversation_id:'old-conversation',media_id:null};
  h.previous=old;h.control.grant.prior_global_control=old;await h.api.vault.put('trial-control:voice',old);
  assert.equal(await h.api.savedAudioTrialAvailable(h.media.media_id),false);
  assert.equal((await h.start()).r.ok,false);assert.equal(h.ai().length,0);
  assert.equal((await h.api.vault.get('trial-control:voice')).state,'completed');
});

test('actual reviewed audio backup restores in isolated memory and reaches only the stub fetch',
  {skip:!process.env.BINGLI_QA_BACKUP_PASSPHRASE},async()=>{
    const backupPath=path.resolve(__dirname,'../.dz/evidence/goal-acceptance-2026-10-11/continue-human-mic-20261017/root/08-final-human.encrypted.bingli');
    const h=await realm();
    const archive=JSON.parse(fs.readFileSync(backupPath,'utf8'));
    await h.api.vault.restoreArchive(archive,process.env.BINGLI_QA_BACKUP_PASSPHRASE);
    const mediaId='media_41842cacc7724cbb99cf08bc96518d56',recordId='rec_080d2bd053694c968f4ffcafd60f2019';
    const media=await h.api.vault.get('media:'+mediaId),event=await h.api.vault.get('event:'+recordId);
    const events=(await h.request('/api/events')).j.events;
    assert.equal(await h.api.trialVoiceState(),null,'restored global audio control is absent');
    assert.equal(event.source_review?.record_id,recordId);assert.equal(event.version,2);
    assert.equal(media.version,6);
    assert.equal(media.event_link?.record_id||media.record_id,'rec_13554ea22c214da0aab40a7de8a3b00c','the original media link remains historical');
    assert.equal(safety.currentAudioSource(media,events)?.record_id,recordId,'the current source follows the correction chain');
    assert.equal(await h.api.vault.get('saved-audio-trial-source:'+mediaId+':'+recordId+':'+event.version),undefined);

    const c=(await h.request('/api/conversations/start',{mode:'new',local_date:'2026-10-18'})).j.conversation;
    const grantId=webcrypto.randomUUID().replaceAll('-','');
    const contexts=(c.health_context||[]).map(item=>{const {legacy_entry,...value}=item;if(legacy_entry&&value.temporal_status==null)delete value.temporal_status;return value});
    const payload={subject_id:c.subject_id,turns:[{turn_id:'turn_saved_audio_'+grantId,text:event.raw_text,version:1,source:{kind:'audio_transcript',status:'original_comparison',record_id:event.record_id,record_version:event.version,media_id:media.media_id,media_version:media.version},responding_to:{turn_id:'turn_saved_audio_opening_'+grantId,text:c.turns[0].text}}],controller:c.controller,health_context:contexts};
    const original=await h.api.vault.get('media-binary:'+mediaId);
    h.control.grant={schema_version:'noreset-reviewed-asr-saved-audio-llm-v1',grant_id:grantId,receipt_sha256:'b'.repeat(64),expires_at:new Date(Date.now()+600000).toISOString(),requests:1,retries:0,
      source:{media_id:mediaId,media_version:media.version,record_id:recordId,source_version:event.version,subject_id:'subject_self',text_sha256:sha(event.raw_text),confirmed_at:event.source_review.confirmed_at,audio_sha256:sha(Buffer.from(original.bytes))},
      prior_media_control:media.trial_control,prior_global_control:null,http_payload_sha256:sha(JSON.stringify(payload))};
    assert.equal(await h.api.savedAudioTrialAvailable(mediaId),true,'the restored real source passes the one-time local gate');
    const x=await h.request('/api/conversations/saved-audio-trial/start',{media_id:mediaId,media_version:media.version,record_id:recordId,source_version:event.version,local_date:'2026-10-18'});
    assert.equal(x.r.status,201,'the actual restored record reaches and completes the intercepted stub');
    assert.equal(h.ai().length,1,'only one intercepted provider request');
    assert.equal(await h.api.vault.get('trial-control:voice'),undefined,'restore-path global control remains absent');
    assert.equal((await h.api.vault.get('saved-audio-trial:'+grantId)).state,'completed');
    assert.equal((await h.api.vault.get('conversation:conversation_saved_audio_'+grantId)).saved_audio_trial.state,'completed');
  });

for(const [allowed,linked] of [[false,true],[true,true],[false,false]])test('audio UI preserves standalone entry and requires matching grant for linked source '+allowed+'/'+linked,async()=>{
  const box={isConnected:true,children:[],append(x){this.children.push(x)}},source=fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');
  let reads=0,sends=0;
  const ctx=vm.createContext({document:{createElement:()=>({})},$:()=>({querySelector:()=>box}),isMockMedia:()=>false,safetyHtml:()=>'',escapeHtml:x=>x,reveal:()=>{},HealthLocal:{savedAudioTrialAvailable:async()=>{reads++;return allowed}},startConversationFromSavedAudio:async()=>{sends++;return true},mediaMessage:()=>{}});
  vm.runInContext(source.slice(source.indexOf('const AUDIO_REVIEW_LABELS='),source.indexOf('function mediaMessage(')),ctx);
  vm.runInContext(source.slice(source.indexOf('function showRecognition('),source.indexOf('function recognitionStillFinishing(')),ctx);
  ctx.showRecognition({media_id:'media_'+'1'.repeat(32),kind:'audio',recognition_status:'succeeded',event_link:{record_id:'rec_'+'2'.repeat(32)},recognition:{text:'我咳嗽两天了，晚上明显些。'},conversation_id:linked?'old-conversation':null,trial_control:{state:'completed',review_required:true}});
  await new Promise(setImmediate);assert.equal(reads,linked?1:0);assert.equal(sends,0);
  const button=box.children.find(x=>x.textContent==='用录音文字新建对话');assert.equal(Boolean(button),!linked||allowed);
  if(button){await button.onclick();assert.equal(sends,1);}
});
