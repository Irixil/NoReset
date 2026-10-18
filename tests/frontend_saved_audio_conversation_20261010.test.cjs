const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const safety=require('../frontend/safety.js'),source=fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');
const start=source.indexOf('async function currentSavedAudioSource('),end=source.indexOf('function showRecognition(',start);
function harness(change={}){
  const saved={media_id:'media_synthetic',kind:'audio',version:2,recognition_status:'succeeded',recognition:{text:'上妇这?两天不舒服',is_mock:false},event_link:{record_id:'rec_original'}};
  const original={record_id:'rec_original',source_kind:'audio_transcript',state:'superseded'};
  const event={record_id:'rec_current',supersedes_id:'rec_original',source_kind:'audio_transcript',state:'inbox',raw_text:'虚构：上腹这两天不舒服。',version:4,source_review:{method:'original_comparison',record_id:'rec_current',confirmed_at:'2026-10-10T17:00:00Z',text:'虚构：上腹这两天不舒服。'},...change.event};
  const calls=[];let started=0;
  const ctx=vm.createContext({HealthSafety:safety,HealthLocal:{trialVoiceState:async()=>change.global_trial||null},mediaRequest:async path=>{calls.push({get:path});if(change.denied)throw new Error('subject_mismatch');return {media:{...saved,...change}}},api:async path=>{calls.push({get:path});return{r:{ok:path!=='/api/conversations/saved-audio-trial/start'&&!change.records_failed},j:{events:change.deleted?[]:[original,event]}}},
    isMockMedia:m=>m.recognition?.is_mock===true,isMockContent:e=>e.is_mock===true,startSeparateConversation:async()=>{started++;return !change.start_failed},showView:v=>calls.push({view:v}),showDetail:async id=>calls.push({detail:id}),mediaMessage:m=>calls.push({message:m}),
    localDateValue:()=> '2026-10-10',activeConversation:{conversation_id:'conv_synthetic_new'},submitConversationText:async(text,meta)=>{calls.push({text,meta});return true},Error});
  vm.runInContext(source.slice(start,end),ctx);
  return {saved,event,calls,started:()=>started,run:()=>ctx.startConversationFromSavedAudio(saved),open:()=>ctx.showCurrentAudioSource(saved)};
}
test('saved audio uses current confirmed revision with its exact version and preserves original ASR link',async()=>{
  const h=harness();assert.equal(await h.run(),true);assert.equal(h.started(),1);
  assert.equal(h.calls[0].get,'/api/media/media_synthetic');assert.equal(h.calls[1].get,'/api/events');assert.equal(h.calls[2].view,'voiceView');
  assert.equal(h.calls[3].text,h.event.raw_text);assert.notEqual(h.calls[3].text,h.saved.recognition.text);assert.equal(h.calls[3].meta.source_kind,'audio_transcript');
  assert.equal(h.calls[3].meta.record_id,'rec_current');assert.equal(h.calls[3].meta.source_version,4);assert.equal(h.calls[3].meta.media_id,'media_synthetic');
  assert.equal(h.calls[3].meta.idempotencyKey,'saved-audio-conversation:media_synthetic:conv_synthetic_new');assert.equal(h.saved.event_link.record_id,'rec_original');
});
for(const [name,change]of Object.entries({controlled_source:{trial_control:{state:'review_required'}},global_stop:{global_trial:{state:'stopped'}},stale:{version:3},other_subject:{denied:true},failed:{recognition_status:'failed'},image:{kind:'image'},mock:{recognition:{text:'fictional',is_mock:true}},unlinked:{event_link:null},empty:{recognition:{text:''}},unconfirmed:{event:{source_review:null}},wrong_confirmed_text:{event:{source_review:{method:'original_comparison',record_id:'rec_current',confirmed_at:'now',text:'old'}}},deleted:{deleted:true},read_failed:{records_failed:true}})){
  test(name+' rejects before starting or sending any conversation',async()=>{const h=harness(change);await assert.rejects(h.run());assert.equal(h.started(),0);assert.equal(h.calls.some(c=>c.text||c.view),false)});
}
test('a refused new conversation sends nothing and preserves the saved media',async()=>{const h=harness({start_failed:true});assert.equal(await h.run(),false);assert.equal(h.calls.length,2);assert.equal(h.saved.version,2)});
test('old media entry opens the current revision without generating a conversation or supplier call',async()=>{const h=harness();await h.open();assert.equal(h.calls.at(-1).detail,'rec_current');assert.equal(h.started(),0);assert.equal(h.calls.some(c=>c.text),false)});
