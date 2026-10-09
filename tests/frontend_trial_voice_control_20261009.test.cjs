// Offline mechanical HTTP responses over the real encrypted local API. No ASR/model is called.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto'),core=require('../frontend/local-store-core.js'),safety=require('../frontend/safety.js');
async function harness(shared){
  const driver=shared?.driver||new core.MemoryDocumentStore(),calls=shared?.calls||[],responses=shared?.responses||new Map(),elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,focus(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)};
  const context=vm.createContext({HealthLocalCore:{...core,IndexedDbDocumentStore:class{constructor(){return driver}}},HealthSafety:safety,indexedDB:{},crypto:webcrypto,FormData,Blob,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,navigator:{storage:{}},document:{getElementById:el,querySelector:()=>null},fetch:async(path,options)=>{
    calls.push({path,...options});const value=responses.has(path)?await responses.get(path):path==='/api/app/session'?{authenticated:true,csrf_token:'synthetic-csrf'}:{action:'reply',assistant_text:'我已按您说的保留这段记录。',provider:'SyntheticMechanicalFixture'};
    return{ok:!(value.__status>=400),status:value.__status||200,json:async()=>value};
  }});
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'),'utf8'),context);
  const api=context.HealthLocal,password='synthetic-trial-voice-only';if(!shared)await api.vault.setup(password);
  const ready=api.initialise();await new Promise(setImmediate);el('vaultPassphrase').value=password;await el('vaultForm').onsubmit({preventDefault(){}});await ready;
  const request=(p,b,h={})=>api.request(p,b===undefined?{}:{method:'POST',body:JSON.stringify(b),headers:h});
  const start=async()=>(await request('/api/conversations/start',{mode:'new',local_date:'2026-10-09'})).j.conversation;
  const audio=async c=>{const media_id='media_'+webcrypto.randomUUID().replaceAll('-','');const m={media_id,kind:'audio',content_type:'audio/wav',original_filename:'synthetic-only.wav',temporary:true,conversation_id:c.conversation_id,save_status:'saved',recognition_status:'not_started',link_status:'not_linked',version:1};await api.vault.put('media:'+media_id,m);await api.vault.putBinary('media-binary:'+media_id,new Uint8Array([1,2,3,4]).buffer);return m};
  const get=async c=>(await request('/api/conversations/'+c.conversation_id)).j.conversation;
  const recognize=async m=>{await request('/api/media/'+m.media_id+'/recognize',{});for(let i=0;i<100;i++){const value=(await request('/api/media/'+m.media_id)).j.media;if(value.recognition_status!=='processing'&&value.link_pending_reason!=='conversation_link_pending')return value;await new Promise(r=>setTimeout(r,3))}throw Error('local fixture did not settle')};
  return{driver,calls,responses,api,request,start,audio,get,recognize};
}
const success={recognition:{text:'完全虚构。我咳嗽两天，晚上明显。',is_mock:false},trial_control:{review_required:true}};
const cloudCount=(h,path)=>h.calls.filter(c=>c.path===path).length;
const continueBody=c=>({expected_version:c.version,turn_id:c.trial_control.turn_id,turn_version:c.trial_control.turn_version});

test('controlled ASR pauses after encrypted source save; fresh runtime and ordinary resume/finish send nothing and retain audio',async()=>{
  const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',success);
  const media=await h.recognize(m),saved=await h.get(c);assert.equal(media.recognition_status,'succeeded');assert.equal(saved.trial_control.state,'review_required');assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  const turn=saved.turns.find(t=>t.role==='elder');assert.equal(turn.text,success.recognition.text);assert.equal(turn.source_kind,'audio_transcript');assert.equal(turn.version,1);assert.equal(turn.record_id,media.record_id);
  const fresh=await harness(h),reopened=await fresh.get(c);assert.equal(reopened.trial_control.turn_id,turn.turn_id);
  await fresh.request('/api/conversations/'+c.conversation_id+'/resume-assistant',{});await fresh.request('/api/conversations/'+c.conversation_id+'/pause',{});await fresh.request('/api/conversations/'+c.conversation_id+'/finish',{});
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);assert.ok(await fresh.api.vault.get('media-binary:'+m.media_id));
  assert.equal(JSON.stringify(await h.driver.listDocs()).includes(success.recognition.text),false);
});

