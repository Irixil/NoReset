const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const core=require('../frontend/local-store-core.js');
const safety=require('../frontend/safety.js');
const appSource=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');
const markup=fs.readFileSync(require.resolve('../frontend/index.html'),'utf8');

const password='quote history synthetic vault only';
const plain=value=>JSON.parse(JSON.stringify(value));
async function harness(){
  const elements=new Map(),calls=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,focus(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id)};
  let replyCount=0,lastPayload=null,beforeReply=null;
  const context=vm.createContext({HealthLocalCore:{...core,IndexedDbDocumentStore:core.MemoryDocumentStore},HealthSafety:safety,
    indexedDB:{},crypto:webcrypto,FormData,Blob,URL,URLSearchParams,AbortController,structuredClone,setTimeout,clearTimeout,navigator:{storage:{}},
    document:{getElementById:element,querySelector:()=>null},fetch:async(path,options={})=>{
      calls.push({path,options});
      const data=path==='/api/app/session'?{authenticated:true,csrf_token:'synthetic-local-only'}:(()=>{
        lastPayload=JSON.parse(options.body);replyCount++;
        const last=lastPayload.turns.at(-1);
        const response={provider:'SyntheticOfflineFixture',model_id:'synthetic-local',trace_id:`quote-${replyCount}`,
          action:'ask',assistant_text:'这句话我记下了。您想补充哪一点？',question_category:'associated_symptoms',
          controller:{...lastPayload.controller},completeness:{clinical_state:{associated_symptoms:{status:'missing',summary:'',evidence_turn_ids:[],context_ids:[]}},
            contradictions:[],unknowns:[],relevant_context_ids:[],evidence_turn_ids:[last.turn_id]},
          pending_questions:['您还想补充哪一点？'],relevant_context_ids:[]};
        return response;
      })();
      if(path!=='/api/app/session'&&beforeReply){const run=beforeReply;beforeReply=null;await run();}
      return {ok:true,status:200,json:async()=>data};
    }});
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'),'utf8'),context);
  const api=context.HealthLocal;await api.vault.setup(password);
  const ready=api.initialise();await new Promise(setImmediate);element('vaultPassphrase').value=password;
  await element('vaultForm').onsubmit({preventDefault(){}});await ready;
  const request=(path,body)=>api.request(path,body===undefined?{}:{method:'POST',headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify(body)});
  const start=async()=>(await request('/api/conversations/start',{mode:'new',local_date:'2026-10-23'})).j.conversation;
  const say=async(conversation,text)=>request(`/api/conversations/${conversation.conversation_id}/turns`,{text,expected_version:conversation.version});
  return {api,calls,request,start,say,setBeforeReply(fn){beforeReply=fn},get payload(){return lastPayload},get replyCount(){return replyCount}};
}

