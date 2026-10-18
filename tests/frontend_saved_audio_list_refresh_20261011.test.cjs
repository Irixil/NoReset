const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const path=require('node:path'),R=path.resolve(__dirname,'..'),safety=require(R+'/frontend/safety.js'),source=fs.readFileSync(R+'/frontend/media.js','utf8');
const start=source.indexOf('async function currentSavedAudioSource('),end=source.indexOf('function showRecognition(',start);
test('a completed single saved-audio reply is visible in refreshed record lists without another model request',async()=>{
 const text='我咳嗽两天了，晚上明显些。',media={media_id:'media_N01_fixture',kind:'audio',version:4,recognition_status:'succeeded',recognition:{text,is_mock:false},event_link:{record_id:'rec_N01_fixture'},trial_control:{state:'completed',review_required:true}};
 const event={record_id:'rec_N01_fixture',source_kind:'audio_transcript',state:'inbox',raw_text:text,version:2,source_review:{method:'original_comparison',record_id:'rec_N01_fixture',confirmed_at:'2026-10-11T03:10:17.623Z',text}};
 let normalCalls=0,refreshes=0;const old={conversation_id:'old',report:{text:'旧三天原话'}};let persisted=[old],visible=[old];
 const ctx=vm.createContext({HealthSafety:safety,HealthLocal:{trialVoiceState:async()=>({state:'completed'})},mediaRequest:async()=>({media}),
 api:async route=>{if(route==='/api/events')return{r:{ok:true},j:{events:[event]}};assert.equal(route,'/api/conversations/saved-audio-trial/start');normalCalls++;const saved={conversation_id:'new',report:{text},saved_audio_trial:{state:'completed'}};persisted=[saved,old];return{r:{ok:true},j:{conversation:saved,created:true,ai_failed:false}}},
 isMockMedia:()=>false,isMockContent:()=>false,localDateValue:()=> '2026-10-11',syncConversation:()=>{},showView:()=>{},mediaMessage:()=>{},savedAudioTrialMessage:()=> '回复已保存；本次单次测试已结束。',setVoiceStatus:()=>{},setVoiceComposerEnabled:()=>{},loadEvents:async()=>{refreshes++;visible=[...persisted]},Error});
 vm.runInContext(source.slice(start,end),ctx);
 assert.equal(await ctx.startConversationFromSavedAudio(media),true);
 assert.equal(normalCalls,1);assert.equal(refreshes,1);
 assert.deepEqual(visible.map(c=>c.conversation_id),['new','old']);
 assert.equal(visible[1].report.text,'旧三天原话');
});