test('two manual continuation clicks serialize one model request; completed source permits a second controlled audio',async()=>{
  const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',success);await h.recognize(m);const saved=await h.get(c);
  const path='/api/conversations/'+c.conversation_id+'/trial-continue';const outcomes=await Promise.all([h.request(path,continueBody(saved)),h.request(path,continueBody(saved))]);
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);assert.equal(outcomes.filter(x=>x.r.ok).length,1);assert.equal((await h.get(c)).trial_control.state,'completed');assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
  const second=await h.audio(await h.get(c));h.responses.set('/api/ai/media/recognize',{...success,recognition:{text:'完全虚构。不是两天，是三天。',is_mock:false}});await h.recognize(second);
  const next=await h.get(c);assert.equal(next.trial_control.state,'review_required');assert.equal(next.turns.filter(t=>t.role==='elder').length,2);assert.equal(next.turns.filter(t=>t.role==='elder').at(-1).version,1);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);
});

test('LLM refusal stops globally without turning successful ASR into a failed/retryable recognition',async()=>{
  const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',success);await h.recognize(m);const saved=await h.get(c);
  h.responses.set('/api/ai/conversation-turn',{__status:422,error:'ai_conversation_failed',failure_code:'trial_stopped',trial_control:{review_required:true,stopped:true}});
  await h.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(saved));const stopped=await h.get(c);assert.equal(stopped.trial_control.state,'stopped');
  const retained=(await h.request('/api/media/'+m.media_id)).j.media;assert.equal(retained.recognition_status,'succeeded');assert.equal(retained.recognition.text,success.recognition.text);
  await h.request('/api/conversations/'+c.conversation_id+'/resume-assistant',{});await h.request('/api/media/'+m.media_id+'/recognize',{});
  const other=await h.start(),otherAudio=await h.audio(other);await h.request('/api/media/'+otherAudio.media_id+'/recognize',{});
  assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);assert.equal(cloudCount(h,'/api/ai/media/recognize'),1);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
});

test('late controlled ASR after pause saves its source without model; second in-flight audio cannot race ahead',async()=>{
  const h=await harness(),c=await h.start(),m=await h.audio(c);let release;h.responses.set('/api/ai/media/recognize',new Promise(r=>release=r));await h.request('/api/media/'+m.media_id+'/recognize',{});
  while(!cloudCount(h,'/api/ai/media/recognize'))await new Promise(setImmediate);
  await h.request('/api/conversations/'+c.conversation_id+'/pause',{});const other=await h.start(),otherAudio=await h.audio(other);const denied=await h.request('/api/media/'+otherAudio.media_id+'/recognize',{});assert.equal(denied.r.status,409);
  release(success);for(let i=0;i<100&&!(await h.get(c)).trial_control;i++)await new Promise(r=>setTimeout(r,3));
  const saved=await h.get(c);assert.equal(saved.trial_control.state,'review_required');assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);assert.equal(cloudCount(h,'/api/ai/media/recognize'),1);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
});

test('unknown top-level trial marker stops; absent marker preserves ordinary single-turn chain',async()=>{
  for(const marker of [{review_required:false},{review_required:true,extra:'unknown'},null]){
    const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',{...success,trial_control:marker});await h.recognize(m);assert.equal((await h.get(c)).trial_control.state,'stopped');assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
  }
  const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',{recognition:success.recognition});await h.recognize(m);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);assert.equal((await h.get(c)).trial_control,undefined);
});

