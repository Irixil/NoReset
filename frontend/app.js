let API = globalThis.BingliConfig?.apiBaseUrl || '';
let token = localStorage.getItem('session_token') || '', modelProvider = '', saveBusy = false;
let events = [], conversations = [], current = null, detailRequestSerial = 0, mediaRecorder = null, chunks = [], timerId = null, startedAt = 0, elapsedMs = 0, demoMode = false, localMode = Boolean(globalThis.HealthLocal), voicePermissionPending = false, voiceUploadPending = false;
let activeConversation = null, conversationLoading = false, conversationEditingTurnId = null, pendingConversationTurn = null, pendingMediaRetry = null, lastSpokenTurnId = null;
let voicePermissionGeneration = 0;
let cancelPendingMicrophone = null;
let silenceAudioContext = null, silenceAnalyser = null, silenceFrameId = null, silenceStartedAt = 0, speechDetected = false;
let reportReturnFocus = null, reportInertTargets = [], contextReturnFocus = null, contextInertTargets = [];
let healthContextEntries = [], contextDraftSelection = new Set(), contextPickerLoading = false, contextPickerLoadError = false, contextPickerRequestId = 0, contextSelectionSaving = false, voiceStatusCheckId = 0;
const handoffSelection=new Set(),knownHandoffEvents=new Set();
const DEMO_KEY = 'elder_demo_events_v1';
const PHOTO_KEY = 'elder_demo_photos_v1';
const $ = id => document.getElementById(id);
const views = [...document.querySelectorAll('.view')];
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)}
function reducedMotion(){return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true}
function reveal(element,titleSelector){if(!element)return;element.scrollIntoView?.({behavior:reducedMotion()?'auto':'smooth',block:'start'});element.querySelector?.(titleSelector)?.focus?.({preventScroll:true})}
function clearRecordPanels(){
  detailRequestSerial++;
  const detail=$('detail');if(detail){if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(detail);detail.classList.add('hidden');detail.innerHTML=''}
  const detailTitle=$('detailPageTitle');if(detailTitle)detailTitle.textContent='记录详情';
  const handoff=$('handoff');if(handoff){handoff.classList.add('hidden');handoff.innerHTML=''}
  const banner=$('dangerBanner');if(banner){banner.classList.add('hidden');banner.innerHTML=''}
  current=null;
}
function showView(id){
  const recordingActive=mediaRecorder?.state==='recording';
  const leavingConversation=document.querySelector?.('.view.active')?.id==='voiceView'&&id!=='voiceView';
  if(id!=='voiceView'&&(recordingActive||voicePermissionPending||voiceUploadPending)){toast(voicePermissionPending?'正在等待麦克风权限，请稍候':'正在录音或保留原件，请稍候');reveal($('voiceView'),'h1');return false}
  const previousView=document.querySelector?.('.view.active');if(previousView?.id!==id&&typeof releaseOriginalsIn==='function')releaseOriginalsIn(previousView);
  if(leavingConversation)void pauseConversation();
  // Clear record-specific panels whenever navigation starts so an older event
  // cannot leak into the next screen or appear as the newly selected record.
  clearRecordPanels();
  views.forEach(v=>{const active=v.id===id;v.classList.toggle('active',active);v.setAttribute?.('aria-hidden',String(!active))});
  document.querySelector?.('.app-shell')?.classList.toggle('conversation-active',id==='voiceView');
  document.querySelectorAll('[data-view]').forEach(b=>{
    const active=b.dataset.view===(id==='recordDetailView'?'recordsView':id);b.classList.toggle('active',active);
    if(b.classList.contains('nav-item'))active?b.setAttribute?.('aria-current','page'):b.removeAttribute?.('aria-current');
  });
  window.scrollTo({top:0,behavior:reducedMotion()?'auto':'smooth'});
  const activeView=views.find(v=>v.id===id);activeView?.querySelector?.('h1')?.focus?.({preventScroll:true});
  if(id==='recordsView')loadEvents();if(id==='homeView')renderHome();if(id==='settingsView'){refreshStorageStatus();void loadHealthContext()}if(id==='voiceView'){void loadConversation();void refreshVoiceOnlineStatus()}if(['photoCaptureView','archiveView'].includes(id)&&typeof refreshMediaOnlineStatus==='function')void refreshMediaOnlineStatus();return true
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{
  // Media entry buttons are disabled after capability discovery when the
  // running instance cannot safely accept uploads.  Keep the guard here as
  // well as the DOM disabled state because some touch/browser shims still
  // dispatch a click for a disabled button.
  if(b.disabled)return;
  showView(b.dataset.view)
}));
async function health(){
  if(localMode){
    await globalThis.HealthLocal.initialise();
    try{const r=await fetch(API+'/health',{credentials:'include'});const j=await r.json();modelProvider=r.ok?j.provider:'';}catch{modelProvider='';}
    demoMode=false;setModeLabel();return true;
  }
  try {
    const r=await fetch(API+'/health',{credentials:'include'}); const j=await r.json();
    if(!r.ok || !j.ok || !j.session_token) throw new Error('backend unavailable');
    token=j.session_token; modelProvider=j.provider; demoMode=false; setModeLabel(); return true;
  } catch { demoMode=true; setModeLabel(); return false; }
}
function setModeLabel(){
  const p=$('modePill'); if(p)p.textContent=localMode?'本机加密保存':demoMode?'服务未连接 · 请重试':modelProvider==='mock'?'在线服务尚未接通':'本机记录中';
}
function capabilityStatusText(capability){
  if(!capability)return '状态暂不可确认';
  if(['provider_mock','provider_not_configured','provider_configuration_missing_or_invalid','provider_configuration_invalid','media_configuration_invalid'].includes(capability.reason))return '尚未接通';
  if(capability.available)return '已配置，连接待验证';
  return ({network_unavailable:'网络暂不可用',session_unavailable:'需要重新连接',configuration_missing:'尚未接通',provider_invalid:'尚未接通'})[capability.reason]||'暂不可用';
}
function mockText(value){return typeof value==='string'&&/^\s*\[Mock (?:ASR|OCR)\]/i.test(value)}
function isMockContent(value){
  if(!value||typeof value!=='object')return mockText(value);
  const provider=value.provider||value.last_ai_metadata?.provider||value.recognition?.provider;
  return value.is_mock===true||value.mock_source===true||value.recognition?.is_mock===true||/mock/i.test(String(provider||''))||mockText(value.text)||mockText(value.raw_text)||mockText(value.recognition?.text);
}
const mockWarning='这是历史模拟识别结果，不是患者原话；不会当作事实。若有原录音，可查看原件；请直接输入真实情况。';
const mediaUnavailableMessage='语音转文字尚未接通；录音已保存。您可以直接打字继续，服务接通后再重试。';
async function refreshVoiceOnlineStatus(){
  const status=$('voiceOnlineStatus');if(!status)return;
  const requestId=++voiceStatusCheckId;status.textContent='正在检查联网文字、语音和照片功能；原话先保存在本机。';
  if(typeof globalThis.HealthLocal?.onlineStatus!=='function'){
    status.textContent=modelProvider==='mock'?'文字回复尚未接通；语音转文字尚未接通；图片识别尚未接通。原话和原件可先保存在本机。':'联网状态暂时无法确认；原话和原件仍可保存在本机。';return;
  }
  try{
    const result=await globalThis.HealthLocal.onlineStatus();if(requestId!==voiceStatusCheckId)return;
    const provider=result?.provider||modelProvider;
    const mockProvider=provider==='mock';
    if(!mockProvider&&result?.text_ai?.available===true&&result?.audio_recognition?.available===true&&result?.image_recognition?.available===true){
      status.textContent='原话会先保存在本机；语音识别和回复需要联网。';return;
    }
    const conversation=mockProvider?'尚未接通':capabilityStatusText(result?.text_ai);
    const audio=capabilityStatusText(result?.audio_recognition),image=capabilityStatusText(result?.image_recognition);
    status.textContent=`文字回复${conversation}；语音转文字${audio}；图片识别${image}。识别或回复失败时，原话和原件可先保存在本机。`;
  }catch{
    if(requestId===voiceStatusCheckId)status.textContent='联网能力暂时无法确认；这不影响本机保存原话和照片原件。';
  }
}
async function api(path,opt={},retried=false){
  if(opt.method==='POST'&&/^\/api\/conversations\/[^/]+\/(?:pause|finish)$/.test(path)&&typeof releaseOriginalsIn==='function')releaseOriginalsIn($('voiceConversationTurns'));
  if(localMode)return globalThis.HealthLocal.request(path,opt);
  const h={...(opt.body instanceof FormData ? {} : {'Content-Type':'application/json'}),...(opt.headers||{})};
  if(token)h['X-Session-Token']=token;
  try {
    const r=await fetch(API+path,{...opt,credentials:'include',headers:h}); let j={}; try{j=await r.json()}catch{}
    // Restart rotates the local session token. A rejected request has no side effect.
    if(r.status===403 && j.error==='csrf_or_origin_rejected' && !retried && await health())return api(path,opt,true);
    return {r,j};
  } catch { demoMode=true; setModeLabel(); return {r:{ok:false,status:0},j:{}}; }
}
async function refreshRuntimeConfiguration(){
  try{
    const response=await fetch(`/runtime-config.js?reconnect=${Date.now()}`,{cache:'no-store',credentials:'same-origin'});
    if(!response.ok)return false;
    const source=await response.text(),match=source.match(/globalThis\.__BINGLI_CONFIG__\s*=\s*(\{[^;]*\})\s*;/);
    if(!match)return false;
    const injected=JSON.parse(match[1]),hostname=String(location.hostname||''),protocol=String(location.protocol||'http:');
    const localFrontend=['127.0.0.1','localhost'].includes(hostname)&&String(location.port||'')==='5173';
    const candidate=typeof injected.apiBaseUrl==='string'&&injected.apiBaseUrl.trim()?injected.apiBaseUrl.trim():(localFrontend?`${protocol}//${hostname}:18768`:'');
    let nextApi='';
    if(candidate){const parsed=new URL(candidate,location.origin||undefined);if(!['http:','https:'].includes(parsed.protocol))return false;nextApi=parsed.href.replace(/\/$/,'')}
    API=nextApi;
    globalThis.BingliConfig=Object.freeze({apiBaseUrl:nextApi,apiUrl(path){const suffix=String(path||'');if(!suffix.startsWith('/'))throw new TypeError('api_path_must_start_with_slash');return `${nextApi}${suffix}`}});
    if(typeof refreshVoiceOnlineStatus==='function')void refreshVoiceOnlineStatus();
    if(typeof refreshMediaOnlineStatus==='function')void refreshMediaOnlineStatus();
    return true;
  }catch{return false}
}
window.addEventListener?.('online',refreshRuntimeConfiguration);
function safetyHtml(s){
  let html='';
  if(s?.danger_detected)html+=`<p class="status error">${s.historical_notice_preserved?'历史记录曾触发提醒：':''}${escapeHtml(s.danger_reminder||'请联系当地急救服务或专业人员，不要自行改药。')}</p>`;
  if(s?.clinical_review_required)html+=`<p class="status error">${escapeHtml(s.clinical_review_notice||'这条记录需要专业人员复核，记录核对不能消除待办。')}</p>`;
  return html;
}
function safetyBanner(s){const b=$('dangerBanner');if(!b)return;if(s?.danger_detected||s?.reviewed_risk_notice){b.innerHTML=`<b>${s?.reviewed_risk_level==='soon_evaluation'?'需要尽快评估':'需要及时关注'}</b><br>${escapeHtml(s.reviewed_risk_notice||s.danger_reminder||'记录中出现需要尽快请专业人员判断的描述，请联系当地急救服务或专业人员。')}`;b.classList.remove('hidden')}else b.classList.add('hidden')}
function stateLabel(s){return ({inbox:'已保存，待整理',draft:'整理草稿，待核对',needs_review:'退回待整理',recorded:'已核对记录准确',superseded:'旧版本'})[s]||'状态待确认'}
const EVENT_KIND_LABELS={symptom:'症状记录',measurement:'指标记录',medication:'用药记录',instruction:'医嘱或建议',document:'资料记录',question:'待核对问题',handoff:'交接记录',other:'其他记录'};
const REVIEW_ROLE_LABELS={none:'暂未指定',family:'家属或照护者',clinician_or_pharmacist:'医生、护士或药师',emergency_services:'急救服务或专业人员'};
const ESCALATION_LABELS={none:'常规核对',urgent:'尽快核对',emergency:'需要及时关注'};
const CERTAINTY_LABELS={exact:'具体时间',range:'时间范围',daypart:'时段',relative:'原话中的相对时间',unknown:'时间未说明'};
const SOURCE_KIND_LABELS={elder:'老人自述',family_observation:'家属观察',family_report:'家属转述',caregiver:'照护员记录',clinician_evidence:'医生或药师资料',document:'资料摘要',audio_transcript:'录音转写',system:'系统记录',unknown:'来源未标明'};
const MEDIA_KIND_LABELS={audio:'录音原件',image:'照片原件'};
const SAVE_STATUS_LABELS={uploading:'上传中，原件尚未保存完整',saved:'原件已保存',failed:'原件保存失败'};
const RECOGNITION_LABELS={not_started:'待识别',processing:'识别处理中',succeeded:'文字已识别',failed:'识别失败',interrupted:'识别中断'};
const LINK_LABELS={not_linked:'尚未关联记录',pending:'关联处理中',linked:'已关联记录',link_failed:'关联失败'};
function dateText(v){return v?new Date(v).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):''}
function localDateText(value){const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return match?`${Number(match[2])}月${Number(match[3])}日`:dateText(value)}
function liveArchiveTurns(conversation){return (conversation?.turns||[]).filter(turn=>!turn.superseded)}
function elderArchiveTurns(conversation){return liveArchiveTurns(conversation).filter(turn=>turn.role==='elder')}
function conversationRecordIds(conversation){return elderArchiveTurns(conversation).filter(turn=>!isMockContent(turn)).map(turn=>turn.record_id).filter(Boolean)}
function conversationDateLabel(conversation){const start=conversation?.local_date,end=conversation?.last_local_date||start;return start&&end&&start!==end?`${localDateText(start)}—${localDateText(end)}`:localDateText(end||start)}
function conversationStatusLabel(status){return ({active:'继续记录中',paused:'已暂停',finished:'已结束'})[status]||'已保存'}
function shorten(text,limit=128){const value=String(text||'').replace(/\s+/g,' ').trim();return value.length>limit?value.slice(0,limit-1)+'…':value}
function conversationSummary(conversation){
  const reportLines=(conversation?.report?.sections||[]).filter(section=>section.key!=='verification').flatMap(section=>section.lines||[]).filter(line=>line?.text&&!isMockContent(line)&&!mockText(line.text)).map(line=>line.text);
  const fallback=elderArchiveTurns(conversation).filter(turn=>!isMockContent(turn)).map(turn=>turn.text);
  return shorten([...new Set(reportLines.length?reportLines:fallback)].slice(0,3).join('；'))||(elderArchiveTurns(conversation).some(isMockContent)?'含有历史模拟识别文字，仅保留展示，不作为患者事实。':'这次对话已完整保留。');
}
function conversationLinkedRecordIds(){return new Set(conversations.flatMap(conversationRecordIds))}
function standaloneEvents(){const linked=conversationLinkedRecordIds();return events.filter(event=>event.state!=='superseded'&&!linked.has(event.record_id))}
function recentRecordItems(){
  return [
    ...conversations.filter(conversation=>elderArchiveTurns(conversation).length).map(conversation=>({type:'conversation',id:conversation.conversation_id,at:conversation.updated_at||`${conversation.last_local_date||conversation.local_date}T12:00:00`,date:`${conversationDateLabel(conversation)} · 完整对话`,text:conversationSummary(conversation)})),
    ...standaloneEvents().map(event=>({type:'event',id:event.record_id,at:event.recorded_at,date:`${dateText(event.recorded_at)} · 单独记录${isMockContent(event)?' · 模拟内容':''}`,text:isMockContent(event)?'模拟识别结果，仅保留历史展示，不作为患者事实。':event.raw_text})),
  ].sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
}
function renderRecentRecords(box,limit=3){
  if(!box)return;
  const items=recentRecordItems().slice(0,limit);
  box.innerHTML=items.length?items.map(item=>`<button class="recent-item" ${item.type==='conversation'?`data-conversation-id="${escapeHtml(item.id)}"`:`data-id="${escapeHtml(item.id)}"`}><span class="date">${escapeHtml(item.date)}</span><p>${escapeHtml(item.text)}</p></button>`).join(''):'<p class="muted">还没有健康记录</p>';
  box.querySelectorAll('[data-conversation-id]').forEach(button=>button.onclick=()=>showConversationDetail(button.dataset.conversationId));
  box.querySelectorAll('[data-id]').forEach(button=>button.onclick=()=>showDetail(button.dataset.id));
}
function renderArchive(){
  const ebox=$('archiveEvents'); if(!ebox)return;
  $('archiveEventCount').textContent=recentRecordItems().length;
  renderRecentRecords(ebox);
}
function latestFirst(items){return items.slice().sort((a,b)=>{const at=Date.parse(a.recorded_at||a.created_at||a.updated_at||'')||0;const bt=Date.parse(b.recorded_at||b.created_at||b.updated_at||'')||0;return bt-at||String(b.record_id||b.media_id||'').localeCompare(String(a.record_id||a.media_id||''))})}
function renderHome(){renderRecentRecords($('homeRecent'))}
function filteredRecords(){
  const keyword=$('filterKeyword')?.value.trim().toLowerCase()||'',kind=$('filterKind')?.value||'',state=$('filterState')?.value||'',start=$('filterStart')?.value?Date.parse($('filterStart').value+'T00:00:00'):null,end=$('filterEnd')?.value?Date.parse($('filterEnd').value+'T23:59:59.999'):null;
  const dateMatches=at=>(!start||at>=start)&&(!end||at<=end);
  const conversationItems=conversations.filter(conversation=>{
    const at=Date.parse(`${conversation.last_local_date||conversation.local_date}T12:00:00`),haystack=`${isMockContent(conversation.report?.body)?'':conversation.report?.body||''} ${liveArchiveTurns(conversation).filter(turn=>!isMockContent(turn)).map(turn=>turn.text).join(' ')}`.toLowerCase();
    return (!keyword||haystack.includes(keyword))&&(!kind||kind==='conversation')&&(!state||conversation.status===state)&&dateMatches(at);
  });
  const eventItems=latestFirst(standaloneEvents()).filter(event=>{
    const at=Date.parse(event.recorded_at),haystack=isMockContent(event)?'':`${event.raw_text||''} ${event.draft?.summary||''}`.toLowerCase();
    return (!keyword||haystack.includes(keyword))&&(!kind||(kind!=='conversation'&&event.draft?.event_kind===kind))&&(!state||event.state===state)&&dateMatches(at);
  });
  return {conversationItems,eventItems};
}
function renderFilterStatus(count){const status=$('filterResultsStatus');if(!status)return;const active=['filterKeyword','filterKind','filterState','filterStart','filterEnd'].some(id=>$(id)?.value);status.textContent=active?`找到 ${count} 份符合条件的记录。`:`共有 ${count} 份健康记录。`}
function renderList(){
  const box=$('eventsList');if(!box)return;
  const {conversationItems,eventItems}=filteredRecords(),count=conversationItems.length+eventItems.length;renderFilterStatus(count);
  if(!count){box.innerHTML=`<p class="muted">${conversations.length||events.some(event=>event.state!=='superseded')?'没有符合当前筛选的记录，请换个关键词。':'还没有记录，先说下第一次情况吧。'}</p>`;return}
  box.innerHTML='';
  conversationItems.forEach(conversation=>{
    const recordIds=conversationRecordIds(conversation),key=`conversation:${conversation.conversation_id}`;
    if(!knownHandoffEvents.has(key)){knownHandoffEvents.add(key);recordIds.forEach(recordId=>handoffSelection.add(recordId))}
    const n=document.importNode($('conversationRecordTpl').content,true),elderTurns=elderArchiveTurns(conversation);
    n.querySelector('.event-date').textContent=`${conversationStatusLabel(conversation.status)} · 老人说了 ${elderTurns.filter(turn=>!isMockContent(turn)).length} 段`;
    n.querySelector('.conversation-record-title').textContent=`${conversationDateLabel(conversation)}的健康对话`;
    n.querySelector('.event-raw').textContent=conversationSummary(conversation);
    const factualTurns=elderTurns.filter(turn=>!isMockContent(turn)),danger=factualTurns.some(turn=>turn.local_safety?.danger_detected),review=factualTurns.some(turn=>turn.local_safety?.clinical_review_required);
    const hasMock=elderTurns.some(isMockContent);n.querySelector('.badges').innerHTML='<span class="badge">完整对话已保留</span>'+(hasMock?'<span class="badge warn">含模拟文字，不作患者事实</span>':'')+(danger?'<span class="badge warn">需要关注</span>':'')+(review?'<span class="badge warn">待专业复核</span>':'');
    const checkbox=n.querySelector('.handoff-select');if(checkbox){checkbox.disabled=!recordIds.length;checkbox.checked=recordIds.length>0&&recordIds.every(recordId=>handoffSelection.has(recordId));checkbox.onchange=()=>recordIds.forEach(recordId=>checkbox.checked?handoffSelection.add(recordId):handoffSelection.delete(recordId))}
    n.querySelector('.view-btn').onclick=()=>showConversationDetail(conversation.conversation_id);
    const deleteButton=n.querySelector('.record-delete-btn');if(deleteButton){deleteButton.hidden=!localMode;deleteButton.onclick=()=>deleteConversation(conversation,deleteButton)}
    box.appendChild(n);
  });
  eventItems.forEach(event=>{
    if(!knownHandoffEvents.has(event.record_id)){knownHandoffEvents.add(event.record_id);handoffSelection.add(event.record_id)}
    const mock=isMockContent(event),n=document.importNode($('eventTpl').content,true);n.querySelector('.event-date').textContent=`${dateText(event.recorded_at)} · ${documentNeedsReview(event)?'照片文字待核对':stateLabel(event.state)}`;n.querySelector('.event-raw').textContent=mock?'模拟识别结果仅保留历史展示，不作为患者事实。':event.raw_text;n.querySelector('.badges').innerHTML='<span class="badge">单独记录</span>'+(mock?'<span class="badge warn">模拟识别，不是患者原话</span>':'')+(!mock&&!documentNeedsReview(event)&&event.local_safety?.danger_detected?'<span class="badge warn">需要关注</span>':'')+(!mock&&!documentNeedsReview(event)&&event.local_safety?.clinical_review_required?'<span class="badge warn">待专业复核</span>':'');
    const checkbox=n.querySelector('.handoff-select');if(checkbox){checkbox.disabled=mock;checkbox.checked=!mock&&handoffSelection.has(event.record_id);checkbox.onchange=()=>checkbox.checked?handoffSelection.add(event.record_id):handoffSelection.delete(event.record_id)}
    n.querySelector('.view-btn').onclick=()=>showDetail(event.record_id);
    const deleteButton=n.querySelector('.record-delete-btn');if(deleteButton){deleteButton.hidden=!localMode;deleteButton.onclick=()=>deleteRecord(event,deleteButton)}
    box.appendChild(n);
  });
}
function applyRecordFilters(event){event?.preventDefault();renderList();const box=$('eventsList');box?.focus?.({preventScroll:true});box?.scrollIntoView?.({behavior:'smooth',block:'start'})}
function clearRecordFilters(){const form=$('recordFilters');if(form?.reset)form.reset();else for(const id of ['filterKeyword','filterKind','filterState','filterStart','filterEnd'])$(id).value='';renderList();$('filterKeyword')?.focus?.()}
async function loadEvents(){
  const [{r,j},conversationResult]=await Promise.all([api('/api/events'),api('/api/conversations')]);
  if(r.ok){demoMode=false;events=j.events||[];conversations=conversationResult.r.ok?conversationResult.j.conversations||[]:[];setModeLabel();renderList();renderHome();renderArchive();return true;}
  demoMode=true;setModeLabel();
  const message='<div class="load-error" role="status"><b>记录暂时无法读取</b><span>请恢复连接后重试；已保存内容不会删除。</span><button class="outline" type="button" data-retry-events>重新读取</button></div>';
  for(const id of ['homeRecent','eventsList','archiveEvents']){const box=$(id);if(!box)continue;box.innerHTML=message;box.querySelectorAll?.('[data-retry-events]').forEach(button=>button.onclick=loadEvents)}
  toast('记录暂时无法读取，请恢复连接后重试');return false;
}
function setVoiceStatus(text,tone=''){
  const status=$('voiceConversationStatus');if(!status)return;
  status.textContent=text;status.className='conversation-status'+(tone?' '+tone:'');
}
function setVoiceComposerEnabled(enabled){
  if(activeConversation?.trial_control&&activeConversation.trial_control.state!=='completed')enabled=false;
  const input=$('voiceTextInput'),send=$('voiceTextSend');
  if(input)input.disabled=!enabled;if(send)send.disabled=!enabled||!input?.value.trim();
}
function trialVoiceMessage(control){
  return control?.state==='review_required'?'语音已转成文字，原话和录音已保留。请对照录音核对文字，等待本次试验批准后再继续一次。':control?.state==='completed'?'语音和本次回复已保存；下一段语音仍会先暂停核对。':control?.state==='continuing'?'这次回复已提交，原话和录音已保留。请等结果；重新进入不会再次发送。':'本次语音试验已停止，原话和录音已保留；请等待新的明确处理安排。';
}
async function continueTrialVoice(){
  const control=activeConversation?.trial_control;
  if(saveBusy||conversationEditingTurnId||control?.state!=='review_required')return false;
  saveBusy=true;renderVoiceConversation();setVoiceStatus('正在检查并提交本次回复…');
  try{
    const x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/trial-continue`,{method:'POST',body:JSON.stringify({expected_version:activeConversation.version,turn_id:control.turn_id,turn_version:control.turn_version})});
    if(x.j.conversation)syncConversation(x.j.conversation,{speak:x.r.ok&&!x.j.ai_failed});
    setVoiceStatus(trialVoiceMessage(activeConversation?.trial_control),x.j.ai_failed||!x.r.ok?'error':'ok');
    return x.r.ok&&!x.j.ai_failed;
  }catch{setVoiceStatus('本次回复未完成，原话和录音已保留；重新进入不会再次发送。','error');return false}
  finally{saveBusy=false;renderVoiceConversation();setVoiceComposerEnabled(true)}
}
async function showConversationOriginal(turn,box,conversation){
  if(!box||turn?.source_kind!=='audio_transcript'||!turn.media_id||isMockContent(turn))return false;
  box.textContent='正在读取本机原录音…';
  try{
    const x=await api('/api/media/'+encodeURIComponent(turn.media_id));
    if(!box.isConnected&&box.isConnected!==undefined)return false;
    const view=box.closest?.('.view');if(view&&!view.classList.contains('active'))return false;
    if(!x.r.ok||!x.j.media){box.textContent='这份临时录音已清理或暂时无法读取；识别文字与修改历史仍保留。';return false}
    const media=x.j.media;
    if(media.media_id!==turn.media_id||media.kind!=='audio'||(media.conversation_id&&media.conversation_id!==conversation?.conversation_id)){
      box.textContent='原录音与这段原话的来源不一致，请重新打开当前记录。';return false;
    }
    return await openOriginal(turn.media_id,{box,media});
  }catch{box.textContent='原录音暂时无法读取；文字仍保留，可以稍后重新打开。';return false}
}
function bindConversationSourceActions(box,conversation){
  box.querySelectorAll('[data-turn-original]').forEach(button=>button.onclick=async()=>{
    const turn=(conversation?.turns||[]).find(item=>item.turn_id===button.dataset.turnOriginal&&item.role==='elder'&&!item.superseded);
    const target=button.closest('.chat-bubble')?.querySelector('.voice-audio-original');
    if(button.disabled||!turn||!target)return;button.disabled=true;
    try{await showConversationOriginal(turn,target,conversation)}finally{button.disabled=false}
  });
  box.querySelectorAll('[data-turn-source]').forEach(button=>button.onclick=()=>showDetail(button.dataset.turnSource));
}
function voiceTurnHtml(turn){
  const assistant=turn.role==='assistant'||turn.side==='assistant';
  const mock=isMockContent(turn);
  const avatar=assistant?'<img class="chat-avatar" src="assets/brand-mascot.png?v=20260930-real-acceptance-9" alt="" aria-hidden="true">':'';
  const editing=!assistant&&conversationEditingTurnId===turn.turn_id;
  const latestTurn=(activeConversation?.turns||[]).filter(item=>!item.superseded).at(-1);
  const canRetry=!activeConversation?.trial_control&&assistant&&turn.ai_failed&&latestTurn?.turn_id===turn.turn_id;
  let content='';
  if(editing){
    content=`<label class="chat-edit-label" for="voice-turn-${escapeHtml(turn.turn_id)}">修改刚才说的话</label><textarea id="voice-turn-${escapeHtml(turn.turn_id)}" class="chat-edit-textarea" data-voice-turn-input rows="4">${escapeHtml(turn.editText??turn.text??'')}</textarea><div class="chat-edit-actions"><button class="chat-action" type="button" data-voice-turn-save>保存修改</button><button class="chat-secondary-action" type="button" data-voice-turn-cancel>取消</button></div>${turn.editStatus?`<small class="chat-edit-error">${escapeHtml(turn.editStatus)}</small>`:''}`;
  }else{
    content=assistant&&turn.ai_failed?'<p>这次联网回复没有完成；刚才的原话和报告仍保存在本机。</p>':`<p>${escapeHtml(turn.text||'')}</p>`;
    if(mock)content=`<p class="mock-content-warning">${escapeHtml(mockWarning)}</p><p>${escapeHtml(turn.text||'')}</p>`;
    if(assistant){
      if(!mock&&canRetry)content+='<div class="chat-inline-actions"><button type="button" data-voice-retry>重试小零回复</button></div>';
      else if(!mock&&!turn.ai_failed)content+=`<div class="chat-inline-actions"><button type="button" data-voice-replay>再听一遍</button></div>`;
      if(['urgent','soon_evaluation'].includes(turn.action)&&!turn.ai_failed)content+='<small>固定安全提醒 · 不包含诊断或用药建议</small>';
    }else{
      const audio=turn.source_kind==='audio_transcript',source=mock?'模拟识别结果（非患者原话）':audio?'语音识别文字 · 请核对':'已加密保存在本机';
      content+=`<small>${escapeHtml(source)}${turn.version>1?` · 已修改，第 ${turn.version} 版`:''}</small>${mock?'':`<button class="chat-edit-link" type="button" data-voice-turn-edit>${audio?'修改识别文字':'修改'}</button>`}`;
      if(!mock&&audio&&turn.media_id)content+=`<button class="chat-edit-link" type="button" data-turn-original="${escapeHtml(turn.turn_id)}" data-voice-original="${escapeHtml(turn.media_id)}">对照原录音</button><div class="voice-audio-original" style="max-width:100%" aria-live="polite"></div>`;
    }
  }
  return `<article class="chat-turn ${assistant?'assistant-turn':'user-turn'}${turn.pending?' pending-turn':''}" data-voice-turn="${escapeHtml(turn.turn_id||'')}">${avatar}<div class="chat-bubble ${assistant?'assistant-bubble':'user-bubble'}${turn.error?' error-bubble':''}${editing?' editing-bubble':''}">${content}</div></article>`;
}
function renderVoiceConversation(){
  const box=$('voiceConversationTurns');if(!box)return;
  if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(box);
  const turns=(activeConversation?.turns||[]).filter(turn=>!turn.superseded);
  box.innerHTML=[...turns,pendingConversationTurn].filter(Boolean).map(voiceTurnHtml).join('');
  if(activeConversation?.trial_control){const control=activeConversation.trial_control;box.innerHTML+=`<div class="chat-turn"><div class="chat-bubble"><p>${escapeHtml(trialVoiceMessage(control))}</p>${control.state==='review_required'?`<button class="chat-action" type="button" data-trial-continue ${saveBusy?'disabled':''}>核对并获准后继续一次</button>`:''}</div></div>`;box.querySelector('[data-trial-continue]')?.addEventListener('click',continueTrialVoice)}
  box.querySelectorAll('[data-voice-turn-edit]').forEach(button=>button.onclick=()=>beginVoiceTurnEdit(button.closest('[data-voice-turn]')?.dataset.voiceTurn));
  box.querySelectorAll('[data-voice-turn-cancel]').forEach(button=>button.onclick=cancelVoiceTurnEdit);
  box.querySelectorAll('[data-voice-turn-save]').forEach(button=>button.onclick=()=>saveVoiceTurnEdit(button.closest('[data-voice-turn]')?.dataset.voiceTurn,button.closest('.chat-bubble')?.querySelector('[data-voice-turn-input]')?.value||''));
  bindConversationSourceActions(box,activeConversation);
  box.querySelectorAll('[data-voice-replay]').forEach(button=>button.onclick=()=>{const turn=turnById(button.closest('[data-voice-turn]')?.dataset.voiceTurn);if(turn)speakAssistant(turn,true)});
  box.querySelectorAll('[data-voice-retry]').forEach(button=>button.onclick=()=>retryConversationReply(button));
  const editingTurn=conversationEditingTurnId;
  (window.requestAnimationFrame||((fn)=>setTimeout(fn,0)))(()=>{
    if(editingTurn){
      box.querySelector('[data-voice-turn-input]')?.closest?.('[data-voice-turn]')?.scrollIntoView?.({block:'center',behavior:'auto'});
      return;
    }
    $('voiceConversation')?.scrollTo?.({top:$('voiceConversation').scrollHeight,behavior:reducedMotion()?'auto':'smooth'});
  });
}
function turnById(turnId){return activeConversation?.turns?.find(turn=>turn.turn_id===turnId&&!turn.superseded)}
function localDateValue(){
  const date=new Date(),offset=date.getTimezoneOffset()*60000;
  return new Date(date.getTime()-offset).toISOString().slice(0,10);
}
function renderConversationReport(){
  const report=activeConversation?.report,button=$('openConversationReportBtn'),body=$('conversationReportBody');
  if(button)button.disabled=!report;
  if(!body)return;
  if(!report){body.innerHTML='<p class="muted">说完第一句话后，这里会自动生成报告。</p>';return}
  $('conversationReportStatus').textContent=report.status_label||'自动整理 · 本人未核对';
  const transcript=(report.transcript||[]).filter(turn=>!isMockContent(turn));
  body.innerHTML=`<p class="report-reading-guide">按就诊时最常用的顺序整理，共保留 ${report.source_turn_ids?.length||0} 段患者原话。</p>`+(transcript.length!==(report.transcript||[]).length?'<p class="status error">历史模拟识别文字已从报告事实中排除，仅在完整对话历史中保留。</p>':'')+reportSectionsHtml(report)+`<details class="report-transcript"><summary>查看完整对话（${report.transcript?.length||0} 轮）</summary><ol>${(report.transcript||[]).map(turn=>`<li><span>${turn.role==='assistant'?'小零':'老人'}${isMockContent(turn)?' · 模拟内容，不是患者事实':''}</span><p>${escapeHtml(turn.text||'')}</p></li>`).join('')||`<li><p>${escapeHtml(isMockContent(report.body)?'历史报告内容无法确认来源，原始记录仍保留。':report.body||'')}</p></li>`}</ol></details><p class="report-source-note">第 ${report.version||1} 版 · 修改聊天原话后，这份记录会自动更新。关键事实始终以患者原话为准。</p>`;
}
function reportSectionsHtml(report){
  const sections=report?.sections||[];
  if(!sections.length)return isMockContent(report?.body)?'<p class="status error">历史报告含模拟识别内容，已从患者事实中排除。</p>':`<pre>${escapeHtml(report?.body||'')}</pre>`;
  return `<div class="clinical-report-sections">${sections.map(section=>`<section class="clinical-report-section" data-report-section="${escapeHtml(section.key||'record')}"><h3>${escapeHtml(section.title||'记录')}</h3><div class="report-fact-list">${(section.lines||[]).filter(line=>!isMockContent(line)&&!mockText(typeof line==='string'?line:line?.text)).map((line,index)=>reportFactHtml(line,index)).join('')}</div></section>`).join('')}</div>`;
}
function reportFactHtml(line,index){
  if(typeof line==='string')return `<div class="report-fact report-fact-check"><p>${escapeHtml(line)}</p></div>`;
  const tags=(line?.tags||[]).map(tag=>`<span>${escapeHtml(tag)}</span>`).join('');
  const sourceVersions=(Array.isArray(line?.source_versions)?line.source_versions:[]).filter(source=>Array.isArray(line?.source_turn_ids)&&typeof source?.turn_id==='string'&&source.turn_id.trim()&&line.source_turn_ids.includes(source.turn_id)&&Number.isSafeInteger(source.version)&&source.version>0&&typeof source.quote==='string'&&source.quote.trim());
  const sourceVersionLabel=source=>`原话第 ${source.version} 版${source.version>1?' · 已修订':''}`;
  const versionLabels=sourceVersions.map(source=>`<span class="report-source-version">${escapeHtml(sourceVersionLabel(source))}</span>`).join('');
  const source=line?.source_label||versionLabels?`<small>${line?.source_label?`<span>${escapeHtml(line.source_label)}</span>`:''}${versionLabels}</small>`:'';
  const evidence=sourceVersions.map(source=>`<details class="report-source-evidence" data-source-turn-id="${escapeHtml(source.turn_id)}"><summary>查看对应原话（${escapeHtml(sourceVersionLabel(source))}）</summary><blockquote>${escapeHtml(source.quote)}</blockquote></details>`).join('');
  const kind=['quote','context','alert','check'].includes(line?.kind)?line.kind:'check';
  const text=escapeHtml(line?.text||'');
  const content=kind==='quote'?`<blockquote>${text}</blockquote>`:`<p>${text}</p>`;
  return `<article class="report-fact report-fact-${kind}" data-report-line="${index+1}"><div class="report-fact-head">${tags?`<div class="report-fact-tags">${tags}</div>`:''}${source}</div>${content}${evidence}</article>`;
}
function syncConversation(conversation,{speak=true}={}){
  if(conversation?.trial_control&&conversation.trial_control.state!=='completed')voicePermissionGeneration++;
  if(pendingMediaRetry&&pendingMediaRetry.conversation_id!==conversation?.conversation_id)pendingMediaRetry=null;
  activeConversation=conversation;conversationEditingTurnId=null;pendingConversationTurn=null;
  document.querySelector?.('.conversation-shell')?.classList.remove('awaiting-choice');
  renderVoiceConversation();renderConversationReport();updateHealthContextButton();setVoiceComposerEnabled(true);
  const last=[...(conversation?.turns||[])].reverse().find(turn=>turn.role==='assistant'&&!turn.superseded);
  if(speak&&last&&!isMockContent(last)&&last.turn_id!==lastSpokenTurnId)speakAssistant(last);
}
function conversationHasPendingReply(conversation){
  const turns=(conversation?.turns||[]).filter(turn=>!turn.superseded),latest=turns[turns.length-1];
  return latest?.role==='elder';
}
async function speakAssistant(turn,force=false){
  if(!turn?.text||isMockContent(turn)||!globalThis.speechSynthesis||!globalThis.SpeechSynthesisUtterance)return;
  const conversationId=activeConversation?.conversation_id;
  let trial;try{trial=await globalThis.HealthLocal?.trialVoiceState?.()}catch{return}
  if(activeConversation?.conversation_id!==conversationId||trial&&trial.state!=='completed'||activeConversation?.trial_control&&activeConversation.trial_control.state!=='completed')return;
  if(!force&&turn.turn_id===lastSpokenTurnId)return;
  speechSynthesis.cancel();speechSynthesis.resume?.();const utterance=new SpeechSynthesisUtterance(turn.text);utterance.lang='zh-CN';utterance.rate=.92;speechSynthesis.speak(utterance);lastSpokenTurnId=turn.turn_id;
}
function beginVoiceTurnEdit(turnId){
  const turn=turnById(turnId);if(!turn||turn.role!=='elder')return;
  conversationEditingTurnId=turnId;turn.editText=turn.text;turn.editStatus='';renderVoiceConversation();
  const input=$('voiceConversationTurns')?.querySelector(`[data-voice-turn="${turnId}"] [data-voice-turn-input]`);input?.focus?.();input?.setSelectionRange?.(input.value.length,input.value.length);
}
function cancelVoiceTurnEdit(){conversationEditingTurnId=null;renderVoiceConversation()}
function reportFocusables(){
  const panel=$('conversationReportPanel');
  if(!panel)return [];
  return [...panel.querySelectorAll('button:not([disabled]), summary, [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(element=>!element.closest('.hidden'));
}
function setReportBackgroundInert(inert){
  const panel=$('conversationReportPanel');if(!panel)return;
  if(inert){
    reportInertTargets=[...[...panel.parentElement.children].filter(element=>element!==panel),document.querySelector('.bottom-nav')].filter(Boolean);
    reportInertTargets.forEach(element=>element.setAttribute('inert',''));
    return;
  }
  reportInertTargets.forEach(element=>element.removeAttribute('inert'));reportInertTargets=[];
}
function openConversationReport(){
  const panel=$('conversationReportPanel');if(!panel)return;
  reportReturnFocus=document.activeElement;panel.classList.remove('hidden');setReportBackgroundInert(true);$('closeConversationReportBtn')?.focus?.({preventScroll:true});
}
function closeConversationReport(){
  const panel=$('conversationReportPanel');if(!panel||panel.classList.contains('hidden'))return;
  panel.classList.add('hidden');setReportBackgroundInert(false);const target=reportReturnFocus;reportReturnFocus=null;(target?.isConnected?target:$('openConversationReportBtn'))?.focus?.({preventScroll:true});
}
function updateHealthContextButton(){
  const button=$('openHealthContextPickerBtn');if(!button)return;
  const count=Array.isArray(activeConversation?.selected_context_ids)?activeConversation.selected_context_ids.length:0;
  button.disabled=!activeConversation?.conversation_id;
  button.textContent=count?`已选 ${count} 项相关资料（可选）`:'带上相关资料（可选）';
}
const HEALTH_CONTEXT_CATEGORY_LABELS={conditions:'疾病或长期问题',medications:'正在使用的药物',allergies:'过敏情况',procedures:'手术、住院或受伤经历',tests:'已有检查或测量',similar_episodes:'以前类似情况'};
function setContextDialogBackgroundInert(inert){
  const panel=$('healthContextPickerPanel');if(!panel)return;
  if(inert){
    contextInertTargets=[...[...(panel.parentElement?.children||[])].filter(element=>element!==panel),document.querySelector('.bottom-nav')].filter(Boolean);
    contextInertTargets.forEach(element=>element.setAttribute('inert',''));return;
  }
  contextInertTargets.forEach(element=>element.removeAttribute('inert'));contextInertTargets=[];
}
function contextPickerFocusables(){
  const panel=$('healthContextPickerPanel');
  return panel?[...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')].filter(element=>!element.closest('.hidden')):[];
}
function updateContextSelectionStatus(message=''){
  const status=$('contextSelectionStatus');if(status)status.textContent=message||`已选 ${contextDraftSelection.size} 项；最多可选 5 项。不会另附未勾选的背景；本段问答仍用于回复。`;
  const save=$('saveHealthContextSelectionBtn');if(save)save.disabled=contextPickerLoading||contextPickerLoadError||contextSelectionSaving;
}
function renderHealthContextPicker(){
  const list=$('healthContextPickerList');if(!list)return;
  if(contextPickerLoading){list.innerHTML='<p class="muted">正在读取本机健康背景…</p>';updateContextSelectionStatus('正在读取本机健康背景；可以关闭后继续不带资料。');return}
  if(contextPickerLoadError){
    list.innerHTML='<div class="context-picker-empty"><p>本机健康背景暂时无法读取；这不影响继续对话，也不会清除已有选择。</p><button id="contextPickerRetryBtn" class="outline" type="button">重新读取</button></div>';
    $('contextPickerRetryBtn')?.addEventListener('click',()=>void loadHealthContextForPicker());updateContextSelectionStatus('读取失败；可以重试，或关闭窗口继续不带资料。');return;
  }
  if(!healthContextEntries.length){
    list.innerHTML='<div class="context-picker-empty"><p>还没有保存健康背景。你可以先不选，照常开始对话。</p><button id="contextPickerOpenSettingsBtn" class="outline" type="button">去设置填写健康背景</button></div>';
    $('contextPickerOpenSettingsBtn')?.addEventListener('click',()=>{closeHealthContextPicker();showView('settingsView')});
    updateContextSelectionStatus('没有已保存的健康背景；本次可以不带资料继续。');return;
  }
  list.innerHTML=healthContextEntries.map(item=>{
    const id=escapeHtml(item.context_id||''),checked=contextDraftSelection.has(item.context_id)?' checked':'';
    return `<label class="health-context-choice"><input type="checkbox" data-context-id="${id}"${checked}><span><b>${escapeHtml(HEALTH_CONTEXT_CATEGORY_LABELS[item.category]||'已确认情况')}</b><span>${escapeHtml(item.text||'')}</span></span></label>`;
  }).join('');
  list.querySelectorAll('[data-context-id]').forEach(input=>input.addEventListener('change',()=>{
    const accepted=changeContextPickerSelection(input.dataset.contextId,input.checked);
    if(!accepted)input.checked=false;
  }));
  updateContextSelectionStatus();
}
function changeContextPickerSelection(id,checked){
  if(!healthContextEntries.some(item=>item.context_id===id)||contextSelectionSaving)return false;
  if(checked&&!contextDraftSelection.has(id)&&contextDraftSelection.size>=5){updateContextSelectionStatus('最多只能选 5 项；请先取消一项再选。');return false}
  if(checked)contextDraftSelection.add(id);else contextDraftSelection.delete(id);
  updateContextSelectionStatus();return true;
}
async function loadHealthContextForPicker(){
  const requestId=++contextPickerRequestId,conversationId=activeConversation?.conversation_id;
  if(!conversationId)return false;
  contextPickerLoading=true;contextPickerLoadError=false;renderHealthContextPicker();
  const stillCurrent=()=>requestId===contextPickerRequestId&&conversationId===activeConversation?.conversation_id&&!$('healthContextPickerPanel')?.classList.contains('hidden');
  try{
    const x=await api('/api/health-context');if(!stillCurrent())return false;
    if(!x.r.ok){healthContextEntries=[];contextPickerLoading=false;contextPickerLoadError=true;renderHealthContextPicker();return false}
    healthContextEntries=Array.isArray(x.j.health_context?.entries)?x.j.health_context.entries:[];
    const saved=new Set(activeConversation?.selected_context_ids||[]);
    contextDraftSelection=new Set(healthContextEntries.filter(item=>saved.has(item.context_id)).map(item=>item.context_id));
    contextPickerLoading=false;contextPickerLoadError=false;renderHealthContextPicker();return true;
  }catch{
    if(!stillCurrent())return false;
    healthContextEntries=[];contextPickerLoading=false;contextPickerLoadError=true;renderHealthContextPicker();return false;
  }
}
function openHealthContextPicker(){
  const panel=$('healthContextPickerPanel');if(!panel||!activeConversation?.conversation_id)return;
  contextReturnFocus=document.activeElement;panel.classList.remove('hidden');setContextDialogBackgroundInert(true);$('closeHealthContextPickerBtn')?.focus?.({preventScroll:true});void loadHealthContextForPicker();
}
function closeHealthContextPicker(){
  const panel=$('healthContextPickerPanel');if(!panel||panel.classList.contains('hidden'))return;
  contextPickerRequestId++;contextPickerLoading=false;panel.classList.add('hidden');setContextDialogBackgroundInert(false);const target=contextReturnFocus;contextReturnFocus=null;(target?.isConnected?target:$('openHealthContextPickerBtn'))?.focus?.({preventScroll:true});
}
function handleHealthContextPickerKeydown(event){
  const panel=$('healthContextPickerPanel');if(!panel||panel.classList.contains('hidden'))return;
  if(event.key==='Escape'){event.preventDefault();closeHealthContextPicker();return}
  if(event.key!=='Tab')return;
  const focusables=contextPickerFocusables();if(!focusables.length){event.preventDefault();return}
  const first=focusables[0],last=focusables[focusables.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}
async function saveHealthContextSelection(){
  const button=$('saveHealthContextSelectionBtn');if(!activeConversation?.conversation_id||contextSelectionSaving||contextPickerLoading||contextPickerLoadError)return false;
  contextSelectionSaving=true;updateContextSelectionStatus('正在把这次选择保存在本机；不会在此时发送健康资料。');
  try{
    const ids=[...contextDraftSelection].slice(0,5),x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/context`,{method:'POST',body:JSON.stringify({context_ids:ids})});
    if(!x.r.ok||!x.j.conversation){contextSelectionSaving=false;button.disabled=false;updateContextSelectionStatus('选择没有保存；勾选内容还在，可以重试。');return false}
    syncConversation(x.j.conversation,{speak:false});contextSelectionSaving=false;closeHealthContextPicker();
    setVoiceStatus(ids.length?`已在本机保存 ${ids.length} 项选择；下次发言时才会发送这些资料。`:'已清除资料选择；下次发言不会附带健康背景。','ok');return true;
  }catch{
    contextSelectionSaving=false;button.disabled=false;updateContextSelectionStatus('选择没有保存；勾选内容还在，可以重试。');return false;
  }
}
async function retryConversationReply(button){
  if(activeConversation?.trial_control)return false;
  const trial=await globalThis.HealthLocal?.trialVoiceState?.();if(trial&&trial.state!=='completed'){setVoiceStatus(trialVoiceMessage(trial),'error');return false}
  const turns=(activeConversation?.turns||[]).filter(turn=>!turn.superseded),latest=turns.at(-1);
  if(saveBusy||!latest||latest.role!=='assistant'||!latest.ai_failed||!activeConversation?.conversation_id)return false;
  saveBusy=true;if(button){button.disabled=true;button.textContent='正在重试…'}setVoiceComposerEnabled(false);setVoiceStatus('刚才的原话已保存在本机，正在请求一次回复…');
  try{
    const x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/resume-assistant`,{method:'POST',body:'{}'});
    if(!x.r.ok||!x.j.conversation){if(button){button.disabled=false;button.textContent='重试小零回复'}setVoiceStatus('原话仍保存在本机；在线服务暂时未能完成回复，恢复后可再试。','error');return false}
    syncConversation(x.j.conversation,{speak:false});
    setVoiceStatus(x.j.ai_failed?'原话仍保存在本机；这次联网回复没完成，可以稍后重试或继续打字。':'已收到新的回复；原话和报告仍保存在本机。',x.j.ai_failed?'error':'ok');
    return !x.j.ai_failed;
  }catch{
    if(button){button.disabled=false;button.textContent='重试小零回复'}setVoiceStatus('原话仍保存在本机；在线服务暂时未能完成回复，恢复后可再试。','error');return false;
  }finally{saveBusy=false;setVoiceComposerEnabled(true)}
}
function handleConversationReportKeydown(event){
  const panel=$('conversationReportPanel');if(!panel||panel.classList.contains('hidden'))return;
  if(event.key==='Escape'){event.preventDefault();closeConversationReport();return}
  if(event.key!=='Tab')return;
  const focusables=reportFocusables();if(!focusables.length){event.preventDefault();return}
  const first=focusables[0],last=focusables[focusables.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}
async function saveVoiceTurnEdit(turnId,value){
  const turn=turnById(turnId),text=String(value||'').trim();if(!turn)return false;
  if(!text){turn.editStatus='修改后的文字不能为空。';renderVoiceConversation();return false}
  if(text===turn.text){cancelVoiceTurnEdit();return true}
  setVoiceStatus('正在保存修改并更新报告…');setVoiceComposerEnabled(false);
  const x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/turns/${encodeURIComponent(turnId)}`,{method:'POST',body:JSON.stringify({text,expected_version:turn.version,expected_conversation_version:activeConversation.version})});
  if(!x.r.ok||!x.j.conversation){turn.editText=text;turn.editStatus=x.r.status===409?'这句话已经有新版本，请重新打开后再改。':'修改没有保存，文字仍在这里，可以重试。';setVoiceComposerEnabled(true);renderVoiceConversation();setVoiceStatus('修改没有保存。','error');return false}
  syncConversation(x.j.conversation);setVoiceStatus(x.j.ai_failed?'原话和本机报告已更新；联网回复暂未完成，可稍后重试。':'原话和报告都已更新。',x.j.ai_failed?'error':'ok');await loadEvents();return true;
}
function showVoiceMediaSaved(media){
  setVoiceStatus('录音原件已保存，正在尝试转成文字…','ok');
}
async function showVoiceMediaResult(media){
  if(!media)return;
  if(media.trial_control){
    let control=media.trial_control;
    if(media.conversation_id){const saved=await api('/api/conversations/'+encodeURIComponent(media.conversation_id));if(saved.r.ok&&saved.j.conversation&&activeConversation?.conversation_id===media.conversation_id){syncConversation(saved.j.conversation,{speak:false});control=saved.j.conversation.trial_control||control}}
    setVoiceStatus(trialVoiceMessage(control),control.state==='stopped'?'error':'ok');return;
  }
  const recognitionError=media.recognition?.error?.code||media.recognition?.error?.error||media.recognition?.error||media.error;
  if(recognitionError==='original_unavailable'){
    setVoiceStatus('原录音无法读取，请重新录音后再试。','error');return;
  }
  if(recognitionError==='media_mock_unavailable'){
    setVoiceStatus(mediaUnavailableMessage,'error');return;
  }
  if(media.kind==='audio'&&['invalid_media','no_text_detected'].includes(recognitionError)){
    setVoiceStatus('这次没有录到可用声音，请重新录音；已保存的录音原件仍可查看。','error');return;
  }
  if(isMockContent(media)){setVoiceStatus(mockWarning,'error');return}
  const rid=media.event_link?.record_id||media.record_id;
  const text=media.recognition?.text?.trim();
  if(media.kind==='audio'&&media.temporary===true&&media.conversation_id&&media.recognition_status==='succeeded'&&text&&!mockText(text)){
    if(media.link_pending_reason==='conversation_link_pending'&&!media.conversation_turn_id){setVoiceStatus('语音已转成文字，正在保存到这次对话；原件和识别文字已保留，请稍后刷新查看。','ok');return}
    if(media.conversation_turn_id){
      const saved=await api('/api/conversations/'+encodeURIComponent(media.conversation_id));
      if(saved.r.ok&&saved.j.conversation&&activeConversation?.conversation_id===media.conversation_id){
        const voiceVisible=document.querySelector?.('.view.active')?.id==='voiceView';
        syncConversation(saved.j.conversation,{speak:voiceVisible});
      }
      setVoiceStatus('识别文字和报告已保存，请对照原录音核对。离开或结束后临时录音会清理，文字与修改历史保留。','ok');return;
    }
    if(activeConversation?.conversation_id!==media.conversation_id){setVoiceStatus('语音文字已保存，但这段录音还没有接入原来的对话。请回到原对话核对；录音原件仍保留。','error');return}
    if(media.conversation_link_error||media.conversation_link_interrupted){prepareMediaRetry(media,text);setVoiceStatus('识别文字和录音原件已保留；加入对话没有完成。请核对下方文字后点发送重试。','error');return}
    const added=await submitConversationText(text,{source_kind:'audio_transcript',record_id:rid,media_id:media.media_id,idempotencyKey:`media-conversation:${media.media_id}`,keep_media_until_pause:true});
    if(!added){prepareMediaRetry(media,text);setVoiceStatus('识别文字和录音原件已保留；加入对话没有完成。请核对下方文字后点发送重试。','error')}
    return;
  }
  if(media.recognition_status==='succeeded'&&text&&!mockText(text)){
    if(media.conversation_turn_id&&media.conversation_id){
      const saved=await api('/api/conversations/'+encodeURIComponent(media.conversation_id));
      if(saved.r.ok&&saved.j.conversation&&activeConversation?.conversation_id===media.conversation_id){
        syncConversation(saved.j.conversation);
      }
      setVoiceStatus('语音已转成文字，原话和报告都已保存。','ok');
    }else await submitConversationText(text,{source_kind:'audio_transcript',record_id:rid,media_id:media.media_id});
  }else{
    setVoiceStatus(media.recognition_status==='succeeded'&&mockText(text)?mockWarning:media.save_status==='saved'?'识别没有完成，原录音已保存。':'识别没有完成；原录音是否保存请查看原件状态。','error');
  }
}
function prepareMediaRetry(media,text){
  pendingMediaRetry={conversation_id:media.conversation_id,media_id:media.media_id,record_id:media.event_link?.record_id||media.record_id||null,text};
  const input=$('voiceTextInput');if(input&&!input.value.trim()){input.value=text;input.style.height='auto';input.style.height=Math.min(input.scrollHeight||0,132)+'px'}
  setVoiceComposerEnabled(true);
}
async function startConversation(mode){
  const x=await api('/api/conversations/start',{method:'POST',body:JSON.stringify({mode,local_date:localDateValue()})});
  if(!x.r.ok||!x.j.conversation){setVoiceStatus('会话暂时无法建立，请稍后重试。','error');return false}
  $('conversationResumeChoice')?.classList.add('hidden');syncConversation(x.j.conversation);setVoiceStatus('您慢慢说，我会帮您记着。','ok');return true;
}
async function startSeparateConversation(){
  if(saveBusy||conversationLoading||mediaRecorder?.state==='recording'||voicePermissionPending||voiceUploadPending){toast('请等这一段保存完成。');return false}
  if($('voiceTextInput')?.value.trim()||conversationEditingTurnId){toast('请先保存或清空正在编辑的话，再另记一件事。');return false}
  conversationLoading=true;const button=$('startSeparateConversationBtn');if(button)button.disabled=true;
  try{await pauseConversation();return await startConversation('new')}
  finally{conversationLoading=false;if(button)button.disabled=false}
}
async function loadConversation(){
  if(conversationLoading)return;conversationLoading=true;setVoiceComposerEnabled(false);
  try{
    const x=await api(`/api/conversations/current?local_date=${encodeURIComponent(localDateValue())}`);
    if(!x.r.ok){setVoiceStatus('已保存资料暂时无法读取，请稍后重试。','error');return}
    if(x.j.resume_choice_required){activeConversation=null;renderVoiceConversation();renderConversationReport();document.querySelector?.('.conversation-shell')?.classList.add('awaiting-choice');$('conversationResumeChoice')?.classList.remove('hidden');setVoiceStatus('请选择接着上次说，还是记录新的情况。');return}
    if(x.j.conversation){
      const pending=conversationHasPendingReply(x.j.conversation);
      syncConversation(x.j.conversation,{speak:false});
      const globalTrial=await globalThis.HealthLocal?.trialVoiceState?.();
      if(x.j.conversation.trial_control||globalTrial&&globalTrial.state!=='completed'){const control=globalTrial?.state==='stopped'?globalTrial:x.j.conversation.trial_control||globalTrial;setVoiceStatus(trialVoiceMessage(control),control.state==='stopped'?'error':'ok');return}
      if(!pending){setVoiceStatus('上次说到这里，您可以接着说。','ok');return}
      setVoiceStatus('刚才的话已保存在本机，正在尝试接上回复…','ok');
      const resumed=await api(`/api/conversations/${encodeURIComponent(x.j.conversation.conversation_id)}/resume-assistant`,{method:'POST',body:'{}'});
      if(!resumed.r.ok||!resumed.j.conversation){setVoiceStatus('刚才的话已保存，暂时没收到回复；重新进入时会继续。','error');return}
      syncConversation(resumed.j.conversation);
      setVoiceStatus(resumed.j.ai_failed?'原话和报告已保存在本机；联网回复没完成，可点对话中的“重试小零回复”，也可以继续打字。':'已经接上刚才的话，您可以继续说。',resumed.j.ai_failed?'error':'ok');
      await loadEvents();return
    }
    await startConversation('new');
  }finally{conversationLoading=false;if(activeConversation)setVoiceComposerEnabled(true)}
}
async function pauseConversation(){
  if(typeof releaseOriginalsIn==='function')releaseOriginalsIn($('voiceConversationTurns'));
  if(!activeConversation?.conversation_id)return;
  if(activeConversation.trial_control)return;
  try{const x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/pause`,{method:'POST',body:'{}'});if(x.r.ok&&x.j.conversation)activeConversation=x.j.conversation}catch{}
}
async function submitConversationText(text,extra={}){
  if(saveBusy||!activeConversation?.conversation_id)return false;
  const clean=String(text||'').trim();if(!clean){setVoiceStatus('请先说或写下想记录的内容。','error');return false}
  if((extra.source_kind==='audio_transcript'||extra.media_id)&&mockText(clean)){setVoiceStatus(mockWarning,'error');return false}
  saveBusy=true;setVoiceComposerEnabled(false);globalThis.speechSynthesis?.cancel?.();
  pendingConversationTurn={turn_id:'pending',role:'elder',text:clean,pending:true,source_kind:extra.source_kind||'elder'};renderVoiceConversation();setVoiceStatus('原话正在保存，小零稍后回复…');
  const operationKey=extra.idempotencyKey||crypto.randomUUID(),body={text:clean,source_kind:extra.source_kind||'elder',record_id:extra.record_id||null,media_id:extra.media_id||null,expected_version:activeConversation.version};
  if(extra.keep_media_until_pause===true)body.keep_media_until_pause=true;
  const x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/turns`,{method:'POST',headers:{'Idempotency-Key':operationKey},body:JSON.stringify(body)});
  saveBusy=false;pendingConversationTurn=null;
  if(!x.r.ok||!x.j.conversation){renderVoiceConversation();setVoiceComposerEnabled(true);if(x.r.status===409)void loadConversation();setVoiceStatus(x.r.status===409?'这份对话已在另一个页面更新；已重新读取，刚才输入仍保留，请再发送一次。':'这句话没有确认保存，请保留当前页面后重试。','error');return false}
  syncConversation(x.j.conversation);setVoiceStatus(x.j.ai_failed?'原话和报告已保存在本机；联网回复没完成，可点对话中的“重试小零回复”，也可以继续打字。':'原话和报告已保存。',x.j.ai_failed?'error':'ok');await loadEvents();return true;
}
async function saveVoiceSupplement(){
  const input=$('voiceTextInput'),text=input.value.trim();
  let extra={};
  if(pendingMediaRetry){
    if(pendingMediaRetry.conversation_id===activeConversation?.conversation_id&&text===pendingMediaRetry.text)extra={source_kind:'audio_transcript',record_id:pendingMediaRetry.record_id,media_id:pendingMediaRetry.media_id,idempotencyKey:`media-conversation:${pendingMediaRetry.media_id}`,keep_media_until_pause:true};
    else pendingMediaRetry=null;
  }
  if(await submitConversationText(text,extra)){pendingMediaRetry=null;input.value='';input.style.height='auto';setVoiceComposerEnabled(true)}
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function listHtml(items,empty='暂无'){const values=Array.isArray(items)?items.filter(v=>typeof v==='string'&&v.trim()):[];return values.length?`<ul class="plain-list">${values.map(v=>`<li>${escapeHtml(v)}</li>`).join('')}</ul>`:`<p class="muted">${empty}</p>`}
function claimsHtml(claims){
  const rows=Array.isArray(claims)?claims.filter(claim=>claim&&typeof claim==='object'&&(claim.quote||claim.text)&&!isMockContent(claim)&&!mockText(claim.quote||claim.text)):[];
  if(!rows.length)return '<p class="muted">本次整理没有生成可展示的事实依据；请以原话为准。</p>';
  return `<div class="claim-list">${rows.map(claim=>`<article class="claim-source"><b>${escapeHtml(SOURCE_KIND_LABELS[claim.source_kind]||'来源未标明')}</b><p>${escapeHtml(claim.quote||claim.text)}</p></article>`).join('')}</div>`;
}
function draftHtml(e,{organizeFailed=false}={}){
  const d=e.draft;if(!d||typeof d!=='object')return '';
  const time=d.time&&typeof d.time==='object'?d.time:{};
  const occurred=time.occurred?escapeHtml(dateText(time.occurred)||String(time.occurred)):'未提供具体日期';
  const certainty=CERTAINTY_LABELS[time.certainty]||'时间未说明';
  const role=REVIEW_ROLE_LABELS[d.review_role]||'需要人工核对';
  const level=ESCALATION_LABELS[d.escalation_level]||'需要人工核对';
  const extra=Object.entries(d).filter(([key,value])=>!['schema_version','event_kind','summary','time','claims','review_required','review_role','escalation_level','conflict','provenance_preserved','plan_change_allowed','follow_up_questions','forbidden_actions'].includes(key)&&typeof value==='string'&&value.trim()).map(([,value])=>value);
  return `<section class="draft-card"><h3>${organizeFailed?'上次整理草稿（本次整理失败，未更新）':'整理结果（请核对）'}</h3><p class="draft-note">这是结构化草稿，不是诊断，也不会自动改变用药方案。</p><h4>整理摘要</h4><p class="draft-summary">${escapeHtml(d.summary||'暂无整理摘要，请以原话为准。')}</p><div class="fact-grid"><div><span>记录类型</span><b>${escapeHtml(EVENT_KIND_LABELS[d.event_kind]||'待人工判断')}</b></div><div><span>发生时间</span><b>${occurred}<small>${escapeHtml(certainty)}</small></b></div><div><span>需要谁核对</span><b>${escapeHtml(role)}</b></div><div><span>关注级别</span><b>${escapeHtml(level)}</b></div></div><div class="draft-source"><b>${e.source_kind==='document'?'识别草稿已保留':'原话已完整保留'}</b><span>${e.source_kind==='document'?'识别可能错字、错行；请对照照片核对数值、单位和阴阳性。':'AI 只做分类和归档，没有改写原文。'}</span></div><h4>事实依据原句与来源</h4>${claimsHtml(d.claims)}${d.follow_up_questions?.length?`<h4>待核对问题</h4>${listHtml(d.follow_up_questions)}<p class="follow-up-note">这些问题来自本次整理结果。补充内容会形成新的原话或修订，不是实时问诊。</p>`:''}${d.conflict?.present?`<p class="status error">发现不同记录，需要把双方原话一起交给人工核对。</p>`:''}${extra.length?`<h4>补充说明</h4>${listHtml(extra)}`:''}</section>`;
}
function relatedHistoryHtml(e,records){
  const ids=Array.isArray(e.related_record_ids)?e.related_record_ids:[];
  if(!ids.length)return '';
  if(!records)return '<section class="related-history"><h3>相关历史线索</h3><p class="muted">正在读取已关联的历史原话…</p></section>';
  const rows=records.length?records.map(item=>`<article class="history-source"><b>${escapeHtml(SOURCE_KIND_LABELS[item.source_kind]||'历史记录')} · ${dateText(item.recorded_at)}</b><p>${documentNeedsReview(item)?'照片文字尚未对照原件核对，未作为事实使用。':escapeHtml(item.raw_text)}</p></article>`).join(''):'<p class="muted">未能读取关联历史原话；不会用摘要替代原文。</p>';
  return `<section class="related-history"><h3>相关历史线索（需要核对）</h3><p class="draft-note">以下内容来自已关联的原始记录，只用于提出核对问题，不代表当前症状已经找到病因。</p>${rows}<p class="related-question">请由老人、家属或医生核对：这次记录是否与以上历史有关？如不确定，以医生判断为准。</p></section>`;
}
function documentNeedsReview(e){return e?.source_kind==='document'&&(globalThis.HealthSafety?.documentNeedsReview?.(e)??true)}
function documentSourceReviewHtml(e){
  if(e.source_kind!=='document')return '';
  if(e.state==='superseded')return '<p class="status">这是保留的旧版本。请返回我的记录，在最新版本中核对或修订。</p>';
  return documentNeedsReview(e)?'<section class="source-review"><h3>先核对照片文字</h3><p class="status warn">这些文字是机器识别草稿，可能补错残缺内容。核对前不会用于 AI 整理、事实或交接正文。旧记录也需要核对原件。</p><p>请先打开照片，逐行核对项目、数值、单位、阴阳性和标题。有误请点“保留历史并修订”；看不清的部分改为 [无法辨认]，不要猜。</p><label><input id="sourceReviewCheck" type="checkbox" disabled>我已对照原件核对；无法确认的内容已标为无法辨认</label><button id="sourceReviewBtn" class="primary" type="button" disabled>保存原件核对结果</button><p id="sourceReviewStatus" role="status" aria-live="polite">打开照片并核对后，可以保存核对结果。</p></section>':'<p class="status">已由使用者对照原件核对文字。这是文字核对，不是医学确认；无法辨认的内容仍保持未知。</p>';
}
function detailHtml(e,{organizeFailed=false,relatedRecords=null}={}){
  const mock=isMockContent(e),pending=documentNeedsReview(e),draft=mock||pending?'':draftHtml(e,{organizeFailed});
  if(mock)return `<div class="event-date">${dateText(e.recorded_at)} · 历史模拟内容</div><h3>保留的历史文字</h3><p class="status error">${escapeHtml(mockWarning)}</p><div class="raw-box">${escapeHtml(e.raw_text)}</div><div class="actions"><button class="outline" id="historyBtn">查看历史版本</button></div><div id="subview"></div>`;
  return `<div class="event-date">${dateText(e.recorded_at)} · ${pending?'照片文字待核对':stateLabel(e.state)} · 来源：${escapeHtml(SOURCE_KIND_LABELS[e.source_kind]||'来源未标明')}</div><h3>${e.source_kind==='document'?'资料文字（请对照原件）':'原话'}</h3><div class="raw-box">${escapeHtml(e.raw_text)}</div>${e.source_kind==='document'?'<button class="outline" id="documentOriginalBtn" type="button">对照照片原件</button><div id="documentOriginals" aria-live="polite"></div>':''}${documentSourceReviewHtml(e)}${pending?'':safetyHtml(e.local_safety)}${draft}${relatedHistoryHtml(e,relatedRecords)}<div class="actions">${!pending&&(['inbox','needs_review'].includes(e.state)||(organizeFailed&&e.state==='draft'))?'<button class="primary" id="organizeBtn">使用 AI 整理</button>':''}${!pending&&e.state==='draft'&&!organizeFailed?'<button class="primary" id="reviewBtn">确认记录准确（非医学确认）</button><button class="outline" id="rejectBtn">退回重新整理</button>':''}${e.state!=='superseded'?'<button class="outline" id="reviseBtn">保留历史并修订</button>':''}<button class="outline" id="historyBtn">查看历史</button></div><div id="organizeStatus" role="status" aria-live="polite"></div>${e.supersedes_id?`<button class="outline" onclick="showDetail('${e.supersedes_id}')">查看修订前原文</button>`:''}<div id="subview"></div>`;
}
function renderDetail(e,options={}){
  const mock=isMockContent(e);current=e;safetyBanner(mock||documentNeedsReview(e)?null:e.local_safety);
  const pageTitle=$('detailPageTitle');if(pageTitle)pageTitle.textContent='单条记录详情';
  const d=$('detail');if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(d);d.classList.remove('hidden');d.innerHTML=(mock?`<p class="status error">${escapeHtml(mockWarning)}</p>`:'')+detailHtml(e,options);
  if($('documentOriginalBtn'))$('documentOriginalBtn').onclick=()=>showDocumentOriginals(e.record_id);
  if($('sourceReviewCheck'))$('sourceReviewCheck').onchange=()=>{$('sourceReviewBtn').disabled=!$('sourceReviewCheck').checked};
  if($('sourceReviewBtn'))$('sourceReviewBtn').onclick=async()=>{
    const button=$('sourceReviewBtn');if(button.disabled)return;button.disabled=true;
    const x=await api('/api/events/'+e.record_id+'/source-review',{method:'POST',body:JSON.stringify({expected_version:e.version,compared_with_original:true})});
    if(x.r.ok){await loadEvents();await showDetail(e.record_id);toast('原件核对结果已保存')}
    else{$('sourceReviewStatus').textContent='核对结果未保存，请重新打开当前记录后再试。';button.disabled=false}
  };
  if($('organizeBtn'))$('organizeBtn').onclick=()=>organize(e);
  if($('reviewBtn'))$('reviewBtn').onclick=()=>review(e,'confirm');
  if($('rejectBtn'))$('rejectBtn').onclick=()=>review(e,'reject');
  if($('reviseBtn'))$('reviseBtn').onclick=()=>revise(e);$('historyBtn').onclick=()=>historyView(e);
}
function detailStillCurrent(e,request){return request===detailRequestSerial&&current?.record_id===e.record_id&&current?.version===e.version}
async function loadRelatedHistory(e){const request=detailRequestSerial,ids=Array.isArray(e.related_record_ids)?e.related_record_ids.slice(0,10):[];if(!ids.length)return;const records=[];for(const id of ids){const x=await api('/api/events/'+encodeURIComponent(id));if(x.r.ok&&x.j.event)records.push(x.j.event)}if(detailStillCurrent(e,request))renderDetail(e,{relatedRecords:records,focus:false})}
function conversationTurnTime(turn){return turn?.created_at?new Date(turn.created_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''}
function conversationTranscriptTurnHtml(turn){
  const assistant=turn.role==='assistant',mock=isMockContent(turn),speaker=assistant?'小零':'我',time=conversationTurnTime(turn),history=!assistant&&!mock&&turn.versions?.length?`<details class="turn-history"><summary>查看修改前文字</summary>${turn.versions.map(version=>`<p>第 ${escapeHtml(version.version)} 版：${escapeHtml(version.text||'')}</p>`).join('')}</details>`:'';
  const audio=!assistant&&!mock&&turn.source_kind==='audio_transcript';
  const sourceActions=audio?`${turn.record_id?`<button class="chat-edit-link" type="button" data-turn-source="${escapeHtml(turn.record_id)}">核对/修改识别文字</button>`:''}${turn.media_id?`<button class="chat-edit-link" type="button" data-turn-original="${escapeHtml(turn.turn_id)}" data-voice-original="${escapeHtml(turn.media_id)}">对照原录音</button><div class="voice-audio-original" style="max-width:100%" aria-live="polite"></div>`:''}`:'';
  return `<article class="chat-turn ${assistant?'assistant-turn':'user-turn'} archive-chat-turn">${assistant?'<img class="chat-avatar" src="assets/brand-mascot.png?v=20260930-real-acceptance-9" alt="" aria-hidden="true">':''}<div class="chat-bubble ${assistant?'assistant-bubble':'user-bubble'}">${mock?`<small class="mock-content-warning">${escapeHtml(mockWarning)}</small>`:''}<p>${escapeHtml(turn.text||'')}</p><small>${mock?'模拟内容':audio?'语音识别文字 · 请核对':speaker}${time?` · ${escapeHtml(time)}`:''}${!assistant&&!mock&&turn.version>1?` · 已修改，第 ${escapeHtml(turn.version)} 版`:''}</small>${sourceActions}${history}</div></article>`;
}
function conversationSafety(conversation){
  const elderTurns=elderArchiveTurns(conversation).filter(turn=>!isMockContent(turn)),danger=elderTurns.find(turn=>turn.local_safety?.danger_detected),review=elderTurns.find(turn=>turn.local_safety?.clinical_review_required);
  const reviewedRisks=(conversation.report?.reviewed_risk_assessments||[]).filter(assessment=>globalThis.HealthSafety?.reviewedRiskSourcesCurrent(assessment,elderTurns));
  const reviewedRisk=reviewedRisks.find(assessment=>assessment.level==='urgent')||reviewedRisks.find(assessment=>assessment.level==='soon_evaluation');
  return {danger_detected:Boolean(danger),danger_reminder:danger?.local_safety?.danger_reminder,clinical_review_required:Boolean(review),clinical_review_notice:review?.local_safety?.clinical_review_notice,reviewed_risk_level:reviewedRisk?.level,reviewed_risk_notice:reviewedRisk?.notice};
}
function conversationDetailHtml(conversation){
  const turns=liveArchiveTurns(conversation),elderTurns=elderArchiveTurns(conversation),elderCount=elderTurns.filter(turn=>!isMockContent(turn)).length,hasMock=elderTurns.some(isMockContent),date=conversationDateLabel(conversation);
  return `<section class="conversation-detail-summary"><div class="event-date">${escapeHtml(date)} · ${escapeHtml(conversationStatusLabel(conversation.status))}</div><h2>这次记录了什么</h2><p>${escapeHtml(conversationSummary(conversation))}</p><div class="badges"><span class="badge">${elderCount} 段老人原话</span><span class="badge">完整上下文已保留</span>${hasMock?'<span class="badge warn">含模拟识别文字，不是患者事实</span>':''}</div></section><section class="conversation-archive" aria-labelledby="conversationTranscriptTitle"><div class="conversation-archive-head"><div><h2 id="conversationTranscriptTitle">完整对话</h2><p>AI 问了什么、老人怎么回答，都按当时顺序保留。</p></div><span>${turns.length} 轮</span></div><div class="archive-conversation-stream">${turns.map(conversationTranscriptTurnHtml).join('')}</div></section>`;
}
function renderConversationDetail(conversation){
  current=conversation;safetyBanner(conversationSafety(conversation));
  const pageTitle=$('detailPageTitle');if(pageTitle)pageTitle.textContent=`${conversationDateLabel(conversation)}完整对话`;
  const d=$('detail');if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(d);d.classList.remove('hidden');d.innerHTML=conversationDetailHtml(conversation);
  bindConversationSourceActions(d,conversation);
}
async function showConversationDetail(id){
  if(!showView('recordDetailView'))return;
  const request=++detailRequestSerial,d=$('detail');if(d){d.classList.remove('hidden');d.innerHTML='<p class="muted detail-loading" role="status" aria-live="polite">正在读取完整对话…</p>'}
  const {r,j}=await api('/api/conversations/'+encodeURIComponent(id));if(request!==detailRequestSerial)return;
  if(!r.ok||!j.conversation){if(d){d.innerHTML='<div class="load-error" role="status"><b>完整对话暂时无法读取</b><span>已有原话不会删除，请稍后重试。</span><button id="retryDetailBtn" class="outline" type="button">重新读取</button></div>';$('retryDetailBtn').onclick=()=>showConversationDetail(id)}toast('完整对话读取失败，请重试');return}
  renderConversationDetail(j.conversation);
}
async function showDetail(id){if(!showView('recordDetailView'))return;const request=++detailRequestSerial,d=$('detail');if(d){d.classList.remove('hidden');d.innerHTML='<p class="muted detail-loading" role="status" aria-live="polite">正在读取这条记录…</p>'}const {r,j}=await api('/api/events/'+id);if(request!==detailRequestSerial)return;if(!r.ok){if(d){d.innerHTML='<div class="load-error" role="status"><b>详情暂时无法读取</b><span>请检查连接后再试，已有记录不会删除。</span><button id="retryDetailBtn" class="outline" type="button">重新读取详情</button></div>';$('retryDetailBtn').onclick=()=>showDetail(id)}toast('详情读取失败，请重试');return;}renderDetail(j.event);loadRelatedHistory(j.event)}
function closeDetail(){showView('recordsView')}
async function organize(e){
  const b=$('organizeBtn');if(!b||b.disabled)return;b.disabled=true;b.textContent='整理中…';
  const request=detailRequestSerial;
  const x=await api('/api/events/'+e.record_id+'/organize',{method:'POST',body:JSON.stringify({expected_version:e.version})});
  if(!detailStillCurrent(e,request)){await loadEvents();return}
  // A successful POST or 422 already carries the saved evidence. Render it
  // without a second GET, so losing the connection cannot hide the original.
  if(x.j.event||x.r.status===422){
    const saved=x.j.event||e;
    renderDetail({...saved,local_safety:{...saved.local_safety,...x.j.local_safety}},{organizeFailed:x.r.status===422});
    loadRelatedHistory(saved);
  }
  if(x.r.status===422){$('organizeStatus').textContent='原话已保存，AI 整理失败：'+(x.j.failure_reason||'请稍后重试');toast('原话已保存，整理暂时失败');}
  else if(x.r.ok&&x.j.event)toast('整理完成，请核对');
  else {toast(x.r.status===409?'记录已有新版本，请刷新后重试':'整理失败，原话仍在');b.disabled=false;b.textContent='整理记录';}
  await loadEvents();
}
async function review(e,action='confirm'){
  const b=$(action==='reject'?'rejectBtn':'reviewBtn');b.disabled=true;
  const request=detailRequestSerial;
  const x=await api('/api/events/'+e.record_id+'/review',{method:'POST',body:JSON.stringify({expected_version:e.version,action,note:action==='confirm'?'仅确认记录准确，不代表医生确认或风险消失':'退回重新整理'})});
  if(x.r.ok){toast(action==='confirm'?'已记录“记录准确”':'已退回重新整理');await loadEvents();if(detailStillCurrent(e,request))await showDetail(e.record_id);}
  else if(detailStillCurrent(e,request)){b.disabled=false;toast('核对未确认，请刷新后重试');}
}
async function deleteRecord(e,button=null){
  if(!confirm('确定删除这条记录吗？删除后，这条记录、修订历史和关联原件会从当前设备移除；其他记录和旧备份不受影响。'))return false;
  if(button){button.disabled=true;button.setAttribute('aria-label','正在删除这条记录')}
  const x=await api('/api/events/'+encodeURIComponent(e.record_id),{method:'DELETE',body:JSON.stringify({delete_scope_confirmed:true})});
  if(x.r.ok){handoffSelection.delete(e.record_id);await loadEvents();toast(`已删除这条记录${x.j.deleted.local_media_count?`和 ${x.j.deleted.local_media_count} 份关联原件`:''}；其他记录未改变`);return true}
  if(button){button.disabled=false;button.setAttribute('aria-label','删除这条记录')}
  toast(x.j.error==='conversation_source_changed'?'这条原话属于完整对话，请从就诊记录删除该对话；资料仍保留':'删除未完成，这条记录仍然保留');return false;
}
async function deleteConversation(conversation,button=null){
  if(!confirm('确定删除这条完整对话吗？删除后，这次对话、关联原话和本机临时录音会从当前设备移除；其他记录、健康背景和旧备份不受影响。'))return false;
  if(button){button.disabled=true;button.setAttribute('aria-label','正在删除这条完整对话')}
  const x=await api('/api/conversations/'+encodeURIComponent(conversation.conversation_id),{method:'DELETE',body:JSON.stringify({delete_scope_confirmed:true,expected_version:conversation.version})});
  if(x.r.ok){if(activeConversation?.conversation_id===conversation.conversation_id)activeConversation=null;conversationRecordIds(conversation).forEach(recordId=>handoffSelection.delete(recordId));await loadEvents();toast(`已删除这条完整对话${x.j.deleted.local_media_count?`和 ${x.j.deleted.local_media_count} 份关联原件`:''}；其他记录未改变`);return true}
  if(button){button.disabled=false;button.setAttribute('aria-label','删除这条完整对话')}
  toast(x.j.error==='conversation_source_shared'?'这条对话与其他对话共用原话，暂时不能单独删除；资料仍保留':x.r.status===409?'这条对话已有新内容，请刷新后再删除':'删除未完成，这条对话仍然保留');return false;
}
function revise(e){
  $('subview').innerHTML=`<h3 id="reviseTitle" tabindex="-1">修订记录</h3><label class="field-label" for="revText">修订后的原话</label><textarea id="revText" rows="4" aria-describedby="reviseStatus">${escapeHtml(e.raw_text)}</textarea><label class="field-label" for="revReason">修订原因（必填）</label><input id="revReason" required aria-describedby="reviseStatus"><button class="primary" id="submitRev">保存修订</button><div id="reviseStatus" role="status" aria-live="polite"></div>`;
  reveal($('subview'),'#reviseTitle');
  const button=$('submitRev'),status=$('reviseStatus');let busy=false;
  button.onclick=async()=>{
    if(busy)return;
    const raw=$('revText').value.trim(),reason=$('revReason').value.trim();
    if(!raw||!reason){$('revText').setAttribute?.('aria-invalid',String(!raw));$('revReason').setAttribute?.('aria-invalid',String(!reason));status.textContent='请填写修订后的原话和修订原因。';toast('请填写内容和修订原因');return}
    $('revText').removeAttribute?.('aria-invalid');$('revReason').removeAttribute?.('aria-invalid');
    busy=true;button.disabled=true;button.textContent='保存中…';status.textContent='正在保存修订…';
    try{
      const x=await api('/api/events/'+e.record_id+'/revise',{method:'POST',body:JSON.stringify({raw_text:raw,source_kind:e.source_kind||'elder',actor_name:'老人',expected_version:e.version,reason})});
      if(x.r.ok&&x.j.event){renderDetail(x.j.event);toast('修订已保存');await loadEvents()}
      else {status.textContent=x.r.status===409?'记录已有新版本，输入已保留，请核对最新记录后再修订。':'修订未保存成功，输入已保留，请稍后重试。';toast(status.textContent)}
    }finally{busy=false;button.disabled=false;button.textContent='保存修订'}
  };
}
async function historyView(e){const box=$('subview');box.innerHTML='<p class="muted" role="status">正在读取历史版本…</p>';const x=await api('/api/events/'+e.record_id+'/history');if(!x.r.ok){box.innerHTML='<div class="load-error" role="status"><b>历史版本暂时无法读取</b><span>当前原话仍保留，请恢复连接后重试。</span><button id="retryHistoryBtn" class="outline" type="button">重新读取历史</button></div>';$('retryHistoryBtn').onclick=()=>historyView(e);return}const actionLabels={created:'首次保存',organized:'整理草稿',summary_corrected:'手动修改整理结果',source_reviewed:'对照原件核对',reviewed:'核对记录',review_confirm:'核对准确',review_return:'退回整理',revised_from:'修订后的新记录',superseded_by_revision:'被新修订替代'};box.innerHTML='<h3 id="historyTitle" tabindex="-1">历史记录</h3><p class="muted">每次保存和修订都单独保留，不会覆盖原来的版本。</p><div class="history">'+(x.j.history||[]).map(h=>`<div class="history-item"><b>${escapeHtml(actionLabels[h.action]||'记录更新')}</b> · 第 ${escapeHtml(h.version)} 版 · 来源：${escapeHtml(SOURCE_KIND_LABELS[h.snapshot?.source_kind]||'来源未标明')}<br><span class="muted">${new Date(h.at).toLocaleString('zh-CN')}</span><p>${escapeHtml(h.snapshot?.raw_text||'')}</p>${(e.source_kind==='document'&&documentNeedsReview({...h.snapshot,source_kind:'document'}))?'<p class="muted">历史照片文字尚未核对，不能作为事实或当前风险结论。</p>':safetyHtml(h.snapshot?.local_safety)}</div>`).join('')+'</div>';reveal(box,'#historyTitle')}
async function handoff(){
  const b=$('handoffBtn');b.disabled=true;b.textContent='生成中…';
  const handoffBody=localMode?JSON.stringify({start_date:$('handoffStart')?.value||null,end_date:$('handoffEnd')?.value||null,record_ids:[...handoffSelection]}):'{}';
  const x=await api('/api/handoffs',{method:'POST',body:handoffBody});b.disabled=false;b.textContent='生成就诊交接材料';
  if(!x.r.ok){const box=$('handoff');box.classList.remove('hidden');box.innerHTML='<div class="load-error" role="status"><b>交接材料暂时无法生成</b><span>原话和原件仍保留，请恢复连接后重试。</span></div>';toast('生成失败，请重试');return;}
  const h=x.j.handoff,box=$('handoff');box.classList.remove('hidden');
  const conversationReports=(h.conversation_reports||[]).map(item=>`<article class="handoff-conversation"><div class="handoff-report-head"><b>${escapeHtml(item.report?.title||'就诊沟通记录')}</b><span class="badge warn">${escapeHtml(item.report?.status_label||'自动整理 · 本人未核对')}</span></div>${reportSectionsHtml(item.report)}<details class="report-transcript"><summary>查看完整对话（${item.transcript?.length||0} 轮）</summary><ol>${(item.transcript||[]).map(turn=>`<li><span>${turn.role==='assistant'?'小零':'老人'}</span><p>${escapeHtml(turn.text||'')}</p></li>`).join('')}</ol></details><p class="muted">报告第 ${escapeHtml(item.report?.version||1)} 版 · 内容来源为老人原话和已确认的本机健康背景</p></article>`).join('');
  box.innerHTML=`<div class="section-head"><h2 id="handoffTitle" tabindex="-1">就诊交接材料</h2><button class="view-btn" onclick="window.print()">打印</button></div><p class="handoff-disclaimer">用于沟通，不是诊断。不会提供加药、减药、停药、剂量或治疗方案。</p><p class="muted">下方列出所选记录关联的原件状态。打印只包含文字与状态，不包含照片；看图请在记录详情点“对照照片原件”。</p><p class="muted">生成于 ${dateText(h.created_at)} · ${h.unresolved_count||0} 项待处理。核对只确认记录准确，不代表医学风险已消除。</p>${conversationReports}`+
    (h.pending_documents||[]).map(i=>`<div class="handoff-item"><b>${dateText(i.recorded_at)} · 照片资料待核对</b><p>识别文字尚未对照原件确认，已从交接正文排除。请查看原件，不根据识别草稿作判断。</p><button class="outline" onclick="showDetail('${escapeHtml(i.record_id)}')">去核对原件</button></div>`).join('')+
    (h.items||[]).filter(i=>!documentNeedsReview(i)).map(i=>`<div class="handoff-item"><b>${dateText(i.recorded_at)} · ${escapeHtml(SOURCE_KIND_LABELS[i.source_kind]||'来源未标明')} · ${stateLabel(i.state)}</b>${i.draft?.summary&&i.draft.summary.trim()!==i.raw_text.trim()?`<p class="handoff-summary"><strong>整理摘要：</strong>${escapeHtml(i.draft.summary)}${i.draft.summary_edited_by==='user'?'<span class="badge">已手动修改</span>':''}</p>`:''}<p class="handoff-original"><strong>${i.source_kind==='document'?'资料文字（需对照原件）：':'原话：'}</strong>${escapeHtml(i.raw_text)}</p>${safetyHtml(i.local_safety)}${i.unresolved?'<span class="badge warn">仍有待处理事项</span>':''}</div>`).join('')+
    (h.media_attachments?.length?'<h3>媒体原件与待处理状态</h3>':'')+(h.media_attachments||[]).map(m=>`<div class="handoff-item handoff-media"><b>${escapeHtml(MEDIA_KIND_LABELS[m.kind]||'媒体原件')}</b><p>${escapeHtml(SAVE_STATUS_LABELS[m.save_status]||'原件保存状态待确认')} · ${escapeHtml(RECOGNITION_LABELS[m.recognition_status]||'识别状态待确认')} · ${escapeHtml(LINK_LABELS[m.link_status]||'关联状态待确认')}${m.is_mock?' · 模拟识别，不是患者原话':''}</p>${m.is_mock?'<p class="status error">该文字不会作为患者事实；真实服务接通后可重试识别。</p>':m.unresolved?'<p>原件与待办仍保留，请完成识别或核对。</p>':''}${m.is_mock?'':safetyHtml(m.local_safety)}</div>`).join('');
  reveal(box,'#handoffTitle');
}
function updateTimer(){const active=mediaRecorder?.state==='recording'?Date.now()-startedAt:0;const sec=Math.floor((elapsedMs+active)/1000);$('voiceTimer').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`}
function setRecording(on){
  const record=$('recordBtn'),label=voicePermissionPending?'等待麦克风权限…':voiceUploadPending?'正在识别上一句话':on?'结束这句话':'开始说';
  record.classList.toggle('recording',on);record.disabled=voicePermissionPending||voiceUploadPending;record.querySelector('span').textContent=label;record.setAttribute?.('aria-label',label);
  $('finishVoiceBtn').disabled=voicePermissionPending||voiceUploadPending||!on;$('wave').classList.toggle('active',on);$('recorderTray')?.classList.toggle('is-active',on||voiceUploadPending);$('recorderTray')?.classList.toggle('hidden',!(on||voiceUploadPending));
}
function stopSilenceWatch(){
  if(silenceFrameId&&globalThis.cancelAnimationFrame)cancelAnimationFrame(silenceFrameId);silenceFrameId=null;
  try{silenceAudioContext?.close?.()}catch{}
  silenceAudioContext=null;silenceAnalyser=null;silenceStartedAt=0;speechDetected=false;
}
function startSilenceWatch(stream){
  stopSilenceWatch();const AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!AudioContextClass||!globalThis.requestAnimationFrame)return false;
  try{
    silenceAudioContext=new AudioContextClass();const source=silenceAudioContext.createMediaStreamSource(stream);silenceAnalyser=silenceAudioContext.createAnalyser();silenceAnalyser.fftSize=512;source.connect(silenceAnalyser);
    const samples=new Uint8Array(silenceAnalyser.fftSize);const started=Date.now();
    const inspect=()=>{
      if(mediaRecorder?.state!=='recording'||!silenceAnalyser)return;
      silenceAnalyser.getByteTimeDomainData(samples);let energy=0;for(const sample of samples){const value=(sample-128)/128;energy+=value*value}const rms=Math.sqrt(energy/samples.length);
      if(rms>.035){speechDetected=true;silenceStartedAt=0}else if(speechDetected&&Date.now()-started>900){if(!silenceStartedAt)silenceStartedAt=Date.now();if(Date.now()-silenceStartedAt>=2600){$('finishVoiceBtn').onclick?.();return}}
      silenceFrameId=requestAnimationFrame(inspect);
    };
    silenceFrameId=requestAnimationFrame(inspect);return true;
  }catch{stopSilenceWatch();return false}
}
async function startVoice(){
  if(typeof recognitionBusy!=='undefined'&&recognitionBusy.size){setVoiceStatus('这段语音还在识别或保存，请等完成。');return}
  if(voicePermissionPending||voiceUploadPending)return;
  if(mediaRecorder?.state==='recording'||$('recordBtn').classList.contains('recording')){$('finishVoiceBtn').onclick?.();return}
  const Recorder=globalThis.MediaRecorder,getUserMedia=globalThis.navigator?.mediaDevices?.getUserMedia;
  if(typeof getUserMedia!=='function'||typeof Recorder!=='function'){
    const host=String(globalThis.location?.hostname||''),protocol=String(globalThis.location?.protocol||'');
    const insecure=globalThis.isSecureContext===false||(protocol==='http:'&&!['localhost','127.0.0.1','::1'].includes(host));
    $('voiceHint').textContent=insecure?'当前页面不是安全连接，浏览器不开放麦克风；请使用安全连接，或到“看病资料”上传已有录音、直接输入文字':'此浏览器暂不支持直接录音；您可以到“看病资料”上传已有录音，或直接输入文字';setVoiceStatus($('voiceHint').textContent,'error');return;
  }
  globalThis.speechSynthesis?.cancel?.();chunks=[];elapsedMs=0;clearInterval(timerId);timerId=null;updateTimer();voicePermissionPending=true;setRecording(false);$('voiceHint').textContent='正在准备录音，请稍候';setVoiceStatus('正在准备录音…');
  const permissionGeneration=++voicePermissionGeneration,conversationId=activeConversation?.conversation_id;
  let stream,preflightReady=false,tracksClosed=false;
  const closePermissionStream=()=>{if(stream&&!tracksClosed){tracksClosed=true;stream.getTracks().forEach(track=>track.stop())}};
  try{
    const trial=await globalThis.HealthLocal?.trialVoiceState?.();
    if(permissionGeneration!==voicePermissionGeneration||activeConversation?.conversation_id!==conversationId||typeof recognitionBusy!=='undefined'&&recognitionBusy.size){
      $('voiceHint').textContent='本次录音准备已取消；麦克风未开启。';setVoiceStatus($('voiceHint').textContent);return;
    }
    if(trial&&trial.state!=='completed'){setVoiceStatus(trialVoiceMessage(trial),trial.state==='stopped'?'error':'ok');return}
    preflightReady=true;$('voiceHint').textContent='请允许使用麦克风，授权后才开始录音';setVoiceStatus('正在请求麦克风权限…');
    stream=await getUserMedia.call(globalThis.navigator.mediaDevices,{audio:true});
    if(permissionGeneration!==voicePermissionGeneration||activeConversation?.conversation_id!==conversationId||typeof recognitionBusy!=='undefined'&&recognitionBusy.size){
      closePermissionStream();$('voiceHint').textContent='本次录音已暂停；麦克风已关闭。';setVoiceStatus($('voiceHint').textContent);return;
    }
    cancelPendingMicrophone=closePermissionStream;
    const lateTrial=await globalThis.HealthLocal?.trialVoiceState?.();
    if(permissionGeneration!==voicePermissionGeneration||activeConversation?.conversation_id!==conversationId||lateTrial&&lateTrial.state!=='completed'||typeof recognitionBusy!=='undefined'&&recognitionBusy.size){
      closePermissionStream();$('voiceHint').textContent='本次录音已暂停；麦克风已关闭。';setVoiceStatus(lateTrial&&lateTrial.state!=='completed'?trialVoiceMessage(lateTrial):$('voiceHint').textContent,lateTrial?.state==='stopped'?'error':'ok');return;
    }
    const preferred=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type=>typeof Recorder.isTypeSupported==='function'&&Recorder.isTypeSupported(type));
    try{mediaRecorder=preferred?new Recorder(stream,{mimeType:preferred}):new Recorder(stream)}catch{mediaRecorder=new Recorder(stream)}
    const recordingChunks=chunks;
    mediaRecorder.ondataavailable=e=>{if(e.data.size)recordingChunks.push(e.data)};
    mediaRecorder.onstop=closePermissionStream;
    mediaRecorder.onerror=()=>{ $('voiceHint').textContent='录音遇到问题；请结束这一段，系统会尽量保留已录部分';setVoiceStatus('录音遇到问题；请结束这一段，系统会尽量保留已录部分。','error'); };
    cancelPendingMicrophone=null;mediaRecorder.start();const autoStop=startSilenceWatch(stream);startedAt=Date.now();timerId=setInterval(updateTimer,1000);$('voiceHint').textContent=autoStop?'正在听，停顿约 3 秒会自动结束':'正在录音；请听完后按“结束这句话”';setVoiceStatus(autoStop?'您慢慢说；停顿约 3 秒会自动保存并回复。':'您慢慢说；听完后按“结束这句话”，录音会自动保存。');
  }catch(e){
    closePermissionStream();mediaRecorder=null;clearInterval(timerId);timerId=null;
    if(!preflightReady){$('voiceHint').textContent='暂时无法确认录音状态；麦克风未开启，请重试。';setVoiceStatus($('voiceHint').textContent,'error');return}
    const name=e?.name||'';
    const message=name==='NotAllowedError'||name==='PermissionDeniedError'?'麦克风权限未允许；您可以在浏览器设置中开启，或直接输入文字。':name==='NotFoundError'||name==='DevicesNotFoundError'?'没有找到可用麦克风；请检查设备，或直接输入文字。':name==='NotReadableError'||name==='TrackStartError'?'麦克风正在被其他应用使用；请关闭后重试，或直接输入文字。':name==='SecurityError'||globalThis.location?.protocol==='http:'&&!['localhost','127.0.0.1'].includes(globalThis.location?.hostname)?'当前页面不允许使用麦克风；请在安全连接中打开，或直接输入文字。':'麦克风未能开启；请检查权限或设备，也可以上传已有录音或直接输入文字。';
    $('voiceHint').textContent=message;setVoiceStatus(message,'error');
  }finally{if(cancelPendingMicrophone===closePermissionStream)cancelPendingMicrophone=null;voicePermissionPending=false;setRecording(mediaRecorder?.state==='recording');updateTimer()}
}
function stopVoice(reason){
  voicePermissionGeneration++;
  const cancelPermission=cancelPendingMicrophone;cancelPendingMicrophone=null;cancelPermission?.();
  if(mediaRecorder?.state==='recording')elapsedMs+=Date.now()-startedAt;
  clearInterval(timerId);timerId=null;stopSilenceWatch();
  let failed=false;
  try{if(mediaRecorder?.state==='recording')mediaRecorder.stop()}catch{failed=true;mediaRecorder?.stream?.getTracks?.().forEach(track=>track.stop())}
  mediaRecorder=null;updateTimer();setRecording(false);$('voiceHint').textContent=failed?'录音结束时遇到问题；正在尝试保留已录片段':reason||'这一段已暂存';if(failed)setVoiceStatus($('voiceHint').textContent,'error');return !failed;
}
$('recordBtn').onclick=startVoice;$('refreshBtn').onclick=async()=>{await health();if(await loadEvents())toast('记录已刷新')};$('handoffBtn').onclick=handoff;
for(const id of ['filterKind','filterState','filterStart','filterEnd'])$(id)?.addEventListener('change',renderList);
$('recordFilters')?.addEventListener('submit',applyRecordFilters);
if($('clearFilters'))$('clearFilters').onclick=clearRecordFilters;
if($('voiceTextSend'))$('voiceTextSend').onclick=saveVoiceSupplement;
if($('voiceTextInput')){
  $('voiceTextInput').addEventListener('input',()=>{setVoiceComposerEnabled(true);$('voiceTextInput').style.height='auto';$('voiceTextInput').style.height=Math.min($('voiceTextInput').scrollHeight,132)+'px'});
  $('voiceTextInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void saveVoiceSupplement()}});
}
if($('continueConversationBtn'))$('continueConversationBtn').onclick=()=>startConversation('continue');
if($('newConversationBtn'))$('newConversationBtn').onclick=()=>startConversation('new');
if($('startSeparateConversationBtn'))$('startSeparateConversationBtn').onclick=startSeparateConversation;
if($('openConversationReportBtn'))$('openConversationReportBtn').onclick=openConversationReport;
if($('closeConversationReportBtn'))$('closeConversationReportBtn').onclick=closeConversationReport;
if($('conversationReportPanel'))$('conversationReportPanel').addEventListener('keydown',handleConversationReportKeydown);
if($('openHealthContextPickerBtn'))$('openHealthContextPickerBtn').onclick=openHealthContextPicker;
if($('closeHealthContextPickerBtn'))$('closeHealthContextPickerBtn').onclick=closeHealthContextPicker;
if($('cancelHealthContextSelectionBtn'))$('cancelHealthContextSelectionBtn').onclick=closeHealthContextPicker;
if($('saveHealthContextSelectionBtn'))$('saveHealthContextSelectionBtn').onclick=saveHealthContextSelection;
if($('healthContextPickerPanel'))$('healthContextPickerPanel').addEventListener('keydown',handleHealthContextPickerKeydown);
// Keep fixed dialogs outside the bounded, phone-width app shell. This lets
// the report use its desktop reading width without being clipped by the shell.
if(document.body)for(const id of ['healthContextPickerPanel','conversationReportPanel']){const panel=$(id);if(panel&&panel.parentElement!==document.body)document.body.append(panel)}
setVoiceComposerEnabled(true);
async function refreshStorageStatus(){if(!localMode||!$('storageStatus'))return;try{const s=await HealthLocal.storageStatus(),used=(s.usage/1024/1024).toFixed(1),quota=s.quota?`${(s.quota/1024/1024).toFixed(0)} MB`:'未知';$('storageStatus').textContent=`已使用约 ${used} MB / 可用额度 ${quota}。${s.persisted?'浏览器已批准持久存储。':'浏览器尚未批准持久存储，请定期下载备份。'}`}catch{$('storageStatus').textContent='无法读取本机存储额度，请定期下载加密备份。'}}
const HEALTH_CONTEXT_FIELDS={conditions:'healthConditions',medications:'healthMedications',allergies:'healthAllergies',procedures:'healthProcedures',tests:'healthTests',similar_episodes:'healthSimilarEpisodes'};
async function loadHealthContext(){
  if(!localMode||!$('healthContextStatus'))return;
  const controls=[...Object.values(HEALTH_CONTEXT_FIELDS).map(id=>$(id)),$('saveHealthContextBtn')].filter(Boolean);
  controls.forEach(control=>control.disabled=true);
  const status=$('healthContextStatus');status.textContent='正在读取本机健康背景…';
  try{
    const x=await api('/api/health-context');
    if(!x.r.ok){status.textContent='健康背景暂时无法读取，原有内容不会删除。';return}
    const entries=x.j.health_context?.entries||[];
    for(const [category,id] of Object.entries(HEALTH_CONTEXT_FIELDS)){const input=$(id);if(input)input.value=entries.filter(item=>item.category===category).map(item=>item.text).join('\n')}
    status.textContent=entries.length?`已在本机保存 ${entries.length} 项确认背景。不会自动发送；请在每段对话中自行选择。`:'还没有保存健康背景；可以先空着。';
  }finally{controls.forEach(control=>control.disabled=false);}
}
async function saveHealthContext(){
  const button=$('saveHealthContextBtn'),status=$('healthContextStatus');if(!button||!status)return;
  const fields=Object.fromEntries(Object.entries(HEALTH_CONTEXT_FIELDS).map(([category,id])=>[category,$(id)?.value||'']));
  button.disabled=true;button.textContent='保存中…';status.textContent='正在加密保存在本机…';
  const x=await api('/api/health-context',{method:'POST',body:JSON.stringify({fields})});
  button.disabled=false;button.textContent='保存健康背景';
  const error=x.j?.error;
  status.textContent=x.r.ok?`已加密保存在本机，共 ${x.j.health_context?.entries?.length||0} 项。不会自动发送；每段对话可单独选择。`:error==='health_context_too_many'?'保存没有完成：每类最多 12 项，总共最多 30 项；每项最多 500 字。输入仍保留，请删减后重试。':error==='health_context_text_too_long'?'保存没有完成：每项最多 500 字。输入仍保留，请缩短后重试。':'保存没有完成，输入仍保留，可以重试。';
}
async function restoreEncryptedBackup(file,status){const passphrase=prompt('输入这份备份的恢复口令。口令只在当前设备验证，不会上传。');if(!passphrase){status.textContent='已取消恢复，当前数据未改变。';return false}try{const preview=await HealthLocal.previewBackup(file,passphrase);if(!confirm(`备份中有 ${preview.eventCount} 条记录、${preview.mediaCount} 份原件，导出时间 ${preview.exportedAt||'未知'}。恢复将替换当前设备的数据，是否继续？`)){status.textContent='已取消，当前数据未改变。';return false}await HealthLocal.restoreBackup(preview,passphrase);status.textContent='恢复完成，正在重新读取记录。';await loadEvents();return true}catch(error){status.textContent=['local_operations_busy','vault_restore_in_progress'].includes(error.message)?'还有记录正在保存、回复或识别，请等完成后再恢复。当前资料未被替换。':['vault_changed_requires_unlock','vault_locked'].includes(error.message)?'这份资料库已在其他页面恢复，请刷新并重新解锁后再操作。':'备份无法验证或已损坏，当前数据未被覆盖。';return false}}
if($('downloadBackupBtn'))$('downloadBackupBtn').onclick=async()=>{const s=$('backupStatus');try{await HealthLocal.downloadBackup();s.textContent='加密备份已生成，请确认浏览器的下载位置。'}catch{s.textContent='备份生成失败，本机数据未改变。'}};
if($('restoreBackupInput'))$('restoreBackupInput').onchange=async e=>{const file=e.target.files?.[0],s=$('backupStatus');e.target.value='';if(file)await restoreEncryptedBackup(file,s)};
if($('lockVaultBtn'))$('lockVaultBtn').onclick=()=>{HealthLocal.lock();location.reload()};
if($('saveFeedbackBtn'))$('saveFeedbackBtn').onclick=async()=>{const text=$('feedbackText').value,s=$('feedbackStatus');try{await HealthLocal.saveFeedback(text,document.querySelector('.view.active')?.id);$('feedbackText').value='';s.textContent='内测问题已加密保存在本机，未附带健康原文。'}catch{s.textContent='请先写下问题描述（不要粘贴密钥）。'}};
if($('saveHealthContextBtn'))$('saveHealthContextBtn').onclick=saveHealthContext;
const today=$('todayLabel');if(today)today.textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
health().then(loadEvents);
if(typeof navigator!=='undefined'&&'serviceWorker'in navigator&&['https:','http:'].includes(location.protocol))navigator.serviceWorker.register('/service-worker.js?build=mic-preflight-20261009-1',{updateViaCache:'none'}).then(registration=>registration.update()).catch(()=>{});
