// Synthetic HTTP responses + encrypted MemoryDocumentStore / VM UI only.
// No microphone, real provider, ASR accuracy or clinical validation evidence.
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js'), safety = require('../frontend/safety.js');
const appSource = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
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
  const start=async()=>(await request('/api/conversations/start',{mode:'new',local_date:'2026-10-09'})).j.conversation;
  const audio=async c=>{const m={media_id:'media_'+webcrypto.randomUUID().replaceAll('-',''),kind:'audio',content_type:'audio/wav',original_filename:'synthetic.wav',temporary:true,conversation_id:c.conversation_id,save_status:'saved',recognition_status:'not_started',link_status:'not_linked',version:1};await api.vault.put('media:'+m.media_id,m);await api.vault.putBinary('media-binary:'+m.media_id,new Uint8Array([1,2,3,4]).buffer);return m};
  const recognize=async m=>{await request('/api/media/'+m.media_id+'/recognize',{});for(let i=0;i<100;i++){const saved=(await request('/api/media/'+m.media_id)).j.media;if(saved.recognition_status!=='processing'&&saved.conversation_turn_id)return saved;await new Promise(r=>setTimeout(r,3))}throw Error('synthetic recognition did not settle')};
  const get=async c=>(await request('/api/conversations/'+c.conversation_id)).j.conversation;
  return {api,request,start,audio,recognize,get,calls,responses};
}
function appHarness(h,conversation) {
  const elements=new Map(), requests=[], originals=[];
  const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',disabled:false,classList:{add(){},remove(){}},querySelectorAll:()=>[],querySelector:()=>null});return elements.get(id)};
  const context=vm.createContext({activeConversation:conversation,conversationEditingTurnId:null,HealthLocal:h.api,
    $:el,document:{querySelector:()=>({id:'voiceView'})},api:async(path,options)=>{requests.push(path);return h.api.request(path,options)},
    syncConversation:c=>{context.activeConversation=c},setVoiceStatus:m=>{el('status').textContent=m},loadEvents(){},
    escapeHtml:text=>String(text??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    isMockContent:t=>t?.is_mock===true,mockWarning:'模拟内容',mockText:()=>false,mediaUnavailableMessage:'不可用',
    openOriginal:async(id,options)=>{originals.push({id,options});options.box.innerHTML='<audio controls src="blob:synthetic"></audio>';return true},
    conversationTurnTime:()=>'',console,
  });
  for(const [start,end] of [['function voiceTurnHtml(','function renderVoiceConversation('],['async function showVoiceMediaResult(','function prepareMediaRetry('],['function conversationTranscriptTurnHtml(','function conversationSafety(']])
    vm.runInContext(appSource.slice(appSource.indexOf(start),appSource.indexOf(end)),context);
  if(appSource.includes('async function showConversationOriginal(')) vm.runInContext(appSource.slice(appSource.indexOf('async function showConversationOriginal('),appSource.indexOf('function bindConversationSourceActions(')),context);
  return {context,requests,originals,el,run:code=>vm.runInContext(code,context)};
}
const text='合成测试：膝盖痛两天，晚上明显。';
const cloudCount=(h,path)=>h.calls.filter(call=>call.path===path).length;
test('ordinary ASR result display retains encrypted original until user pauses, with no automatic pause',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),app=appHarness(h,await h.get(c));app.context.media=recognized;
  await app.run('showVoiceMediaResult(media)');
  assert.equal(app.requests.some(path=>path.endsWith('/pause')),false,'showing a result must allow original comparison before explicit pause cleanup');
  assert.ok(await h.api.vault.get('media-binary:'+m.media_id)); assert.equal((await h.get(c)).status,'active');
  assert.equal(cloudCount(h,'/api/ai/media/recognize'),1);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);
  await h.request('/api/conversations/'+c.conversation_id+'/pause',{});assert.equal(await h.api.vault.get('media-binary:'+m.media_id),undefined,'explicit pause retains existing temporary cleanup');
});
test('showing an already linked nontemporary audio cannot pause or clear the current temporary recording',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));
  const recognized=await h.recognize(m),app=appHarness(h,await h.get(c));
  app.context.media={...recognized,temporary:false};
  await app.run('showVoiceMediaResult(media)');
  assert.equal(app.requests.some(path=>path.endsWith('/pause')),false);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
  assert.equal(cloudCount(h,'/api/ai/media/recognize'),1);assert.equal(cloudCount(h,'/api/ai/conversation-turn'),1);
});
test('current and archived ASR show unreviewed transcription, original and correction controls without treating mock as fact',()=>{
  const h={api:{}},turn={turn_id:'turn_synthetic',role:'elder',text:'<识别文字>',source_kind:'audio_transcript',media_id:'media_synthetic',record_id:'rec_synthetic',version:1};
  const app=appHarness(h,{turns:[turn]});app.context.turn=turn;
  const voice=app.run('voiceTurnHtml(turn)'),archive=app.run('conversationTranscriptTurnHtml(turn)');
  for(const html of [voice,archive]){assert.match(html,/识别文字.*请核对/);assert.match(html,/data-turn-original/);assert.match(html,/&lt;识别文字&gt;/)}
  assert.match(archive,/data-turn-source/);assert.match(voice,/data-voice-turn-edit/);
  app.context.turn={...turn,is_mock:true};assert.doesNotMatch(app.run('voiceTurnHtml(turn)'),/data-turn-original/);
});
test('original comparison reads only the selected saved audio and never recognition/model endpoints',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c),turn={turn_id:'turn_synthetic',role:'elder',source_kind:'audio_transcript',media_id:m.media_id,record_id:'rec_synthetic',version:1};
  const conversation={...c,turns:[turn]},app=appHarness(h,conversation),box=app.el('original');app.context.turn=turn;app.context.box=box;app.context.conversation=conversation;
  assert.equal(typeof app.context.showConversationOriginal,'function');await app.run('showConversationOriginal(turn,box,conversation)');
  assert.deepEqual(app.requests,['/api/media/'+m.media_id]);assert.equal(app.originals[0].id,m.media_id);assert.match(box.innerHTML,/<audio/);assert.equal(h.calls.length,0);
  await h.api.vault.remove('media:'+m.media_id);await app.run('showConversationOriginal(turn,box,conversation)');assert.match(box.textContent,/临时录音.*清理|原录音.*无法/);assert.equal(app.originals.length,1);
});
test('editing ASR sends current v2 text, synchronizes event/report sources, preserves raw v1 and original bytes',async()=>{
  const h=await localHarness(),c=await h.start(),m=await h.audio(c);h.responses.set('/api/ai/media/recognize',()=>({recognition:{text,is_mock:false}}));await h.recognize(m);
  const before=await h.get(c),turn=before.turns.find(t=>t.role==='elder'),corrected='合成测试：膝盖痛三天，其他变化不清楚。';
  h.responses.set('/api/ai/conversation-turn',body=>{const payload=JSON.parse(body),current=payload.turns.find(t=>t.turn_id===turn.turn_id);return{provider:'SyntheticMechanicalFixture',action:'reply',assistant_text:'已按您更正的原话保存。',completeness:{clinical_state:{main_complaint:{status:'known',summary:'膝盖痛三天',evidence_turn_ids:[current.turn_id],context_ids:[]},associated_symptoms:{status:'missing',summary:'',evidence_turn_ids:[],context_ids:[]}},contradictions:[],relevant_context_ids:[]}}});
  const x=await h.request('/api/conversations/'+c.conversation_id+'/turns/'+turn.turn_id,{text:corrected,expected_version:turn.version,expected_conversation_version:before.version});assert.equal(x.r.ok,true);
  const saved=x.j.conversation,current=saved.turns.find(t=>t.turn_id===turn.turn_id),payload=h.calls.filter(call=>call.path==='/api/ai/conversation-turn').at(-1).body;
  assert.equal(payload.turns.find(t=>t.turn_id===turn.turn_id).text,corrected);assert.equal(payload.turns.find(t=>t.turn_id===turn.turn_id).version,2);
  assert.equal(current.original_text,text);assert.equal(current.versions[0].text,text);assert.equal(current.version,2);
  assert.equal((await h.request('/api/events/'+turn.record_id)).j.event.raw_text,corrected);
  assert.ok(saved.report.source_versions.some(source=>source.turn_id===turn.turn_id&&source.version===2&&source.quote===corrected));assert.equal(saved.report.status,'auto_unreviewed');
  assert.match(saved.report.body,/是否同时出现其他身体变化/);assert.ok(await h.api.vault.get('media-binary:'+m.media_id));
});
function originalHarness({delayed=false,failNode=false}={}) {
  // Optional historical read is for red evidence only; no server/provider is started.
  const source=process.env.NORESET_TEST_ORIGINAL_BASELINE==='1'
    ?require('node:child_process').execFileSync('git',['show','cfa798b:frontend/media.js'],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8'})
    :fs.readFileSync(require.resolve('../frontend/media.js'),'utf8');
  const urls=new Map(),targets=new Map(),revoked=[],counts={created:0,paused:0,cleared:0,loaded:0};let release,reject;
  const box={isConnected:true,replaceChildren(node){this.node=node},append(){},textContent:''};
  const parent={contains:node=>node===box};
  const context=vm.createContext({originalUrls:urls,originalTargets:targets,mediaItems:[],URL:{revokeObjectURL:url=>revoked.push(url)},
    HealthLocal:{active:true,originalObjectUrl:()=>delayed?new Promise((r,j)=>{release=r;reject=j}):Promise.resolve('blob:synthetic-audio')},
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
  let release,active=true;const app=appHarness({api:{request:()=>new Promise(r=>release=r)}},{conversation_id:'conversation_synthetic'});
  const box={isConnected:true,textContent:'',closest:()=>({classList:{contains:()=>active}})};
  const turn={turn_id:'turn_synthetic',role:'elder',source_kind:'audio_transcript',media_id:'media_synthetic'};
  const pending=app.context.showConversationOriginal(turn,box,{conversation_id:'conversation_synthetic'});active=false;
  release({r:{ok:true},j:{media:{media_id:'media_synthetic',kind:'audio',conversation_id:'conversation_synthetic'}}});
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
