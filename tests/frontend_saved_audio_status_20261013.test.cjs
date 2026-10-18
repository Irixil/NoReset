const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const safety=require('../frontend/safety.js');
const mediaSource=fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');
const appSource=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');

function mediaHarness(response){
  const media={media_id:'media_synthetic_saved_status',kind:'audio',version:3,recognition_status:'succeeded',recognition:{text:'完全虚构：咳嗽两天。',is_mock:false},event_link:{record_id:'rec_synthetic_saved_status'},trial_control:{state:'review_required'}};
  const event={record_id:'rec_synthetic_saved_status',source_kind:'audio_transcript',state:'inbox',raw_text:'完全虚构：咳嗽两天。',version:2,source_review:{method:'original_comparison',record_id:'rec_synthetic_saved_status',confirmed_at:'2026-10-13T00:00:00Z',text:'完全虚构：咳嗽两天。'}};
  const calls=[],mediaMessages=[],voiceMessages=[];
  const context=vm.createContext({HealthSafety:safety,HealthLocal:{trialVoiceState:async()=>({state:'review_required'})},isMockMedia:()=>false,isMockContent:()=>false,
    mediaRequest:async path=>({media}),api:async path=>{calls.push(path);if(path==='/api/events')return{r:{ok:true},j:{events:[event]}};return response},
    mediaMessage:message=>mediaMessages.push(message),localDateValue:()=> '2026-10-13',syncConversation(){},showView(){},
    setVoiceStatus:(message,tone)=>voiceMessages.push({message,tone}),setVoiceComposerEnabled(){},loadEvents:async()=>{},
    startSeparateConversation:async()=>false,submitConversationText:async()=>false,Error});
  const statusStart=appSource.indexOf('function savedAudioTrialMessage('),statusEnd=appSource.indexOf('async function continueTrialVoice(',statusStart);
  vm.runInContext(appSource.slice(statusStart,statusEnd),context);
  const start=mediaSource.indexOf('async function currentSavedAudioSource('),end=mediaSource.indexOf('function showRecognition(',start);
  vm.runInContext(mediaSource.slice(start,end),context);
  return{context,media,calls,mediaMessages,voiceMessages,run:()=>context.startConversationFromSavedAudio(media)};
}

test('saved-audio request announces its in-flight response while the request is pending',async()=>{
  let release;const h=mediaHarness(new Promise(resolve=>{release=resolve}));
  const pending=h.run(),route='/api/conversations/saved-audio-trial/start';
  while(!h.calls.includes(route))await new Promise(setImmediate);
  release({r:{ok:true},j:{conversation:{conversation_id:'saved',saved_audio_trial:{state:'completed'}},created:true,ai_failed:false}});
  assert.equal(await pending,true);assert.match(h.mediaMessages.at(-1)||'',/正在根据已核对文字回应/);
  assert.match(h.voiceMessages.at(-1).message,/回复已保存；本次单次测试已结束/);
});

test('a failed saved-audio request says the original and checked text remain and will not be resent automatically',async()=>{
  const h=mediaHarness({r:{ok:false,status:503},j:{error:'provider_unavailable'}});
  await assert.rejects(h.run(),/原录音和已核对文字仍保留，不会自动重发/);
  assert.equal(h.calls.filter(path=>path==='/api/conversations/saved-audio-trial/start').length,1);
});

function appHarness(savedState){
  const conversation={conversation_id:'conversation_saved_status',subject_id:'subject_self',turns:[{turn_id:'elder',role:'elder',text:'完全虚构：咳嗽两天。',source_kind:'audio_transcript',audio_source_reviewed:true}],saved_audio_trial:{state:savedState}};
  const oldAsrTrial={state:'review_required',source_kind:'audio_transcript',media_id:'media_old_asr_control'};
  const apiCalls=[],statusMessages=[],composerStates=[];let globalTrialReads=0;
  const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,classList:{add(){},remove(){},toggle(){}}});return elements.get(id)};
  const context=vm.createContext({activeConversation:null,conversationLoading:false,conversationEditingTurnId:null,pendingAudioReview:null,pendingAudioReviewCandidates:[],
    saveBusy:false,HealthLocal:{trialVoiceState:async()=>{globalTrialReads++;return oldAsrTrial}},HealthSafety:safety,localMode:false,
    healthSubjectUiEpoch:0,activeHealthSubjectId:'subject_self',healthSubjectsVersion:1,healthSubjectSwitchBusy:false,healthSubjectChanged:false,
    document:{querySelector:()=>null},$:el,api:async path=>{apiCalls.push(path);return{r:{ok:true},j:{conversation}}},localDateValue:()=> '2026-10-13',
    syncConversation:c=>{context.activeConversation=c},setVoiceComposerEnabled:enabled=>composerStates.push(Boolean(enabled&&!context.activeConversation?.saved_audio_trial)),
    renderVoiceConversation(){},renderConversationReport(){},loadEvents(){},setVoiceStatus:(message,tone)=>statusMessages.push({message,tone}),
    conversationHasPendingReply:()=>true,findPendingAudioReviewCandidates:async()=>({ok:true,candidates:[]}),startConversation(){throw Error('unexpected auto start')}});
  const trialStart=appSource.indexOf('function trialVoiceMessage('),trialEnd=appSource.indexOf('function voiceTurnHtml(',trialStart);
  const loadStart=appSource.indexOf('async function loadConversation('),loadEnd=appSource.indexOf('async function pauseConversation(',loadStart);
  vm.runInContext(appSource.slice(trialStart,trialEnd)+appSource.slice(loadStart,loadEnd),context);
  return{context,apiCalls,statusMessages,composerStates,globalReads:()=>globalTrialReads,run:()=>vm.runInContext('loadConversation()',context)};
}

for(const [state,message] of [
  ['sending','正在根据已核对文字回应'],
  ['completed','回复已保存；本次单次测试已结束'],
  ['stopped','本次回复未完成；原录音和已核对文字仍保留，不会自动重发'],
]){
  test(`saved-audio ${state} status takes precedence over the old ASR control without resending`,async()=>{
    const h=appHarness(state);await h.run();
    assert.ok(h.statusMessages.at(-1).message.includes(message));
    assert.equal(h.globalReads(),0);
    assert.equal(h.apiCalls.some(path=>path.endsWith('/resume-assistant')),false);
    assert.equal(h.composerStates.at(-1),false);
  });
}
