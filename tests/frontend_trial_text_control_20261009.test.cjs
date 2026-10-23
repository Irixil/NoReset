// Synthetic controlled source over actual local store + encrypted Memory driver.
// External HTTP is a stub; these are not browser/provider/clinical proofs.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),core=require('../frontend/local-store-core.js'),safety=require('../frontend/safety.js');
async function harness(shared){
 const driver=shared?.driver||new core.MemoryDocumentStore(),calls=shared?.calls||[],responses=shared?.responses||new Map(),elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,focus(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)};
 const context=vm.createContext({HealthLocalCore:{...core,IndexedDbDocumentStore:class{constructor(){return driver}}},HealthSafety:safety,indexedDB:{},crypto:webcrypto,FormData,Blob,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,navigator:{storage:{}},document:{getElementById:el,querySelector:()=>null},fetch:async(path,options)=>{calls.push({path,...options});const value=responses.has(path)?await responses.get(path):path==='/api/app/session'?{authenticated:true,csrf_token:'synthetic-csrf'}:{action:'reply',assistant_text:'我已按您说的保留这段记录。',provider:'SyntheticMechanicalFixture'};return{ok:!(value.__status>=400),status:value.__status||200,json:async()=>value};}});
 vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'),'utf8'),context);const api=context.HealthLocal,password='synthetic-controlled-text-only';if(!shared)await api.vault.setup(password);const ready=api.initialise();await new Promise(setImmediate);el('vaultPassphrase').value=password;await el('vaultForm').onsubmit({preventDefault(){}});await ready;
 const request=(p,b,h={})=>api.request(p,b===undefined?{}:{method:'POST',body:JSON.stringify(b),headers:h}),get=async c=>(await request('/api/conversations/'+c.conversation_id)).j.conversation;
 const start=async()=>(await request('/api/conversations/start',{mode:'new',local_date:'2026-10-09'})).j.conversation;
 return{driver,calls,responses,api,request,get,start,el};
}
const cloudCount=h=>h.calls.filter(c=>c.path==='/api/ai/conversation-turn').length;
const continueBody=c=>({expected_version:c.version,turn_id:c.trial_control.turn_id,turn_version:c.trial_control.turn_version});
const firstText='咳嗽两天，晚上明显。',secondText='不是两天，是三天，别的变化我不清楚。';
async function completed(h){
 let c=await h.start();const media_id='media_'+webcrypto.randomUUID().replaceAll('-','');await h.api.vault.put('media:'+media_id,{media_id,kind:'audio',content_type:'audio/wav',original_filename:'synthetic.wav',temporary:true,conversation_id:c.conversation_id,save_status:'saved',recognition_status:'not_started',link_status:'not_linked',version:1});await h.api.vault.putBinary('media-binary:'+media_id,new Uint8Array([1,2,3,4]).buffer);h.responses.set('/api/ai/media/recognize',{recognition:{text:firstText,is_mock:false},trial_control:{review_required:true}});await h.request('/api/media/'+media_id+'/recognize',{});let media,event;for(let i=0;i<100;i++){media=(await h.request('/api/media/'+media_id)).j.media;if(media.recognition_status==='succeeded')break;await new Promise(r=>setTimeout(r,3))}event=(await h.request('/api/events/'+media.record_id)).j.event;const reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event;media=(await h.request('/api/media/'+media_id)).j.media;c=await h.get(c);const linked=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text:event.raw_text,source_kind:'audio_transcript',record_id:event.record_id,media_id,source_version:reviewed.version,media_version:media.version,expected_version:c.version,keep_media_until_pause:true},{'Idempotency-Key':'synthetic-reviewed-trial:'+media_id});assert.equal(linked.r.ok,true);c=linked.j.conversation;assert.equal(c.trial_control.state,'review_required');await h.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(c));c=await h.get(c);assert.equal(c.trial_control.state,'completed');return{c,media_id};
}
async function add(h,c,key='synthetic-text-second'){return h.request('/api/conversations/'+c.conversation_id+'/turns',{text:secondText,source_kind:'elder',expected_version:c.version},{'Idempotency-Key':key});}
async function edit(h,c,t,text){return h.request('/api/conversations/'+c.conversation_id+'/turns/'+t.turn_id,{text,expected_version:t.version,expected_conversation_version:c.version});}
async function ordinaryReviewedAudioTurn(h){
 let c=await h.start();const event=(await h.request('/api/events',{raw_text:firstText,source_kind:'audio_transcript'})).j.event,mediaId='media_'+webcrypto.randomUUID().replaceAll('-','');
 const media={media_id:mediaId,subject_id:'subject_self',kind:'audio',content_type:'audio/wav',original_filename:'ordinary-synthetic.wav',save_status:'saved',recognition_status:'succeeded',recognition:{text:firstText,is_mock:false},event_link:{record_id:event.record_id},record_id:event.record_id,version:1};
 await h.api.vault.put('media:'+mediaId,media);await h.api.vault.putBinary('media-binary:'+mediaId,new Uint8Array([1,2,3,4]).buffer);
 const reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event,currentMedia=(await h.request('/api/media/'+mediaId)).j.media;
 const linked=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text:firstText,source_kind:'audio_transcript',record_id:event.record_id,media_id:mediaId,source_version:reviewed.version,media_version:currentMedia.version,expected_version:c.version,keep_media_until_pause:true},{'Idempotency-Key':'synthetic-ordinary-audio:'+mediaId});
 assert.equal(linked.r.ok,true,JSON.stringify(linked.j));c=linked.j.conversation;return{c,turn:c.turns.find(turn=>turn.role==='elder'),mediaId,event,sourceVersion:reviewed.version};
}
test('completed same-owner second text saves encrypted sources and review state without a model; replay is unique',async()=>{
 const h=await harness(),{c,media_id}=await completed(h),before=cloudCount(h),oldMedia=await h.api.vault.get('media:'+media_id),oldBinary=await h.api.vault.get('media-binary:'+media_id);const saved=await add(h,c);assert.equal(saved.r.status,201);const next=saved.j.conversation,turn=next.turns.filter(t=>t.role==='elder').at(-1);assert.equal(next.trial_control.state,'review_required');assert.equal(next.trial_control.media_id,null);assert.equal(next.trial_control.turn_id,turn.turn_id);assert.equal(next.trial_control.turn_version,1);assert.equal(turn.source_kind,'elder');assert.equal(turn.text,secondText);assert.equal(turn.media_id,null);assert.equal(cloudCount(h),before);assert.equal(next.report.status,'auto_unreviewed');assert.deepEqual(Array.from(next.report.source_versions,s=>s.quote),[firstText,secondText]);const replay=await add(h,c);assert.equal(replay.j.created,false);assert.equal((await h.get(c)).turns.filter(t=>t.role==='elder').length,2);assert.equal((await h.api.vault.list('event:')).length,2);assert.equal(JSON.stringify(await h.driver.listDocs()).includes(secondText),false);assert.deepEqual(await h.api.vault.get('media:'+media_id),oldMedia);assert.deepEqual(await h.api.vault.get('media-binary:'+media_id),oldBinary);
});
test('new text invalidates prior analysis binding and current text edits bind v2 atomically; earlier edit does not steal owner',async()=>{
 const h=await harness(),{c}=await completed(h);const first=c.turns.find(t=>t.role==='elder');const seeded={...c,completeness:{clinical_state:{onset_course:{status:'known',summary:firstText,evidence_turn_ids:[first.turn_id],context_ids:[]}}},analysis_sources:{turns:[{turn_id:first.turn_id,version:1,quote:firstText}],selected_context_ids:[],context_version:0,context:[]}};await h.api.vault.put('conversation:'+c.conversation_id,seeded);let r=await add(h,seeded);assert.equal(r.r.status,201);let next=r.j.conversation;assert.equal(next.completeness,null);assert.equal(next.analysis_sources,null);const latest=next.turns.filter(t=>t.role==='elder').at(-1);r=await edit(h,next,latest,'不是两天，是三天，其他变化我不知道。');assert.equal(r.r.status,200);next=r.j.conversation;assert.equal(next.trial_control.turn_id,latest.turn_id);assert.equal(next.trial_control.turn_version,2);assert.equal((await h.api.trialVoiceState()).turn_version,2);const event=(await h.request('/api/events/'+latest.record_id)).j.event;assert.equal(event.version,2);assert.equal(event.raw_text,'不是两天，是三天，其他变化我不知道。');assert.ok(next.turns.find(t=>t.turn_id===latest.turn_id).versions.some(v=>v.version===1&&v.text===secondText));const bad=await edit(h,next,latest,'不应保存的旧版本');assert.equal(bad.r.status,409);r=await edit(h,next,first,'咳嗽两天，夜里明显。');assert.equal(r.r.status,409,'an ASR-derived turn must be corrected through the record and re-reviewed');assert.equal((await h.get(c)).trial_control.turn_id,latest.turn_id);assert.equal((await h.get(c)).trial_control.turn_version,2);assert.equal(cloudCount(h),1);
});
test('refresh cannot resume controlled text; one manual unauthorized backend rejection stops and preserves latest report',async()=>{
 const h=await harness(),{c}=await completed(h);const saved=await add(h,c);assert.equal(saved.r.status,201);const fresh=await harness(h),pending=await fresh.get(c);await fresh.request('/api/conversations/'+c.conversation_id+'/resume-assistant',{});assert.equal(cloudCount(h),1);fresh.responses.set('/api/ai/conversation-turn',{__status:422,error:'ai_conversation_failed',failure_code:'trial_authorization_required',trial_control:{review_required:true,stopped:true}});const rejection=await fresh.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(pending));assert.equal(rejection.r.status,202);const stopped=rejection.j.conversation;assert.equal(stopped.trial_control.state,'stopped');assert.equal(stopped.turns.filter(t=>t.role==='elder').at(-1).text,secondText);assert.deepEqual(Array.from(stopped.report.source_versions,s=>s.quote),[firstText,secondText]);assert.equal(cloudCount(h),2);await fresh.request('/api/conversations/'+c.conversation_id+'/resume-assistant',{});assert.equal((await fresh.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(stopped))).r.status,409);assert.equal(cloudCount(h),2);
});
test('different global owner blocks text save and correction without replacing stopped control or writing raw',async()=>{
 const h=await harness(),{c}=await completed(h),other=await h.start(),stop={review_required:true,state:'stopped',conversation_id:other.conversation_id,turn_id:'synthetic-other-owner',turn_version:1,media_id:null};await h.api.vault.put('trial-control:voice',stop);assert.equal((await add(h,c)).r.status,409);const t=c.turns.find(t=>t.role==='elder');assert.equal((await edit(h,c,t,'咳嗽三天。')).r.status,409);assert.deepEqual(await h.api.trialVoiceState(),stop);assert.equal((await h.get(c)).turns.find(t=>t.role==='elder').version,1);assert.equal((await h.api.vault.list('event:')).length,1);assert.equal(cloudCount(h),1);
});
test('local correction never unlocks stopped or continuing and wrong owner cannot manually continue',async()=>{
 for(const state of ['stopped','continuing']){const h=await harness(),{c}=await completed(h),control={...c.trial_control,state},changed={...c,trial_control:control};await h.api.vault.mutate({puts:[{key:'conversation:'+c.conversation_id,value:changed},{key:'trial-control:voice',value:control}]});const t=changed.turns.find(t=>t.role==='elder'),r=await edit(h,changed,t,'咳嗽三天，晚上明显。');assert.equal(r.r.status,409,'ASR-derived dialogue text remains locked for correction');assert.equal((await h.api.trialVoiceState()).state,state);assert.equal((await add(h,changed)).r.status,409);assert.equal(cloudCount(h),1);}
 const h=await harness(),{c}=await completed(h);const saved=await add(h,c);assert.equal(saved.r.status,201);await h.api.vault.put('trial-control:voice',{...saved.j.conversation.trial_control,conversation_id:'synthetic-other-conversation'});assert.equal((await h.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(saved.j.conversation))).r.status,409);assert.equal((await h.get(c)).trial_control.state,'review_required');assert.equal(cloudCount(h),1);
});
test('ordinary conversation can edit an audio transcript in chat and keeps the original source revision',async()=>{
 const h=await harness(),{c,turn,mediaId,event,sourceVersion}=await ordinaryReviewedAudioTurn(h),editedText='不是两天，是三天，晚上明显。';
 assert.equal(c.trial_control,undefined);assert.equal(c.saved_audio_trial,undefined);
 const result=await edit(h,c,turn,editedText);assert.equal(result.r.status,200,JSON.stringify(result.j));
 const edited=result.j.conversation.turns.find(item=>item.turn_id===turn.turn_id),savedEvent=(await h.request('/api/events/'+event.record_id)).j.event;
 assert.equal(edited.text,editedText);assert.equal(edited.version,2);assert.equal(edited.audio_source_reviewed,false);assert.equal(edited.audio_source_status,'user_edited');
 assert.equal(savedEvent.raw_text,editedText);assert.equal(savedEvent.version,sourceVersion+1);assert.equal(savedEvent.source_review,null);
 assert.ok(edited.versions.some(version=>version.version===1&&version.text===firstText));assert.ok(await h.api.vault.get('media-binary:'+mediaId));
});
test('saved-audio trial ASR cannot be edited through the ordinary chat-turn route',async()=>{
 const h=await harness(),{c,turn,event}=await ordinaryReviewedAudioTurn(h),savedAudio={...c,saved_audio_trial:{state:'completed',record_id:event.record_id,media_id:turn.media_id,source_version:turn.audio_source_version}};
 await h.api.vault.put('conversation:'+c.conversation_id,savedAudio);
 const before=await h.api.vault.get('event:'+event.record_id),result=await edit(h,savedAudio,turn,'不应进入单次录音试验的修改。');
 assert.equal(result.r.status,409);assert.equal(result.j.error,'audio_source_review_required');
 assert.deepEqual(await h.api.vault.get('event:'+event.record_id),before);assert.equal((await h.get(c)).turns.find(item=>item.turn_id===turn.turn_id).text,firstText);
});
test('text stop point uses source-neutral UI and local save label instead of claiming a new audio',()=>{
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:'三天。',disabled:false,textContent:''});return elements.get(id)},context=vm.createContext({activeConversation:{trial_control:{state:'completed',source_kind:'elder',media_id:null}},pendingAudioReview:null,$:el});const source=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');vm.runInContext(source.slice(source.indexOf('function setVoiceComposerEnabled('),source.indexOf('async function continueTrialVoice(')),context);vm.runInContext('setVoiceComposerEnabled(true)',context);assert.equal(el('voiceTextSend').textContent,'保存原话');assert.equal(el('voiceTextInput').disabled,false);const message=vm.runInContext('trialVoiceMessage({state:"review_required",source_kind:"elder",media_id:null})',context);assert.match(message,/原话.*保存在本机/);assert.doesNotMatch(message,/语音已转|原话和录音/);
});
test('concurrent shared stop or conversation revision wins during controlled text and correction commit',async()=>{
 for(const action of ['add','edit'])for(const changed of ['global','conversation']){
  const h=await harness(),{c}=await completed(h);let base=c;if(action==='edit'){const added=await add(h,c,'synthetic-concurrent-edit-setup');assert.equal(added.r.status,201);base=added.j.conversation}const before=await h.api.vault.get('conversation:'+c.conversation_id),original=h.driver.mutateDocs.bind(h.driver);let injected=false,winner;
  h.driver.mutateDocs=async(puts,deletes,...guards)=>{
   if(!injected&&puts.some(p=>p.key==='trial-control:voice')&&puts.some(p=>p.key==='conversation:'+c.conversation_id)){
    injected=true;winner=changed==='global'?{review_required:true,state:'stopped',conversation_id:'synthetic-concurrent-owner',turn_id:'synthetic-concurrent-turn',turn_version:1,media_id:null}:{...before,version:before.version+1,status:'finished'};
    await h.api.vault.put(changed==='global'?'trial-control:voice':'conversation:'+c.conversation_id,winner);
   }
   return original(puts,deletes,...guards);
  };
  const result=action==='add'?await add(h,c,'synthetic-concurrent-'+changed):await edit(h,base,base.turns.filter(t=>t.role==='elder').at(-1),'咳嗽三天。');
  assert.equal(injected,true);assert.equal(result.r.status,409);assert.equal(result.j.error,'trial_source_changed');
  assert.deepEqual(await h.api.vault.get(changed==='global'?'trial-control:voice':'conversation:'+c.conversation_id),winner);
  const records=await h.api.vault.list('event:');assert.equal(records.length,2);
  if(action==='add'){assert.equal(result.j.raw_text_preserved_on_device,true);assert.equal(records.find(e=>e.record_id===result.j.source_record_id)?.raw_text,secondText);}
  const current=await h.api.vault.get('conversation:'+c.conversation_id);assert.equal(current.turns.filter(t=>t.role==='elder').length,action==='add'?1:2);assert.equal(current.turns.find(t=>t.role==='elder').text,firstText);
  assert.equal((await h.request('/api/events/'+c.turns.find(t=>t.role==='elder').record_id)).j.event.raw_text,firstText);assert.equal(cloudCount(h),1);
 }
});
test('manual delayed reply cannot replace a shared stop written by another unlocked realm',async()=>{
 for(const ownerChanged of [false,true]){
  const h=await harness(),{c}=await completed(h),pending=(await add(h,c)).j.conversation;let release;
  h.responses.set('/api/ai/conversation-turn',new Promise(resolve=>{release=resolve;}));
  const request=h.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(pending));
  for(let i=0;i<100&&cloudCount(h)<2;i++)await new Promise(r=>setTimeout(r,2));assert.equal(cloudCount(h),2);
  const sibling=await harness(h),continuing=await sibling.api.trialVoiceState();assert.equal(continuing.state,'continuing');
  const stop={...continuing,state:'stopped',...(ownerChanged?{conversation_id:'synthetic-other-owner',turn_id:'synthetic-other-turn',turn_version:1}: {})};
  await sibling.api.vault.put('trial-control:voice',stop);release({action:'reply',assistant_text:'这段原话仍保留，尚未明确的内容请继续核对。',provider:'SyntheticMechanicalFixture'});
  const result=await request;assert.equal(result.r.status,409);assert.equal(result.j.error,'trial_source_changed');assert.deepEqual(await sibling.api.trialVoiceState(),stop);
  const latest=await sibling.get(c);assert.equal(latest.trial_control.state,'continuing');assert.equal(latest.turns.filter(t=>t.role==='elder').at(-1).text,secondText);
  await sibling.request('/api/conversations/'+c.conversation_id+'/resume-assistant',{});assert.equal((await sibling.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(latest))).r.status,409);assert.equal(cloudCount(h),2);
 }
});