async function seedAudioQuote(h){
  let conversation=(await h.say(await h.start(),'完全虚构：录音里说膝盖有些酸。')).j.conversation;
  const elder=conversation.turns.find(turn=>turn.role==='elder'),recordKey=`event:${elder.record_id}`,mediaId='media_quote_audio_fixture';
  const event={...await h.api.vault.get(recordKey),source_kind:'audio_transcript',source_conversation_id:conversation.conversation_id};
  const media={media_id:mediaId,kind:'audio',recognition_status:'succeeded',version:1,subject_id:conversation.subject_id,
    conversation_id:conversation.conversation_id,event_link:{record_id:event.record_id}};
  const audioTurn={...elder,source_kind:'audio_transcript',media_id:mediaId,audio_source_status:'machine_transcribed',
    audio_source_reviewed:false,audio_source_version:event.version,audio_source_media_version:media.version,
    audio_source_conversation_id:conversation.conversation_id,audio_source_conversation_version:conversation.version};
  conversation={...conversation,version:conversation.version+1,turns:conversation.turns.map(turn=>turn.turn_id===elder.turn_id?audioTurn:turn)};
  await h.api.vault.put(recordKey,event);await h.api.vault.put(`media:${mediaId}`,media);
  await h.api.vault.put(`media-binary:${mediaId}`,{bytes:new Uint8Array([1,2,3])});
  await h.api.vault.put(`conversation:${conversation.conversation_id}`,conversation);
  const current=(await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  return {conversation:current,elder:current.turns.find(turn=>turn.turn_id===elder.turn_id),event,media};
}

test('quote_ref is locally resolved to a source-bound snapshot and never joined with elder text',async()=>{
  const h=await harness();let conversation=await h.start();
  conversation=(await h.say(conversation,'完全虚构：我今天手腕有点不舒服。')).j.conversation;
  const today=new Date(),expectedDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  assert.equal(conversation.last_local_date,expectedDate,'only a newly added turn advances the conversation local date');
  const elder=conversation.turns.find(turn=>turn.role==='elder');assert.ok(elder?.record_id);
  const before=conversation.report_history?.length||0,oldReport=plain(conversation.report);
  const saved=await h.api.request(`/api/conversations/${conversation.conversation_id}/turns`,{method:'POST',headers:{'Idempotency-Key':webcrypto.randomUUID()},
    body:JSON.stringify({text:'纯虚构：我想追问刚才那句话是什么意思。',expected_version:conversation.version,quote_ref:{turn_id:elder.turn_id,version:elder.version}})});
  assert.equal(saved.r.status,201,JSON.stringify(saved.j));
  const updated=saved.j.conversation,quoted=updated.turns.filter(turn=>turn.role==='elder').at(-1);
  assert.equal(quoted.text,'纯虚构：我想追问刚才那句话是什么意思。');assert.equal(quoted.original_text,'纯虚构：我想追问刚才那句话是什么意思。');
  assert.deepEqual(plain(quoted.quote_context),{conversation_id:conversation.conversation_id,turn_id:elder.turn_id,role:'elder',version:elder.version,
    text:elder.text,source:{source_kind:'elder',record_id:elder.record_id,record_version:1,media_id:null,media_version:null}});
  assert.equal(quoted.responding_to,undefined,'a general quote does not become the clinical answer binding');
  assert.deepEqual(plain(h.payload.quote_context),plain(quoted.quote_context),'the model gets a separate quote_context field');
  assert.equal(h.payload.turns.at(-1).text,'纯虚构：我想追问刚才那句话是什么意思。');
  assert.equal(h.payload.turns.at(-1).text.includes(elder.text),false,'the quoted patient text is not copied into the new patient turn');
  assert.ok(updated.report_history.length>=before+1);
  assert.ok(updated.report_history.some(item=>item.version===oldReport.version));
  assert.equal(new Set(updated.report_history.map(item=>item.version)).size,updated.report_history.length,'old report versions are deduplicated');
  const reopened=(await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  const reopenedQuote=reopened.turns.find(turn=>turn.turn_id===quoted.turn_id);
  assert.deepEqual(plain(reopenedQuote.quote_context),plain(quoted.quote_context));
  assert.equal(reopenedQuote.quote_context_valid,true);
});

test('invalid or stale quote references fail before any model request or new turn',async()=>{
  const h=await harness();const conversation=await h.say(await h.start(),'完全虚构：左手腕有点痛。').then(x=>x.j.conversation);
  const target=conversation.turns.find(turn=>turn.role==='elder'),beforeCalls=h.replyCount;
  for(const [quote_ref,status] of [[{turn_id:target.turn_id,version:target.version+1},409],[{turn_id:target.turn_id,version:1,text:target.text},400]]){
    const result=await h.api.request(`/api/conversations/${conversation.conversation_id}/turns`,{method:'POST',headers:{'Idempotency-Key':webcrypto.randomUUID()},
      body:JSON.stringify({text:'不要发送',expected_version:conversation.version,quote_ref})});
    assert.equal(result.r.status,status);assert.equal(h.replyCount,beforeCalls);
  }
  const unchanged=(await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.equal(unchanged.turns.filter(turn=>turn.role==='elder').length,1);
});

test('an assistant quote is kept as separate dialogue context with no clinical answer binding',async()=>{
  const h=await harness();
  const conversation=(await h.say(await h.start(),'完全虚构：我想知道这项记录如何理解。')).j.conversation;
  const assistant=conversation.turns.filter(turn=>turn.role==='assistant'&&!turn.superseded).at(-1);
  assert.ok(assistant);
  const result=await h.api.request(`/api/conversations/${conversation.conversation_id}/turns`,{method:'POST',
    headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify({text:'完全虚构：请解释刚才的回复。',expected_version:conversation.version,
      quote_ref:{turn_id:assistant.turn_id,version:assistant.version}})});
  assert.equal(result.r.status,201,JSON.stringify(result.j));
  const elder=result.j.conversation.turns.filter(turn=>turn.role==='elder').at(-1);
  assert.equal(elder.text,'完全虚构：请解释刚才的回复。');
  assert.equal(elder.responding_to,undefined);
  assert.deepEqual(plain(elder.quote_context),{conversation_id:conversation.conversation_id,turn_id:assistant.turn_id,role:'assistant',version:assistant.version,
    text:assistant.text,source:{source_kind:'assistant_message',record_id:null,record_version:null,media_id:null,media_version:null}});
  assert.deepEqual(plain(h.payload.quote_context),plain(elder.quote_context));
  assert.equal(h.payload.turns.at(-1).text,elder.text);
});

test('stale assistant quote targets and revoked context are rejected by the local API before model work',async()=>{
  const h=await harness();
  const conversation=(await h.say(await h.start(),'完全虚构：我想知道这项记录如何理解。')).j.conversation;
  const assistant=conversation.turns.filter(turn=>turn.role==='assistant'&&!turn.superseded).at(-1),beforeCalls=h.replyCount;
  const post=()=>h.api.request(`/api/conversations/${conversation.conversation_id}/turns`,{method:'POST',
    headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify({text:'完全虚构：请解释刚才的回复。',expected_version:conversation.version,
      quote_ref:{turn_id:assistant.turn_id,version:assistant.version}})});
  await h.api.vault.put(`conversation:${conversation.conversation_id}`,{...conversation,stale_responding_to_turn_ids:[assistant.turn_id]});
  let result=await post();assert.equal(result.r.status,409);assert.equal(result.j.error,'quote_context_stale');
  await h.api.vault.put(`conversation:${conversation.conversation_id}`,{...conversation,health_context_version:1});
  result=await post();assert.equal(result.r.status,409);assert.equal(result.j.error,'quote_context_stale');
  assert.equal(h.replyCount,beforeCalls,'both stale references fail before model processing');
  const unchanged=(await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.equal(unchanged.turns.filter(turn=>turn.role==='elder').length,1);
});

test('an older source correction is rejected after later quoted turns and preserves all follow-up history',async()=>{
  const h=await harness();
  let conversation=(await h.say(await h.start(),'合成测试原话：手腕有些不舒服。')).j.conversation;
  const source=conversation.turns.find(turn=>turn.role==='elder');
  const firstAssistant=conversation.turns.filter(turn=>turn.role==='assistant'&&!turn.superseded).at(-1);
  conversation=(await h.api.request(`/api/conversations/${conversation.conversation_id}/turns`,{method:'POST',
    headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify({text:'合成测试追问：请解释刚才那句话。',expected_version:conversation.version,
      quote_ref:{turn_id:source.turn_id,version:source.version}})})).j.conversation;
  const followedAssistant=conversation.turns.filter(turn=>turn.role==='assistant'&&!turn.superseded).at(-1);
  assert.notEqual(followedAssistant.turn_id,firstAssistant.turn_id);
  conversation=(await h.api.request(`/api/conversations/${conversation.conversation_id}/turns`,{method:'POST',
    headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify({text:'合成测试录音转写：请接着解释上一条回复。',expected_version:conversation.version,
      quote_ref:{turn_id:followedAssistant.turn_id,version:followedAssistant.version}})})).j.conversation;
  let latest=conversation.turns.filter(turn=>turn.role==='elder'&&!turn.superseded).at(-1);
  const audioMediaId='media_quote_history_latest_audio_fixture',audioEventKey=`event:${latest.record_id}`;
  const audioEvent={...await h.api.vault.get(audioEventKey),source_kind:'audio_transcript',source_conversation_id:conversation.conversation_id};
  const audioMedia={media_id:audioMediaId,kind:'audio',recognition_status:'succeeded',version:1,subject_id:conversation.subject_id,
    conversation_id:conversation.conversation_id,event_link:{record_id:audioEvent.record_id}};
  const latestAudio={...latest,source_kind:'audio_transcript',media_id:audioMediaId,audio_source_status:'machine_transcribed',
    audio_source_reviewed:false,audio_source_version:audioEvent.version,audio_source_media_version:audioMedia.version,
    audio_source_conversation_id:conversation.conversation_id,audio_source_conversation_version:conversation.version};
  conversation={...conversation,version:conversation.version+1,turns:conversation.turns.map(turn=>turn.turn_id===latest.turn_id?latestAudio:turn)};
  await h.api.vault.put(audioEventKey,audioEvent);await h.api.vault.put(`media:${audioMediaId}`,audioMedia);
  await h.api.vault.put(`media-binary:${audioMediaId}`,{bytes:new Uint8Array([1,2,3])});
  await h.api.vault.put(`conversation:${conversation.conversation_id}`,conversation);
  conversation=(await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  latest=conversation.turns.find(turn=>turn.turn_id===latest.turn_id);
  assert.equal(latest.source_kind,'audio_transcript');
  const followed=conversation.turns.filter(turn=>turn.role==='elder'&&!turn.superseded).at(-2);
  const replyCountBeforeCorrection=h.replyCount;
  const turnsBefore=plain(conversation.turns),reportBefore=plain(conversation.report),reportHistoryBefore=plain(conversation.report_history||[]);
  const sourceEventBefore=plain(await h.api.vault.get(audioEventKey));
  const correction=await h.api.request(`/api/conversations/${conversation.conversation_id}/turns/${source.turn_id}`,{method:'POST',
    body:JSON.stringify({text:'合成测试更正原话：手腕偶尔酸。',expected_version:source.version,expected_conversation_version:conversation.version})});
  assert.equal(correction.r.status,409,JSON.stringify(correction.j));
  assert.equal(correction.j.error,'turn_not_latest');
  assert.equal(h.replyCount,replyCountBeforeCorrection,'a rejected older-turn edit must not reach the reply service');
  const reopened=(await h.request(`/api/conversations/${conversation.conversation_id}`)).j.conversation;
  assert.equal(reopened.version,conversation.version);
  assert.deepEqual(plain(reopened.turns),turnsBefore,'all later original messages and quote snapshots remain unchanged');
  assert.deepEqual(plain(reopened.report),reportBefore);
  assert.deepEqual(plain(reopened.report_history||[]),reportHistoryBefore);
  assert.deepEqual(plain(await h.api.vault.get(audioEventKey)),sourceEventBefore,'the original event remains unchanged');
  assert.equal(reopened.turns.find(turn=>turn.turn_id===latest.turn_id).quote_context_valid,true);
  assert.equal(reopened.turns.find(turn=>turn.turn_id===latest.turn_id).quote_context.turn_id,followedAssistant.turn_id);
  assert.equal(reopened.turns.find(turn=>turn.turn_id===followed.turn_id).quote_context_valid,true);
});

test('assistant result is discarded if a quoted audio source event or original changes while the reply is pending',async()=>{
  for(const changed of ['event','media']){
    const h=await harness(),{conversation,elder,event,media}=await seedAudioQuote(h),assistantCount=conversation.turns.filter(turn=>turn.role==='assistant').length;
    h.setBeforeReply(async()=>{
      if(changed==='event')await h.api.vault.put(`event:${event.record_id}`,{...event,version:event.version+1});
      else await h.api.vault.put(`media:${media.media_id}`,{...media,version:media.version+1});
    });
    const result=await h.api.request(`/api/conversations/${conversation.conversation_id}/turns`,{method:'POST',
      headers:{'Idempotency-Key':webcrypto.randomUUID()},body:JSON.stringify({text:'完全虚构：请解释这段录音。',expected_version:conversation.version,
        quote_ref:{turn_id:elder.turn_id,version:elder.version}})});
    assert.equal(result.r.status,201,JSON.stringify(result.j));assert.equal(result.j.result_discarded,true,changed);
    assert.equal(result.j.conversation.turns.filter(turn=>turn.role==='assistant').length,assistantCount,changed);
    assert.equal(result.j.conversation.turns.filter(turn=>turn.role==='elder').at(-1).text,'完全虚构：请解释这段录音。');
  }
});

test('quote preview places shortcuts in a separate two-column row and hides the version label',()=>{
  assert.match(markup,/<section id="voiceFollowupReference"[\s\S]*?<div class="voice-quote-copy">[\s\S]*?<div id="voiceQuoteShortcuts"[\s\S]*?<button id="cancelVoiceFollowupBtn"/);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../frontend/app.js'),'utf8'),/\$\{quote\}（第 \$\{pendingFollowupTarget\.version\} 版）/);
  const styles=fs.readFileSync(require.resolve('../frontend/styles.css'),'utf8');
  assert.match(styles,/\.voice-followup-reference\s*\{[^}]*display:\s*grid/s);
  assert.match(styles,/\.voice-quote-shortcuts\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles,/\.voice-quote-shortcuts button\s*\{[^}]*min-height:\s*44px/s);
});

test('late historical reads cannot replace a newer chat or cross a subject switch',async()=>{
  const active={conversation_id:'old',subject_id:'subject_self',status:'paused',version:3,turns:[]};
  const pending=new Map(),elements=new Map(),apiPaths=[];
  const element=id=>{if(!elements.has(id))elements.set(id,{disabled:false,classList:{add(){},remove(){}}});return elements.get(id)};
  let context;
  context=vm.createContext({
    conversationLoadSequence:0,conversationLoading:false,localMode:true,activeHealthSubjectId:'subject_self',healthSubjectsVersion:1,healthSubjectUiEpoch:1,
    healthSubjectSwitchBusy:false,healthSubjectChanged:false,activeConversation:active,pendingAudioReview:null,pendingAudioReviewCandidates:[],pendingAudioRecoveryRequestId:0,
    $:element,document:{querySelector:()=>({id:'voiceView'})},async ensureHealthSubjectReady(){return true},setVoiceComposerEnabled(){},renderVoiceConversation(){},renderConversationReport(){},
    setVoiceStatus(){},syncConversation(value){context.activeConversation=value;return true},
    api(path){apiPaths.push(path);const id=decodeURIComponent(path.split('/').at(-1));return new Promise(resolve=>pending.set(id,resolve))},
  });
  const start=appSource.indexOf('async function loadConversation('),end=appSource.indexOf('function showHistoricalConversation(',start);
  vm.runInContext(appSource.slice(start,end),context);
  const readA=context.loadConversation('conversation_A');await new Promise(setImmediate);
  const readB=context.loadConversation('conversation_B');await new Promise(setImmediate);
  pending.get('conversation_B')({r:{ok:true,status:200},j:{conversation:{conversation_id:'conversation_B',subject_id:'subject_self',status:'paused',version:1,turns:[]}}});
  assert.equal(await readB,true);
  pending.get('conversation_A')({r:{ok:true,status:200},j:{conversation:{conversation_id:'conversation_A',subject_id:'subject_self',status:'paused',version:1,turns:[]}}});
  assert.equal(await readA,false);
  assert.equal(context.activeConversation.conversation_id,'conversation_B');

  const readOtherOwner=context.loadConversation('conversation_A');await new Promise(setImmediate);
  context.activeHealthSubjectId='subject_family';context.healthSubjectsVersion++;context.healthSubjectUiEpoch++;
  pending.get('conversation_A')({r:{ok:true,status:200},j:{conversation:{conversation_id:'conversation_A',subject_id:'subject_self',status:'paused',version:1,turns:[]}}});
  assert.equal(await readOtherOwner,false);
  assert.equal(context.activeConversation.conversation_id,'conversation_B');
  assert.deepEqual(apiPaths,['/api/conversations/conversation_A','/api/conversations/conversation_B','/api/conversations/conversation_A']);
  assert.doesNotMatch(apiPaths.join('\n'),/\/current|\/start|resume-assistant/,'opening a historical card only reads its exact conversation ID');
});

test('the new chat entry still exposes the existing conversation-detail deletion route',()=>{
  assert.match(markup,/id="openConversationDetailBtn"[^>]*>记录详情/);
  assert.match(appSource,/openConversationDetailBtn[^\n]*showConversationDetail\(activeConversation\.conversation_id\)/);
  assert.match(appSource,/id="deleteConversationDetailBtn"[^>]*>删除这条完整对话/);
});