test('continuing is durable before a late reply; reopening cannot resume or submit a second request',async()=>{
  const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',success);await h.recognize(m);const saved=await h.get(c);let release;
  h.responses.set('/api/ai/conversation-turn',new Promise(r=>release=r));const pending=h.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(saved));
  while(!cloudCount(h,'/api/ai/conversation-turn'))await new Promise(setImmediate);
  try{const fresh=await harness(h),current=await fresh.get(c);assert.equal(current.trial_control.state,'continuing');await fresh.request('/api/conversations/'+c.conversation_id+'/resume-assistant',{});assert.equal((await fresh.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(current))).r.status,409);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1)}
  finally{release({action:'reply',assistant_text:'我已保留这段原话。',provider:'SyntheticMechanicalFixture'});await pending}
});

test('ASR stopped marker suppresses retry and a different conversation, preserving synthetic original',async()=>{
  const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',{__status:503,error:'provider_timeout',retryable:true,trial_control:{review_required:true,stopped:true}});
  const failed=await h.recognize(m);assert.equal(failed.trial_control.state,'stopped');assert.equal(failed.recognition.error.retryable,false);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
  const other=await h.start();await h.request('/api/conversations/'+other.conversation_id+'/resume-assistant',{});await h.request('/api/media/'+m.media_id+'/recognize',{});assert.equal(cloudCount(h,'/api/ai/media/recognize'),1);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);
});

function appHarness(h,conversation){
  const elements=new Map(),apiCalls=[];const el=id=>{if(!elements.has(id))elements.set(id,{classList:{add(){},remove(){}},value:'',textContent:''});return elements.get(id)};
  const context=vm.createContext({activeConversation:conversation,conversationLoading:false,conversationEditingTurnId:null,saveBusy:false,HealthLocal:h.api,document:{querySelector:()=>null},$ :el,api:async(p,o)=>{apiCalls.push(p);return h.api.request(p,o)},localDateValue:()=> '2026-10-09',conversationHasPendingReply:()=>true,syncConversation:c=>{context.activeConversation=c},setVoiceComposerEnabled(){},renderVoiceConversation(){},renderConversationReport(){},loadEvents(){},setVoiceStatus:message=>el('status').textContent=message,startConversation(){throw Error('unexpected auto start')}});
  const text=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');
  for(const [start,end]of[['function trialVoiceMessage(','function voiceTurnHtml('],['async function loadConversation(','async function pauseConversation('],['async function showVoiceMediaResult(','function prepareMediaRetry(']]) vm.runInContext(text.slice(text.indexOf(start),text.indexOf(end)),context);
  return{context,apiCalls,el,run:code=>vm.runInContext(code,context)};
}

test('actual app reentry and linked voice-result functions keep trial review paused with no auto resume or cleanup',async()=>{
  const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',success);const media=await h.recognize(m);const app=appHarness(h,await h.get(c));
  await app.run('loadConversation()');assert.equal(app.apiCalls.some(p=>p.endsWith('/resume-assistant')),false);assert.match(app.el('status').textContent,/核对文字/);
  app.context.media=media;await app.run('showVoiceMediaResult(media)');assert.equal(app.apiCalls.some(p=>p.endsWith('/pause')),false);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
});

