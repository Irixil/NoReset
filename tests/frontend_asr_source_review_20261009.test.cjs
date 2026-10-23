// Synthetic HTTP responses + encrypted MemoryDocumentStore / VM UI only.
// No microphone, real provider, ASR accuracy or clinical validation evidence.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js'), safety = require('../frontend/safety.js');
const appSource = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
const currentLocalDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const previousLocalDate=()=>{const d=new Date();d.setDate(d.getDate()-1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
async function localHarness() {
  const elements = new Map(), calls = [], responses = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { value:'', focus(){}, classList:{add(){},remove(){},toggle(){}} }); return elements.get(id); };
  const context = vm.createContext({ HealthLocalCore:{...core, IndexedDbDocumentStore:core.MemoryDocumentStore}, HealthSafety:safety,
    indexedDB:{}, crypto:webcrypto, FormData, Blob, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, navigator:{storage:{}},
    document:{getElementById:el,querySelector:()=>null}, fetch:async(path,options)=>{
      const body = options?.body; calls.push({path, body:typeof body==='string'?JSON.parse(body):body});
      const value = path==='/api/app/session'?{authenticated:true,csrf_token:'synthetic-only'}:
        responses.has(path)?await responses.get(path)(body):{provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:'我已保留您说的原话。'};
      return {ok:true,status:200,json:async()=>value};
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'),'utf8'),context);
  const api=context.HealthLocal; await api.vault.setup('synthetic-audio-source-pass'); const ready=api.initialise(); await new Promise(setImmediate);
  el('vaultPassphrase').value='synthetic-audio-source-pass'; await el('vaultForm').onsubmit({preventDefault(){}}); await ready;
  const request=(path,body)=>api.request(path,body===undefined?{}:{method:'POST',headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify(body)});
  const start=async()=>(await request('/api/conversations/start',{mode:'new',local_date:currentLocalDate()})).j.conversation;
  const audio=async c=>{const m={media_id:'media_'+webcrypto.randomUUID().replaceAll('-',''),kind:'audio',content_type:'audio/wav',original_filename:'synthetic.wav',temporary:true,conversation_id:c.conversation_id,save_status:'saved',recognition_status:'not_started',link_status:'not_linked',version:1};await api.vault.put('media:'+m.media_id,m);await api.vault.putBinary('media-binary:'+m.media_id,new Uint8Array([1,2,3,4]).buffer);return m};
  const recognize=async m=>{await request('/api/media/'+m.media_id+'/recognize',{});for(let i=0;i<100;i++){const saved=(await request('/api/media/'+m.media_id)).j.media;if(saved.recognition_status!=='processing'&&(saved.recognition_status!=='succeeded'||saved.event_link?.record_id))return saved;await new Promise(r=>setTimeout(r,3))}throw Error('synthetic recognition did not settle')};
  const get=async c=>(await request('/api/conversations/'+c.conversation_id)).j.conversation;
  return {api,request,start,audio,recognize,get,calls,responses};
}
function appHarness(h,conversation) {
  const elements=new Map(), requests=[], originals=[], payloads=[],syncs=[],composerStates=[];let activeView='voiceView';
  const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',insertAdjacentHTML(position,html){assert.equal(position,'beforeend');this.innerHTML+=html},textContent:'',disabled:false,isConnected:true,scrollHeight:0,classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},scrollTo(){}});return elements.get(id)};
  const context=vm.createContext({activeConversation:conversation,conversationEditingTurnId:null,pendingAudioReview:null,pendingAudioReviewCandidates:[],pendingAudioRecoveryRequestId:0,pendingConversationTurn:null,pendingFollowupTarget:null,saveBusy:false,
    localMode:true,healthSubjectUiEpoch:0,healthSubjectsVersion:1,activeHealthSubjectId:'subject_self',healthSubjectSwitchBusy:false,healthSubjectChanged:false,healthSubjectLoaded:true,conversationLoading:false,conversationLoadSequence:0,
    HealthLocal:h.api,HealthSafety:safety,crypto:webcrypto,window:{requestAnimationFrame:fn=>fn(),matchMedia:()=>({matches:true})},
    $:el,document:{querySelector:()=>({id:activeView,classList:{add(){}}})},api:async(path,options)=>{requests.push(path);payloads.push({path,options});return h.api.request(path,options)},
    syncConversation:c=>{syncs.push(c);context.activeConversation=c},setVoiceStatus:(m)=>{el('status').textContent=m},setVoiceComposerEnabled:enabled=>composerStates.push(enabled),renderVoiceConversation(){},loadEvents:async()=>{},renderConversationReport(){},
    ensureHealthSubjectReady:async()=>true,localDateValue:currentLocalDate,conversationHasPendingReply:()=>false,trialVoiceMessage:()=>'',reducedMotion:()=>true,
    bindConversationSourceActions(){},releaseOriginalsIn(){},showView(){},toast(){},prepareMediaRetry(){},startSeparateConversation:async()=>true,
    escapeHtml:text=>String(text??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    isMockContent:t=>t?.is_mock===true,mockWarning:'模拟内容',mockText:()=>false,mediaUnavailableMessage:'不可用',
    openOriginal:async(id,options)=>{originals.push({id,options});options.box.innerHTML='<audio controls src="blob:synthetic"></audio>';return true},
    conversationTurnTime:()=>'',console,
  });
  for(const [start,end] of [['function canShowSavedTextFirstSend(','function voiceTurnHtml('],['function audioDurationLabel(','function naturalCorrectionTargets('],['function voiceTurnHtml(','function renderVoiceConversation('],['function legacyAudioNeedsExplicitRecovery(','function literalRecordTitle('],['function audioReviewAlreadyInConversation(','function voiceRecordingIntentIsCurrent('],['function voiceRecordingIntentIsCurrent(','async function showVoiceMediaResult('],['async function showVoiceMediaResult(','function prepareMediaRetry('],['async function playPendingAudioOriginal(','function bindConversationSourceActions('],['async function submitConversationText(','async function saveVoiceSupplement('],['async function startConversation(','async function startSeparateConversation('],['async function loadConversation(','async function pauseConversation('],['function renderVoiceConversation(','function turnById('],['function conversationTranscriptTurnHtml(','function conversationSafety(']])
    vm.runInContext(appSource.slice(appSource.indexOf(start),appSource.indexOf(end)),context);
  if(appSource.includes('async function showConversationOriginal(')) vm.runInContext(appSource.slice(appSource.indexOf('async function showConversationOriginal('),appSource.indexOf('function bindConversationSourceActions(')),context);
  return {context,requests,originals,payloads,syncs,composerStates,el,setActiveView:id=>{activeView=id},run:code=>vm.runInContext(code,context)};
}
async function audioRestoreFixture(count=1){
  const h=await localHarness(),conversation=await h.start();h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const media=[];for(let i=0;i<count;i++)media.push(await h.recognize(await h.audio(conversation)));
  return {h,conversation,media,app:appHarness(h,await h.get(conversation))};
}
function holdTrialState(app){
  let release,enteredResolve,first=true;const entered=new Promise(resolve=>{enteredResolve=resolve});
  app.context.HealthLocal.trialVoiceState=()=>first?(first=false,new Promise(resolve=>{release=resolve;enteredResolve()})):Promise.resolve({state:'completed'});
  return {entered,release:state=>release(state)};
}
const text='合成测试：膝盖痛两天，晚上明显。';
const cloudCount=(h,path)=>h.calls.filter(call=>call.path===path).length;
test('a newly recorded successful ASR enters the active conversation once without claiming user review',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),current=await h.get(c),app=appHarness(h,current),intent={conversationId:current.conversation_id,conversationVersion:current.version,
    conversationStatus:current.status,subjectId:current.subject_id||'subject_self',subjectVersion:1,epoch:0,invalidated:false};
  app.context.voiceCaptureIntent=intent;app.context.media=recognized;
  await app.run('showVoiceMediaResult(media,{newRecording:true,captureIntent:voiceCaptureIntent})');
  const saved=await h.get(c),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event;
  const elder=saved.turns.find(t=>t.role==='elder'&&!t.superseded);
  assert.equal(app.context.pendingAudioReview,null);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
  assert.equal(saved.status,'active');assert.equal(elder.text,text);assert.equal(elder.audio_source_status,'machine_transcribed');assert.equal(elder.audio_source_reviewed,false);
  assert.equal(event.raw_text,text);assert.equal(safety.audioNeedsReview(event),true);assert.equal(recognized.link_pending_reason,'audio_source_review_required');
  assert.equal(cloudCount(h,'/api/ai/media/recognize'),1);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);
  const before=cloudCount(h,'/api/ai/conversation-turn');await app.run('loadConversation()');assert.equal(cloudCount(h,'/api/ai/conversation-turn'),before,'reopening does not send the saved audio again');
});
test('a new recording started from the exact paused conversation can continue it without opening a new session',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),paused=(await h.request('/api/conversations/'+c.conversation_id+'/pause',{})).j.conversation;
  const app=appHarness(h,paused),intent={conversationId:paused.conversation_id,conversationVersion:paused.version,conversationStatus:'paused',subjectId:paused.subject_id||'subject_self',subjectVersion:1,epoch:0,invalidated:false};
  app.context.voiceCaptureIntent=intent;app.context.media=recognized;
  await app.run('showVoiceMediaResult(media,{newRecording:true,captureIntent:voiceCaptureIntent})');
  const saved=await h.get(c),elder=saved.turns.find(turn=>turn.role==='elder'&&!turn.superseded);
  assert.equal(saved.status,'active');assert.equal(elder?.text,text);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);
  assert.equal(h.calls.some(call=>call.path==='/api/conversations/start'),false,'resuming the same conversation must not create a new session');
});
test('a late ASR result from an invalidated recording intent never auto-sends',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),conversation=await h.get(c),app=appHarness(h,conversation);
  const intent={conversationId:conversation.conversation_id,conversationVersion:conversation.version,conversationStatus:'active',subjectId:conversation.subject_id||'subject_self',subjectVersion:1,epoch:0,invalidated:true};
  app.context.voiceCaptureIntent=intent;app.context.media=recognized;
  await app.run('showVoiceMediaResult(media,{newRecording:true,captureIntent:voiceCaptureIntent})');
  const saved=await h.get(c);
  assert.equal(saved.turns.filter(turn=>turn.role==='elder'&&!turn.superseded).length,0);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  assert.ok(await h.api.vault.get('media-binary:'+m.media_id),'the original recording remains saved');
});
test('a successful result discovered on reopen stays explicit and does not auto-send',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),app=appHarness(h,await h.get(c));app.context.media=recognized;
  await app.run('showVoiceMediaResult(media)');
  const saved=await h.get(c);
  assert.equal(app.context.pendingAudioReview,null);assert.equal(app.context.pendingAudioReviewCandidates.length,1);
  assert.match(app.el('voiceConversationTurns').innerHTML,/继续聊这段/);assert.equal(saved.turns.filter(t=>t.role==='elder').length,0);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
});
test('cold same-day resume lists every current unturned audio and keeps source-review actions explicit',async()=>{
  const h=await localHarness(),c=await h.start(),first=await h.audio(c),second=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const one=await h.recognize(first),two=await h.recognize(second),oldConversation=await h.api.vault.get('conversation:'+c.conversation_id);
  await h.api.vault.put('conversation:'+c.conversation_id,{...oldConversation,turns:[...oldConversation.turns,{turn_id:'turn_superseded_audio_fixture',role:'elder',source_kind:'audio_transcript',media_id:first.media_id,record_id:'rec_superseded_fixture',text:'旧版识别文字',audio_source_reviewed:true,audio_source_version:1,audio_source_media_version:1,superseded:true}]});
  await h.api.vault.remove('media-binary:'+first.media_id);
  const app=appHarness(h,null),recognizeBefore=cloudCount(h,'/api/ai/media/recognize'),modelBefore=cloudCount(h,'/api/ai/conversation-turn');
  await app.run('loadConversation()');
  assert.equal(app.context.pendingAudioReview,null);assert.equal(app.context.pendingAudioReviewCandidates.length,2);
  const html=app.el('voiceConversationTurns').innerHTML;assert.match(html,/voice-audio-bubble/);assert.match(html,/voice-transcript-bubble/);assert.doesNotMatch(html,/机器转写 · 尚未人工核对|尚未对照原音/);assert.match(html,/继续聊这段/);assert.doesNotMatch(html,/audioTranscriptReviewText|audio-review-confirm|核对这段录音|另记新的情况/);
  assert.equal(app.requests.some(path=>/\/recognize$|\/source-review$|\/turns$|\/resume-assistant$/.test(path)),false);
  assert.equal(cloudCount(h,'/api/ai/media/recognize'),recognizeBefore);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore);
  assert.ok(await h.api.vault.get('media-binary:'+two.media_id));
  assert.equal(app.context.pendingAudioReview,null);assert.equal(app.context.pendingAudioReviewCandidates.length,2);
  assert.ok(app.composerStates.at(-1), 'normal typing remains available');
  assert.equal(safety.audioNeedsReview((await h.request('/api/events/'+one.event_link.record_id)).j.event),true);
  assert.equal((await h.get(c)).turns.filter(turn=>turn.role==='elder'&&!turn.superseded).length,0);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore);
  assert.equal(two.recognition_status,'succeeded');
});
test('a recovered old pending recording is shown as audio plus text and is sent only after its explicit continue action',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  await h.recognize(m);const app=appHarness(h,null),modelBefore=cloudCount(h,'/api/ai/conversation-turn');
  await app.run('loadConversation()');
  assert.match(app.el('voiceConversationTurns').innerHTML,/voice-audio-bubble/);
  assert.match(app.el('voiceConversationTurns').innerHTML,/voice-transcript-bubble/);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore,'reopen only renders; it does not submit the old recording');
  assert.equal(await app.run(`continueRecoveredAudioCandidate(${JSON.stringify(m.media_id)})`),true);
  assert.equal(app.context.pendingAudioReviewCandidates.length,0);
  assert.doesNotMatch(app.el('voiceConversationTurns').innerHTML,/data-audio-recovery=/,'successful recovery removes the stale recovery bubble immediately');
  assert.equal((app.el('voiceConversationTurns').innerHTML.match(/合成测试：膝盖痛两天，晚上明显。/g)||[]).length,1,'the transcript appears once as a conversation turn');
  const saved=await h.get(c),turn=saved.turns.find(item=>item.role==='elder'&&!item.superseded);
  assert.equal(turn.text,text);assert.equal(turn.audio_source_status,'machine_transcribed');assert.equal(turn.audio_source_reviewed,false);
  assert.equal(safety.audioNeedsReview((await h.request('/api/events/'+turn.record_id)).j.event),true);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore+1);
  assert.equal(await app.context.continueRecoveredAudioCandidate(m.media_id),false,'a removed recovery action cannot send the same audio twice');
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore+1);
  await app.run('loadConversation()');assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore+1,'reopening after the explicit send never repeats it');
});
test('same-day paused audio recovery stays local on refresh and resumes only from its explicit action',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event;
  assert.equal((await h.request('/api/conversations/'+c.conversation_id+'/pause',{})).r.ok,true);
  const app=appHarness(h,null),modelBefore=cloudCount(h,'/api/ai/conversation-turn');app.context.localDateValue=currentLocalDate;
  await app.run('loadConversation()');
  assert.equal(app.context.activeConversation.status,'paused');assert.equal(app.context.pendingAudioReviewCandidates.length,1);
  assert.match(app.el('voiceConversationTurns').innerHTML,/继续聊这段/);
  assert.equal(app.requests.some(path=>path.endsWith('/turns')||path==='/api/conversations/start'),false,'same-day refresh reads the exact paused conversation and does not resume or submit it');
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore);
  const media=(await h.request('/api/media/'+m.media_id)).j.media;
  assert.equal(await app.context.submitConversationText(event.raw_text,{source_kind:'audio_transcript',audio_source_status:'machine_transcribed',
    record_id:event.record_id,media_id:m.media_id,source_version:event.version,media_version:media.version}),false,'the ordinary automatic-transcript path remains blocked while paused');
  assert.equal(app.context.pendingAudioReviewCandidates.length,1);
  assert.equal(await app.context.continueRecoveredAudioCandidate(m.media_id),true,'the explicit candidate action resumes this exact session');
  assert.equal(app.requests.some(path=>path==='/api/conversations/start'),false,'resume does not choose another latest conversation');
  assert.equal(app.context.activeConversation.status,'active');assert.equal(app.context.pendingAudioReviewCandidates.length,0);
  assert.equal((await h.get(c)).turns.filter(turn=>turn.role==='elder'&&!turn.superseded).length,1);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore+1,'only the explicit user action requests a reply');
});
test('paused audio recovery refuses stale conversation, media and source versions',async()=>{
  for(const staleKind of ['conversation','media','event']){
    const {h,conversation,media:[item],app}=await audioRestoreFixture();
    assert.equal((await h.request('/api/conversations/'+conversation.conversation_id+'/pause',{})).r.ok,true);
    await app.run('loadConversation()');assert.equal(app.context.activeConversation.status,'paused');
    if(staleKind==='conversation'){
      const saved=await h.api.vault.get('conversation:'+conversation.conversation_id);
      await h.api.vault.put('conversation:'+conversation.conversation_id,{...saved,version:saved.version+1});
    }else if(staleKind==='media'){
      await h.api.vault.put('media:'+item.media_id,{...item,version:item.version+1});
    }else{
      const event=(await h.request('/api/events/'+item.event_link.record_id)).j.event;
      await h.api.vault.put('event:'+event.record_id,{...event,version:event.version+1});
    }
    assert.equal(await app.context.continueRecoveredAudioCandidate(item.media_id),false,`${staleKind} version drift must fail closed`);
    assert.equal(app.context.pendingAudioReviewCandidates.length,1);
    assert.match(app.el('voiceConversationTurns').innerHTML,/继续聊这段/);
    assert.equal(app.requests.some(path=>path.endsWith('/turns')||path==='/api/conversations/start'),false);
    assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  }
});
test('paused audio recovery stops before submission if the active conversation or person changes',async()=>{
  for(const changed of ['conversation','subject']){
    const {h,conversation,media:[item],app}=await audioRestoreFixture();
    assert.equal((await h.request('/api/conversations/'+conversation.conversation_id+'/pause',{})).r.ok,true);
    await app.run('loadConversation()');
    const gate=holdTrialState(app),resuming=app.context.continueRecoveredAudioCandidate(item.media_id);await gate.entered;
    if(changed==='conversation')app.context.activeConversation={conversation_id:'conversation_other',subject_id:'subject_self',version:1,turns:[]};
    else {app.context.activeHealthSubjectId='subject_fictional_family';app.context.healthSubjectsVersion++}
    app.context.healthSubjectUiEpoch++;gate.release({state:'completed'});
    assert.equal(await resuming,false);
    assert.equal(app.context.pendingAudioReviewCandidates.length,1);
    assert.equal(app.requests.some(path=>path.endsWith('/turns')||path==='/api/conversations/start'),false);
    assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  }
});
test('a failed recovered-audio submission keeps its recovery bubble available',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  await h.recognize(m);const app=appHarness(h,null);await app.run('loadConversation()');
  const request=app.context.api;
  let failedSubmissions=0;
  app.context.api=async(path,options)=>{
    if(path.endsWith('/turns')&&options?.method==='POST'){failedSubmissions++;return {r:{ok:false,status:503},j:{error:'synthetic_unavailable'}}}
    return request(path,options);
  };
  assert.equal(await app.context.continueRecoveredAudioCandidate(m.media_id),false);
  assert.equal(failedSubmissions,1);
  assert.equal(app.context.pendingAudioReviewCandidates.length,1);
  assert.match(app.el('voiceConversationTurns').innerHTML,new RegExp(`data-audio-recovery="${m.media_id}"`));
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0,'a rejected local submission does not call the reply provider');
  assert.equal((await h.get(c)).turns.filter(item=>item.role==='elder'&&!item.superseded).length,0);
});
test('a recovered-audio completion does not redraw a newly selected conversation or subject',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  await h.recognize(m);const app=appHarness(h,null);await app.run('loadConversation()');
  app.context.submitConversationText=async()=>{
    app.context.activeConversation={conversation_id:'conversation_other',subject_id:'subject_fictional_family',version:1,turns:[]};
    app.context.healthSubjectUiEpoch++;app.context.activeHealthSubjectId='subject_fictional_family';app.el('voiceConversationTurns').innerHTML='new subject view';return true;
  };
  assert.equal(await app.context.continueRecoveredAudioCandidate(m.media_id),true);
  assert.equal(app.el('voiceConversationTurns').innerHTML,'new subject view');
  assert.equal(app.context.pendingAudioReviewCandidates.length,1);
});
test('cold resume recovers a reviewed source without resending until the explicit continue action',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event;
  const reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event;
  assert.equal(safety.audioNeedsReview(reviewed),false);assert.equal((await h.get(c)).turns.filter(turn=>turn.role==='elder').length,0);
  const app=appHarness(h,null),modelBefore=cloudCount(h,'/api/ai/conversation-turn');app.context.localDateValue=previousLocalDate;await app.run('loadConversation()');
  assert.equal(app.context.activeConversation,null);await app.run('startConversation("continue")');
  assert.equal(app.context.pendingAudioReview,null);assert.equal(app.context.pendingAudioReviewCandidates.length,1);
  assert.equal(app.context.pendingAudioReviewCandidates[0].recovery_source_reviewed,true);
  assert.doesNotMatch(app.el('voiceConversationTurns').innerHTML,/已对照原音核对文字/);assert.match(app.el('voiceConversationTurns').innerHTML,/继续聊这段/);
  assert.equal(app.requests.some(path=>/\/source-review$|\/turns$|\/resume-assistant$/.test(path)),false);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore);
  assert.equal(app.context.pendingAudioReview,null);
  assert.equal(await app.context.continueRecoveredAudioCandidate(m.media_id),true);
  const saved=await h.get(c),turn=saved.turns.find(item=>item.role==='elder');
  assert.equal(turn.record_id,reviewed.record_id);assert.equal(turn.media_id,m.media_id);assert.equal(turn.text,reviewed.raw_text);assert.equal(turn.audio_source_reviewed,true);
  assert.equal(app.requests.filter(path=>/\/source-review$/.test(path)).length,0);assert.equal(app.requests.filter(path=>/\/turns$/.test(path)).length,1);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore+1);assert.equal(app.context.pendingAudioReviewCandidates.length,0);
  await app.run('loadConversation()');assert.equal(app.context.pendingAudioReviewCandidates.length,0);
  assert.equal((await h.get(c)).turns.filter(item=>item.role==='elder'&&!item.superseded).length,1);
});
test('late audio restore is discarded after the active health subject changes',async()=>{
  const {h,media:[item],app}=await audioRestoreFixture(),gate=holdTrialState(app),asrBefore=cloudCount(h,'/api/ai/media/recognize'),modelBefore=cloudCount(h,'/api/ai/conversation-turn');
  app.context.media=item;const restoring=app.run('presentAudioReview(media,{restore:true})');await gate.entered;
  app.context.healthSubjectUiEpoch++;app.context.pendingAudioRecoveryRequestId++;app.context.healthSubjectSwitchBusy=true;
  app.context.activeHealthSubjectId='subject_fictional_family';app.context.healthSubjectsVersion++;app.context.activeConversation=null;
  gate.release({state:'completed'});
  assert.equal(await restoring,false);assert.equal(app.context.pendingAudioReview,null);assert.deepEqual(app.syncs,[]);
  assert.ok(await h.api.vault.get('media-binary:'+item.media_id));
  assert.equal(cloudCount(h,'/api/ai/media/recognize'),asrBefore);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),modelBefore);
  assert.equal(app.requests.some(path=>/\/source-review$|\/turns$/.test(path)),false);
});
test('audio restore reports a stale conversation instead of syncing an older fetched version',async()=>{
  const {h,media:[item],app}=await audioRestoreFixture(),gate=holdTrialState(app);
  app.context.pendingAudioReviewCandidates=[item];app.context.media=item;const restoring=app.run('restoreAudioReviewCandidate(media.media_id)');await gate.entered;
  app.context.activeConversation={...app.context.activeConversation,version:app.context.activeConversation.version+1};
  gate.release({state:'completed'});
  assert.equal(await restoring,false);assert.equal(app.context.pendingAudioReview,null);assert.deepEqual(app.syncs,[]);
  assert.match(app.el('status').textContent,/对话.*变化|重新读取/);
  assert.ok(await h.api.vault.get('media-binary:'+item.media_id));
});
test('audio restore reports when the fetched conversation version is newer than the active snapshot',async()=>{
  const {h,conversation,media:[item],app}=await audioRestoreFixture(),gate=holdTrialState(app);
  const saved=await h.api.vault.get('conversation:'+conversation.conversation_id);
  await h.api.vault.put('conversation:'+conversation.conversation_id,{...saved,version:saved.version+1});
  app.context.media=item;const restoring=app.run('presentAudioReview(media,{restore:true})');await gate.entered;
  gate.release({state:'completed'});
  assert.equal(await restoring,false);assert.equal(app.context.pendingAudioReview,null);assert.deepEqual(app.syncs,[]);
  assert.match(app.el('status').textContent,/对话已有新变化|已过期/);
  assert.ok(await h.api.vault.get('media-binary:'+item.media_id));
});
test('audio restore refreshes after the same subject registry version changes',async()=>{
  const {h,media:[item],app}=await audioRestoreFixture(),gate=holdTrialState(app);
  app.context.pendingAudioReviewCandidates=[item];app.context.media=item;const restoring=app.run('restoreAudioReviewCandidate(media.media_id)');await gate.entered;
  app.context.healthSubjectsVersion++;
  gate.release({state:'completed'});
  assert.equal(await restoring,false);assert.equal(app.context.pendingAudioReview,null);assert.deepEqual(app.syncs,[]);
  assert.equal(app.context.pendingAudioReviewCandidates.length,1);assert.match(app.el('status').textContent,/状态已有变化|重新读取/);
  assert.ok(await h.api.vault.get('media-binary:'+item.media_id));
});
test('overlapping audio restores keep the newer request when its response arrives first',async()=>{
  const {h,media,app}=await audioRestoreFixture(2),gates=[],gateWaiters=[];
  app.context.HealthLocal.trialVoiceState=()=>new Promise(resolve=>{
    gates.push(resolve);
    for(let i=gateWaiters.length-1;i>=0;i--)if(gateWaiters[i].count<=gates.length)gateWaiters.splice(i,1)[0].resolve();
  });
  const waitForGateCount=count=>gates.length>=count?Promise.resolve():new Promise(resolve=>gateWaiters.push({count,resolve}));
  app.context.media=media[0];const older=app.run('presentAudioReview(media,{restore:true})');
  await waitForGateCount(1);assert.equal(gates.length,1);
  app.context.media=media[1];const newer=app.run('presentAudioReview(media,{restore:true})');
  await waitForGateCount(2);assert.equal(gates.length,2);
  gates[1]({state:'completed'});assert.equal(await newer,true);
  gates[0]({state:'completed'});assert.equal(await older,false);
  assert.equal(app.context.pendingAudioReview.media_id,media[1].media_id);
  assert.ok(await h.api.vault.get('media-binary:'+media[0].media_id));assert.ok(await h.api.vault.get('media-binary:'+media[1].media_id));
  assert.equal(app.requests.some(path=>/\/source-review$|\/turns$/.test(path)),false);
});
test('choosing text continuation cancels a different audio restore already waiting',async()=>{
  const {h,media,conversation,app}=await audioRestoreFixture(2),gate=holdTrialState(app);
  app.context.pendingAudioReview={conversation_id:conversation.conversation_id,media_id:media[0].media_id,trialControlled:false};
  app.context.pendingAudioReviewCandidates=[media[1]];app.context.media=media[1];
  const restoring=app.run('presentAudioReview(media,{restore:true})');await gate.entered;
  assert.equal(app.run('continueWithTextInsteadOfAudio()'),true);gate.release({state:'completed'});
  assert.equal(await restoring,false);assert.equal(app.context.pendingAudioReview,null);
  assert.equal(app.composerStates.at(-1),true);assert.equal(app.composerStates.includes(false),false);
  assert.ok(await h.api.vault.get('media-binary:'+media[0].media_id));assert.ok(await h.api.vault.get('media-binary:'+media[1].media_id));
  assert.equal(app.requests.some(path=>/\/source-review$|\/turns$/.test(path)),false);
});
test('starting a new conversation cancels audio restore before the start request returns',async()=>{
  const {h,media,conversation,app}=await audioRestoreFixture(2),gate=holdTrialState(app),originalApi=app.context.api;
  app.context.pendingAudioReview={conversation_id:conversation.conversation_id,media_id:media[0].media_id,trialControlled:false};
  app.context.media=media[1];const restoring=app.run('presentAudioReview(media,{restore:true})');await gate.entered;
  let releaseStart,enteredStartResolve;const enteredStart=new Promise(resolve=>{enteredStartResolve=resolve});
  app.context.api=(path,options)=>path==='/api/conversations/start'?new Promise(resolve=>{releaseStart=resolve;enteredStartResolve()}):originalApi(path,options);
  const starting=app.run('startConversation("new")');await enteredStart;
  gate.release({state:'completed'});assert.equal(await restoring,false);assert.equal(app.context.pendingAudioReview.media_id,media[0].media_id);
  releaseStart(await originalApi('/api/conversations/start',{method:'POST',body:JSON.stringify({mode:'new',local_date:'2026-10-09'})}));
  assert.equal(await starting,true);assert.equal(app.context.pendingAudioReview,null);assert.notEqual(app.context.activeConversation.conversation_id,conversation.conversation_id);
});
test('leaving the voice view discards a late audio restore instead of updating its hidden panel',async()=>{
  const {h,media:[item],app}=await audioRestoreFixture(),gate=holdTrialState(app);
  app.context.pendingAudioReviewCandidates=[item];app.context.media=item;const restoring=app.run('restoreAudioReviewCandidate(media.media_id)');await gate.entered;
  app.setActiveView('recordsView');gate.release({state:'completed'});
  assert.equal(await restoring,false);assert.equal(app.context.pendingAudioReview,null);assert.deepEqual(app.syncs,[]);
  assert.ok(await h.api.vault.get('media-binary:'+item.media_id));assert.equal(app.originals.length,0);
});
test('the explicit played-and-confirmed voice panel sends only the current reviewed source versions',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  h.responses.set('/api/ai/conversation-turn',()=>({provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:'仅供本地流程测试的回复。'}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event,app=appHarness(h,await h.get(c));
  const review={conversation_id:c.conversation_id,record_id:event.record_id,media_id:m.media_id,text,draftText:text,played:true,confirmed:true,busy:false};
  app.context.pendingAudioReview=review;
  const box=app.el('voiceConversationTurns'),submitButton={disabled:false};
  box.querySelector=selector=>selector==='#audioTranscriptReviewText'?{value:text}:selector==='[data-audio-review-confirm]'?submitButton:null;
  assert.equal(await app.context.confirmPendingAudioReview(),true);
  const saved=await h.get(c),turn=saved.turns.find(item=>item.role==='elder');
  assert.equal(turn.text,text);assert.equal(turn.audio_source_reviewed,true);assert.equal(turn.audio_source_version,(await h.request('/api/events/'+event.record_id)).j.event.version);
  const sent=app.payloads.find(item=>item.path.endsWith('/turns')),body=JSON.parse(sent.options.body);
  assert.equal(turn.audio_source_media_version,body.media_version);assert.equal(turn.audio_source_conversation_version,body.expected_version);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);assert.equal(app.context.pendingAudioReview,null);
  assert.equal((await h.request('/api/conversations/'+c.conversation_id+'/pause',{})).r.ok,true);
  assert.ok(await h.api.vault.get('media-binary:'+m.media_id),'pause must preserve an original still referenced by a chat turn');
  assert.ok((await h.request('/api/media/'+m.media_id)).j.media,'pause must preserve its media metadata');
  assert.equal((await h.request('/api/conversations/'+c.conversation_id+'/finish',{})).r.ok,true);
  assert.ok(await h.api.vault.get('media-binary:'+m.media_id),'finish must preserve the same referenced original');
  const reopened=await h.get(c),reopenedApp=appHarness(h,reopened),reopenedBox=reopenedApp.el('original');
  const reopenedTurn=reopened.turns.find(item=>item.role==='elder');
  reopenedApp.context.turn=reopenedTurn;reopenedApp.context.box=reopenedBox;reopenedApp.context.conversation=reopened;
  assert.equal(await reopenedApp.run('showConversationOriginal(turn,box,conversation)'),true);
  assert.match(reopenedBox.innerHTML,/<audio/,'the reviewed original remains playable after reopen');
});
test('post-link temporary cleanup cannot delete the original after its new chat turn commits',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  h.responses.set('/api/ai/conversation-turn',()=>({provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:'本地流程测试回复。'}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event;
  const reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event;
  const media=(await h.request('/api/media/'+m.media_id)).j.media,latest=await h.get(c);
  const linked=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text:event.raw_text,source_kind:'audio_transcript',record_id:event.record_id,
    media_id:m.media_id,source_version:reviewed.version,media_version:media.version,expected_version:latest.version},
    {'Idempotency-Key':'synthetic-reviewed-audio-with-default-cleanup'});
  assert.equal(linked.r.ok,true,linked.j.error||'reviewed audio turn was refused');
  assert.ok(await h.api.vault.get('media-binary:'+m.media_id),'post-link cleanup must preserve the newly referenced original');
  assert.ok((await h.request('/api/media/'+m.media_id)).j.media);
});
test('showing audio as a nontemporary result still cannot bypass the source-review gate',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),app=appHarness(h,await h.get(c));
  app.context.media={...recognized,temporary:false};
  await app.run('showVoiceMediaResult(media)');const saved=await h.get(c);
  assert.equal(app.requests.some(path=>path.endsWith('/pause')),false);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
  assert.equal(saved.turns.filter(t=>t.role==='elder').length,0);assert.equal(cloudCount(h,'/api/ai/media/recognize'),1);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
});
test('chat and archive audio bubbles omit routine status captions while source review keeps provenance',()=>{
  const h={api:{}},turn={turn_id:'turn_synthetic',role:'elder',text:'<识别文字>',source_kind:'audio_transcript',audio_source_status:'machine_transcribed',audio_source_reviewed:false,media_id:'media_synthetic',record_id:'rec_synthetic',version:1};
  const app=appHarness(h,{turns:[turn]});app.context.turn=turn;
  const voice=app.run('voiceTurnHtml(turn)'),archive=app.run('conversationTranscriptTurnHtml(turn)');
  assert.doesNotMatch(voice,/语音识别文字.*尚未人工核对|尚未对照原音/);
  assert.doesNotMatch(archive,/语音识别文字.*尚未人工核对|历史录音文字.*状态待确认/);
  for(const html of [voice,archive]){assert.match(html,/data-turn-original/);assert.match(html,/&lt;识别文字&gt;/)}
  assert.match(archive,/voice-audio-bubble/);assert.match(voice,/voice-audio-bubble/);assert.doesNotMatch(voice,/data-voice-turn-edit/);
  assert.ok(voice.indexOf('voice-audio-duration')<voice.indexOf('voice-audio-sound-icon'),'duration sits to the left of the speaker icon');
  const edited=app.run('voiceTurnHtml({...turn,audio_source_status:"user_edited"})');assert.match(edited,/已修改/);assert.doesNotMatch(edited,/尚未对照原音|尚未人工核对/);
  const css=fs.readFileSync(require.resolve('../frontend/styles.css'),'utf8');assert.match(css,/\.voice-audio-bubble\s*\{[^}]*justify-content:\s*flex-end/);
  assert.match(appSource,/function audioSourceReviewHtml\(e\)[\s\S]*?核对录音文字/);
  assert.equal(turn.audio_source_status,'machine_transcribed');assert.equal(turn.audio_source_reviewed,false);
  app.context.turn={...turn,is_mock:true};assert.doesNotMatch(app.run('voiceTurnHtml(turn)'),/data-turn-original/);
});
test('original comparison reads only the selected saved audio and never recognition/model endpoints',async()=>{
  const {h,media:m,turn,conversation}=await savedAudioPlaybackCase({savedAudio:false});
  const app=appHarness(h,conversation),box=app.el('original');app.context.turn=turn;app.context.box=box;app.context.conversation=conversation;
  assert.equal(typeof app.context.showConversationOriginal,'function');await app.run('showConversationOriginal(turn,box,conversation)');
  assert.deepEqual(app.requests,['/api/media/'+m.media_id,'/api/events']);assert.equal(app.originals[0].id,m.media_id);assert.match(box.innerHTML,/<audio/);assert.equal(h.calls.length,0);
  await h.api.vault.remove('media:'+m.media_id);await app.run('showConversationOriginal(turn,box,conversation)');assert.match(box.textContent,/没有找到这段录音原件/);assert.equal(app.originals.length,1);
});
async function savedAudioPlaybackCase({savedAudio=true}={}){
  const h=await localHarness(),owner=await h.start();
  const old=(await h.request('/api/events',{raw_text:'合成旧录音文字。',source_kind:'audio_transcript'})).j.event;
  const media={media_id:'media_'+webcrypto.randomUUID().replaceAll('-',''),subject_id:'subject_self',kind:'audio',content_type:'audio/wav',
    conversation_id:owner.conversation_id,save_status:'saved',recognition_status:'succeeded',recognition:{text:old.raw_text,is_mock:false},
    event_link:{record_id:old.record_id},record_id:old.record_id,version:6};
  await h.api.vault.put('media:'+media.media_id,media);
  await h.api.vault.putBinary('media-binary:'+media.media_id,new Uint8Array([1,2,3]).buffer,{content_type:'audio/wav'});
  const revised=(await h.request('/api/events/'+old.record_id+'/revise',{raw_text:'合成更正后的录音文字。',reason:'合成核对后修订',expected_version:old.version})).j.event;
  const reviewed=(await h.request('/api/events/'+revised.record_id+'/source-review',{expected_version:revised.version,compared_with_original:true})).j.event;
  const currentMedia=(await h.request('/api/media/'+media.media_id)).j.media;
  const conversation=savedAudio?await h.start():owner;
  const turn={turn_id:'turn_saved_audio_fixture',role:'elder',source_kind:'audio_transcript',text:reviewed.raw_text,original_text:old.raw_text,
    media_id:media.media_id,record_id:reviewed.record_id,version:1,audio_source_reviewed:true,audio_source_version:reviewed.version,
    audio_source_media_version:currentMedia.version,audio_source_conversation_id:conversation.conversation_id};
  const bound={...conversation,turns:[...conversation.turns,turn],saved_audio_trial:savedAudio?{state:'completed',media_id:media.media_id,record_id:reviewed.record_id,source_version:reviewed.version}:undefined};
  await h.api.vault.put('conversation:'+conversation.conversation_id,bound);
  return {h,media:currentMedia,turn,conversation:bound};
}
test('saved-audio conversation reopens its original source through the current reviewed revision chain',async()=>{
  const {h,media,turn,conversation}=await savedAudioPlaybackCase(),app=appHarness(h,conversation),box=app.el('original');
  app.context.turn=turn;app.context.box=box;app.context.conversation=conversation;
  const before=await h.api.vault.get('media:'+media.media_id);
  await app.run('showConversationOriginal(turn,box,conversation)');
  assert.equal(app.originals.length,1,'the explicitly bound cross-conversation saved-audio turn may play its source');
  assert.equal(app.originals[0].id,media.media_id);
  assert.deepEqual(app.requests,['/api/media/'+media.media_id,'/api/events']);
  assert.deepEqual(await h.api.vault.get('media:'+media.media_id),before,'playback leaves the original media owner/link untouched');
  assert.equal(h.calls.length,0,'no ASR or model endpoint is called');
});
test('pending source-review playback passes the exact record, text and media versions to original validation',async()=>{
  const {h,conversation,media:[item],app}=await audioRestoreFixture();
  app.context.media=item;assert.equal(await app.run('presentAudioReview(media,{restore:false})'),true);
  const callsBeforePlayback=h.calls.length;
  const audio={addEventListener(){}};
  const box={isConnected:true,innerHTML:'',textContent:'',querySelector:selector=>selector==='audio'?audio:null};
  app.context.$=id=>id==='voiceConversationTurns'?{querySelector:selector=>selector==='[data-audio-review-original]'?box:null}:app.el(id);
  assert.equal(await app.run('playPendingAudioOriginal()'),true);
  assert.equal(app.originals.length,1);assert.equal(app.originals[0].id,item.media_id);
  assert.equal(app.context.pendingAudioReview.record_id,item.event_link.record_id);
  assert.equal(app.context.pendingAudioReview.mediaVersion,item.version);
  assert.equal(conversation.conversation_id,app.context.activeConversation.conversation_id);
  assert.equal(h.calls.length,callsBeforePlayback,'pending playback never calls ASR or the language model');
});
test('original playback rejects wrong owner, source and stale source/media versions',async()=>{
  for(const [label,change] of [
    ['wrong subject',({media})=>({media:{...media,subject_id:'subject_family'}})],
    ['wrong source',({turn})=>({turn:{...turn,record_id:'rec_unrelated'}})],
    ['stale event version',({turn})=>({turn:{...turn,audio_source_version:turn.audio_source_version-1}})],
    ['stale media version',({turn})=>({turn:{...turn,audio_source_media_version:turn.audio_source_media_version-1}})],
    ['wrong destination conversation',({turn})=>({turn:{...turn,audio_source_conversation_id:'conversation_other'}})],
    ['missing cross-conversation binding',({turn})=>({turn:{...turn,audio_source_reviewed:false}})],
    ['reviewed source without exact version evidence',({turn})=>({turn:{...turn,audio_source_version:undefined}})],
  ]){
    const {h,media,turn,conversation}=await savedAudioPlaybackCase();
    const changed={...conversation,...change({media,turn})};
    if(changed.media)await h.api.vault.put('media:'+media.media_id,changed.media);
    const selectedTurn=changed.turn||turn,selectedConversation={...conversation,turns:conversation.turns.map(item=>item.turn_id===turn.turn_id?selectedTurn:item)};
    const app=appHarness(h,selectedConversation),box=app.el('original');app.context.turn=selectedTurn;app.context.box=box;app.context.conversation=selectedConversation;
    await app.run('showConversationOriginal(turn,box,conversation)');
    assert.match(box.textContent,label==='wrong subject'?/无法读取|来源不一致/:/来源不一致/,label);assert.equal(app.originals.length,0,label);
    assert.equal(h.calls.length,0,label);
  }
});
test('only a version-bound source review allows the exact audio text into the conversation/model',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),pending=await h.get(c),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event;
  assert.equal(pending.turns.filter(t=>t.role==='elder').length,0);assert.equal(pending.report,null);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  const refused=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:event.version,media_version:recognized.version,expected_version:pending.version});
  assert.equal(refused.j.error,'audio_source_review_required');assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  const noAttestation=await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version});assert.equal(noAttestation.j.error,'source_review_confirmation_required');
  const reviewed=await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true});assert.equal(reviewed.r.ok,true);assert.equal(reviewed.j.event.version,event.version+1);assert.equal(reviewed.j.event.state,'inbox');assert.equal(reviewed.j.event.confirmation_scope,null);
  const latestMedia=(await h.request('/api/media/'+m.media_id)).j.media,latestConversation=await h.get(c);
  h.responses.set('/api/ai/conversation-turn',()=>({provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:'收到，我会按这段已核对的原话继续。'}));
  const staleMedia=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:reviewed.j.event.version,media_version:latestMedia.version-1,expected_version:latestConversation.version});
  assert.equal(staleMedia.j.error,'audio_source_changed');const staleConversation=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:reviewed.j.event.version,media_version:latestMedia.version,expected_version:latestConversation.version-1});
  assert.equal(staleConversation.j.error,'stale_conversation');assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  const accepted=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:reviewed.j.event.version,media_version:latestMedia.version,expected_version:latestConversation.version,keep_media_until_pause:true});
  assert.equal(accepted.r.ok,true);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);
  const turn=accepted.j.conversation.turns.find(t=>t.role==='elder');assert.equal(turn.text,text);assert.equal(turn.audio_source_version,reviewed.j.event.version);assert.equal(turn.audio_source_media_version,latestMedia.version);assert.equal(turn.audio_source_conversation_version,latestConversation.version);
  const payload=h.calls.find(call=>call.path==='/api/ai/conversation-turn').body;assert.equal(payload.turns.find(t=>t.turn_id===turn.turn_id).text,text);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
});
test('source review is atomic when local storage fails, leaving event, conversation and media untouched',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event,before=await h.get(c),baseMutate=h.api.vault.mutate.bind(h.api.vault);
  h.api.vault.mutate=async changes=>{if(changes.puts?.some(put=>put.key==='event:'+event.record_id&&put.value.source_review))throw Error('synthetic_quota_failure');return baseMutate(changes)};
  const failed=await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true});h.api.vault.mutate=baseMutate;
  assert.equal(failed.r.ok,false);assert.equal((await h.request('/api/events/'+event.record_id)).j.event.version,event.version);assert.equal((await h.request('/api/events/'+event.record_id)).j.event.source_review,undefined);
  assert.equal((await h.get(c)).version,before.version);assert.equal((await h.request('/api/media/'+m.media_id)).j.media.version,recognized.version);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
});
test('a stale stored audio-review flag is revoked on read, report, handoff and assistant resume',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event;
  const reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event,media=(await h.request('/api/media/'+m.media_id)).j.media,conversation=await h.get(c);
  const linked=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:reviewed.version,media_version:media.version,expected_version:conversation.version});assert.equal(linked.r.ok,true);
  const changed={...reviewed,version:reviewed.version+1,raw_text:'另一段未核对的合成文字'};await h.api.vault.put('event:'+event.record_id,changed);
  const current=await h.get(c),turn=current.turns.find(item=>item.role==='elder');assert.equal(turn.audio_source_reviewed,true,'the stored receipt remains historical metadata');assert.equal(turn.audio_source_invalidated,true,'the stale receipt cannot authorize current use');assert.ok(!current.report||current.report.transcript.some(item=>item.text===text)===false);
  const calls=cloudCount(h,'/api/ai/conversation-turn');await h.request('/api/conversations/'+c.conversation_id+'/resume-assistant',{});assert.equal(cloudCount(h,'/api/ai/conversation-turn'),calls);
  const handoff=(await h.request('/api/handoffs',{record_ids:[event.record_id]})).j.handoff;assert.equal(handoff.items.some(item=>item.record_id===event.record_id),false);assert.equal(handoff.pending_audio.some(item=>item.record_id===event.record_id),true);
});
test('a changed media version invalidates an otherwise matching audio-review receipt',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event,reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event,media=(await h.request('/api/media/'+m.media_id)).j.media,conversation=await h.get(c);
  const linked=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:reviewed.version,media_version:media.version,expected_version:conversation.version,keep_media_until_pause:true});assert.equal(linked.r.ok,true);
  await h.api.vault.put('media:'+m.media_id,{...media,version:media.version+1});const current=await h.get(c),turn=current.turns.find(item=>item.role==='elder');assert.equal(turn.audio_source_reviewed,true);assert.equal(turn.audio_source_invalidated,true);assert.ok(!current.report||!current.report.transcript.some(item=>item.text===text));
});
test('an audio source cannot cross conversations without the explicit saved-audio action',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),event=(await h.request('/api/events/'+recognized.event_link.record_id)).j.event,reviewed=(await h.request('/api/events/'+event.record_id+'/source-review',{expected_version:event.version,compared_with_original:true})).j.event,media=(await h.request('/api/media/'+m.media_id)).j.media;
  const first=await h.get(c),accepted=await h.request('/api/conversations/'+c.conversation_id+'/turns',{text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:reviewed.version,media_version:media.version,expected_version:first.version,keep_media_until_pause:true});assert.equal(accepted.r.ok,true);
  const other=await h.start(),payload={text,source_kind:'audio_transcript',record_id:event.record_id,media_id:m.media_id,source_version:reviewed.version,media_version:media.version,expected_version:other.version,keep_media_until_pause:true};
  const refused=await h.api.request('/api/conversations/'+other.conversation_id+'/turns',{method:'POST',headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify(payload)});assert.equal(refused.j.error,'conversation_source_shared');
  const replay=await h.api.request('/api/conversations/'+other.conversation_id+'/turns',{method:'POST',headers:{'Idempotency-Key':`saved-audio-conversation:${m.media_id}:${other.conversation_id}`},body:JSON.stringify(payload)});assert.equal(replay.r.ok,true);assert.equal(replay.j.conversation.turns.filter(turn=>turn.role==='elder').length,1);
});
function originalHarness({delayed=false,failNode=false}={}) {
  // Optional historical read is for red evidence only; no server/provider is started.
  const source=process.env.NORESET_TEST_ORIGINAL_BASELINE==='1'
    ?require('node:child_process').execFileSync('git',['show','cfa798b:frontend/media.js'],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8'})
    :fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');
  const urls=new Map(),targets=new Map(),revoked=[],counts={created:0,paused:0,cleared:0,loaded:0};let release,reject;
  const box={isConnected:true,replaceChildren(node){this.node=node},append(){},textContent:''};
  const parent={contains:node=>node===box};
  const context=vm.createContext({originalUrls:urls,originalTargets:targets,mediaItems:[],mediaLoadRequestId:0,recordDataGeneration:0,URL:{revokeObjectURL:url=>revoked.push(url)},
    HealthLocal:{active:true,originalObjectUrl:()=>delayed?new Promise((r,j)=>{release=r;reject=j}):Promise.resolve('blob:synthetic-audio')},localMode:false,
    document:{createElement(){counts.created++;if(failNode)throw Error('synthetic-render-failed');return{style:{},pause(){counts.paused++},removeAttribute(){counts.cleared++},load(){counts.loaded++}}}},mediaMessage(){}});
  const start=source.includes('function releaseOriginal(')?source.indexOf('function releaseOriginal('):source.indexOf('async function openOriginal(');
  vm.runInContext(source.slice(start,source.indexOf('async function showDocumentOriginals(')),context);
  const open=()=>context.openOriginal('media_synthetic',{box,media:{media_id:'media_synthetic',kind:'audio'}});
  const close=()=>{if(context.releaseOriginalsIn)context.releaseOriginalsIn(parent)};
  return {context,box,parent,urls,targets,revoked,counts,open,close,release:()=>release('blob:synthetic-audio'),reject:()=>reject(Error('synthetic-old-read-failed'))};
}
test('closing or redrawing an original player stops playback, clears source and revokes its object URL',async()=>{
  const h=originalHarness();await h.open();assert.equal(h.urls.size,1);h.close();
  assert.deepEqual(h.revoked,['blob:synthetic-audio']);assert.equal(h.urls.size,0);assert.equal(h.targets.size,0);
  assert.deepEqual(h.counts,{created:1,paused:1,cleared:1,loaded:1});
});
test('late detached or canceled original read and render failures release URLs without attaching a player',async()=>{
  for(const detached of [true,false]){
    const h=originalHarness({delayed:true}),pending=h.open();if(detached)h.box.isConnected=false;else h.close();
    h.release();await pending;assert.equal(h.counts.created,0);assert.equal(h.urls.size,0);assert.equal(h.targets.size,0);assert.deepEqual(h.revoked,['blob:synthetic-audio']);
  }
  const failed=originalHarness({failNode:true});await failed.open();assert.equal(failed.urls.size,0);assert.equal(failed.targets.size,0);assert.deepEqual(failed.revoked,['blob:synthetic-audio']);
});
test('metadata arriving after leaving a connected voice view cannot start a hidden original read',async()=>{
  const releases=[];let active=true;const app=appHarness({api:{request:path=>new Promise(resolve=>releases.push({path,resolve}))}},{conversation_id:'conversation_synthetic'});
  const box={isConnected:true,textContent:'',closest:()=>({classList:{contains:()=>active}})};
  const turn={turn_id:'turn_synthetic',role:'elder',source_kind:'audio_transcript',media_id:'media_synthetic',record_id:'record_synthetic',text:'synthetic spoken text'};
  const pending=app.context.showConversationOriginal(turn,box,{conversation_id:'conversation_synthetic'});active=false;
  for(const request of releases){
    if(request.path==='/api/media/media_synthetic')request.resolve({r:{ok:true},j:{media:{media_id:'media_synthetic',kind:'audio',conversation_id:'conversation_synthetic',subject_id:'subject_self',version:4,event_link:{record_id:'record_synthetic'}}}});
    else request.resolve({r:{ok:true},j:{events:[{record_id:'record_synthetic',subject_id:'subject_self',source_kind:'audio_transcript',state:'inbox',raw_text:'synthetic spoken text',version:7}]}});
  }
  await pending;assert.equal(app.originals.length,0);assert.equal(box.innerHTML,undefined);
});
test('an older original read failure cannot overwrite a newer successful player in the same box',async()=>{
  const h=originalHarness({delayed:true}),old=h.open();
  h.context.HealthLocal.originalObjectUrl=()=>Promise.resolve('blob:synthetic-new');await h.open();
  const player=h.box.node;h.reject();await old;
  assert.equal(h.box.textContent,'');assert.equal(h.box.node,player);assert.equal(h.urls.get('media_synthetic'),'blob:synthetic-new');assert.equal(h.counts.paused,0);
});
test('failed media-list rendering releases the archived audio before replacing its container',async()=>{
  const h=originalHarness();await h.open();h.context.api=async()=>({r:{ok:false},j:{}});h.context.$=()=>h.parent;
  const source=fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');vm.runInContext(source.slice(source.indexOf('async function loadMedia('),source.indexOf('function renderMedia(')),h.context);
  await h.context.loadMedia();assert.equal(h.urls.size,0);assert.deepEqual(h.revoked,['blob:synthetic-audio']);assert.equal(h.counts.paused,1);assert.match(h.parent.innerHTML,/原件列表暂时无法读取/);
});