function captureHarness(){
  let release,starts=0,stops=0;const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',classList:{contains:()=>false}});return elements.get(id)};
  class Recorder{static isTypeSupported(){return false}constructor(stream){this.stream=stream;this.state='inactive'}start(){starts++;this.state='recording'}stop(){this.state='inactive'}}
  const context=vm.createContext({MediaRecorder:Recorder,navigator:{mediaDevices:{getUserMedia:()=>new Promise(r=>release=r)}},HealthLocal:{trialVoiceState:async()=>context.trial},trial:null,recognitionBusy:new Set(),activeConversation:{conversation_id:'synthetic_a'},voicePermissionGeneration:0,voicePermissionPending:false,voiceUploadPending:false,mediaRecorder:null,chunks:[],elapsedMs:0,timerId:null,startedAt:0,$:el,setVoiceStatus:m=>el('status').textContent=m,trialVoiceMessage:()=> '试验已停止',speechSynthesis:{cancel(){}},setRecording(){},updateTimer(){},clearInterval(){},setInterval:()=>1,startSilenceWatch:()=>false,stopSilenceWatch(){}});
  const source=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');vm.runInContext(source.slice(source.indexOf('async function startVoice('),source.indexOf("$('recordBtn').onclick=startVoice")),context);
  return{context,el,run:c=>vm.runInContext(c,context),release:()=>release({getTracks:()=>[{stop(){stops++}},{stop(){stops++}}]}),counts:()=>({starts,stops})};
}
test('late synthetic microphone permission after shared stop closes all tracks without starting recording',async()=>{
  const h=captureHarness(),pending=h.run('startVoice()');while(!h.context.voicePermissionPending)await new Promise(setImmediate);
  h.context.trial={state:'stopped'};h.release();await pending;assert.deepEqual(h.counts(),{starts:0,stops:2});assert.equal(h.context.voicePermissionPending,false);
});
test('cancel generation and changed conversation both reject late synthetic microphone permission',async()=>{
  for(const cancel of ['stopVoice("已暂停")','activeConversation={conversation_id:"synthetic_b"}']){
    const h=captureHarness(),pending=h.run('startVoice()');while(!h.context.voicePermissionPending)await new Promise(setImmediate);h.run(cancel);h.release();await pending;assert.deepEqual(h.counts(),{starts:0,stops:2});
  }
});
test('shared review or stop arising during online session wait prevents ordinary late model send',async()=>{
  for(const state of ['review_required','stopped']){
    const h=await harness(),c=await h.start();let release;h.responses.set('/api/app/session',new Promise(r=>release=r));const before=cloudCount(h,'/api/app/session');
    const pending=h.request('/api/conversations/'+c.conversation_id+'/turns',{text:'完全虚构。我咳嗽两天。',expected_version:c.version},{'Idempotency-Key':'synthetic-late-session'});
    while(cloudCount(h,'/api/app/session')===before)await new Promise(setImmediate);
    await h.api.vault.put('trial-control:voice',{review_required:true,state,conversation_id:'another_synthetic_conversation'});release({authenticated:true,csrf_token:'synthetic-csrf'});await pending;
    assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);assert.equal((await h.get(c)).turns.find(t=>t.role==='elder').text,'完全虚构。我咳嗽两天。');
  }
});
test('manual continuation owner changing during session wait cannot bypass shared stop or turn binding',async()=>{
  for(const changed of [{state:'stopped'},{state:'continuing',turn_id:'another_synthetic_turn'}]){
    const h=await harness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',success);await h.recognize(m);const saved=await h.get(c);let release;
    h.responses.set('/api/app/session',new Promise(r=>release=r));const before=cloudCount(h,'/api/app/session');const pending=h.request('/api/conversations/'+c.conversation_id+'/trial-continue',continueBody(saved));
    while(cloudCount(h,'/api/app/session')===before)await new Promise(setImmediate);
    await h.api.vault.put('trial-control:voice',{...(await h.api.trialVoiceState()),...changed});release({authenticated:true,csrf_token:'synthetic-csrf'});await pending;assert.equal(cloudCount(h,'/api/ai/conversation-turn'),0);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
  }
});
test('actual TTS function checks global stop before speaking a different conversation opening',async()=>{
  let spoken=0;const context=vm.createContext({HealthLocal:{trialVoiceState:async()=>({state:'stopped'})},activeConversation:{conversation_id:'synthetic_new'},lastSpokenTurnId:null,isMockContent:()=>false,speechSynthesis:{cancel(){},resume(){},speak(){spoken++}},SpeechSynthesisUtterance:class{constructor(text){this.text=text}}});
  const text=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');vm.runInContext(text.slice(text.search(/(?:async )?function speakAssistant\(/),text.indexOf('function beginVoiceTurnEdit(')),context);
  await vm.runInContext('speakAssistant({turn_id:"synthetic_opening",text:"您慢慢说。"})',context);assert.equal(spoken,0);
});
