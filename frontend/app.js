let API = globalThis.BingliConfig?.apiBaseUrl || '';
let token = '', modelProvider = '', saveBusy = false;
let events = [], conversations = [], current = null, currentConversationDetail = null, detailRequestSerial = 0, pendingConversationDetailOpen = null, conversationDetailOpenSequence = 0, viewNavigationSerial = 0, mediaRecorder = null, chunks = [], timerId = null, startedAt = 0, elapsedMs = 0, demoMode = false, localMode = Boolean(globalThis.HealthLocal), localStartupFailed = false, voicePermissionPending = false, voiceUploadPending = false;
let activeConversation = null, conversationLoading = false, conversationLoadSequence = 0, conversationEditingTurnId = null, pendingConversationTurn = null, pendingMediaRetry = null, pendingAudioReview = null, pendingAudioReviewCandidates = [], pendingAudioRecoveryRequestId = 0, pendingCorrectionReview = null, pendingLegacyReorganizationReview = null, pendingFollowupTarget = null, lastSpokenTurnId = null;
let voicePermissionGeneration = 0;
let voiceCaptureIntent = null;
let cancelPendingMicrophone = null;
let silenceAudioContext = null, silenceAnalyser = null, silenceFrameId = null, silenceStartedAt = 0, speechDetected = false;
let reportReturnFocus = null, reportInertTargets = [], contextReturnFocus = null, contextInertTargets = [];
let healthContextEntries = [], contextDraftSelection = new Set(), contextPickerLoading = false, contextPickerLoadError = false, contextPickerRequestId = 0, contextSelectionSaving = false, voiceStatusCheckId = 0;
let healthMemoryEntries = [], healthMemoryVersion = 0, healthMemoryEditingId = null, healthMemoryBusy = false;
let healthSubjects = [], healthSubjectsVersion = 0, activeHealthSubjectId = 'subject_self', healthSubjectUiEpoch = 0, healthSubjectsRequestId = 0, healthSubjectsLoadPromise = null, healthSubjectSwitchBusy = false;
let healthSubjectLoaded = false, healthSubjectChanged = false;
globalThis.recordDataGeneration=globalThis.recordDataGeneration||0;
let pendingRecordDelete = null, recordDeleteBusy = false, recordRelationshipsSubjectId = null;
const handoffSelection=new Set(),knownHandoffEvents=new Set();let visibleHandoffRecordIds=new Set(),handoffPreviewGeneration=0;
const unavailableConversationOriginalIds=new Set();
const DEMO_KEY = 'elder_demo_events_v1';
const PHOTO_KEY = 'elder_demo_photos_v1';
const $ = id => document.getElementById(id);
const views = [...document.querySelectorAll('.view')];
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600)}
function reducedMotion(){return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true}
function reveal(element,titleSelector){if(!element)return;element.scrollIntoView?.({behavior:reducedMotion()?'auto':'smooth',block:'start'});element.querySelector?.(titleSelector)?.focus?.({preventScroll:true})}
function clearRecordPanels(){
  if(pendingRecordDelete){pendingRecordDelete=null;const dialog=$('recordDeleteDialog');if(dialog?.open)dialog.close()}
  detailRequestSerial++;
  const detail=$('detail');if(detail){if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(detail);detail.classList.add('hidden');detail.innerHTML=''}
  const detailTitle=$('detailPageTitle');if(detailTitle)detailTitle.textContent='记录详情';
  if(typeof clearHandoffPreview==='function')clearHandoffPreview();else{const handoff=$('handoff');if(handoff){handoff.classList.add('hidden');handoff.innerHTML=''}}
  const banner=$('dangerBanner');if(banner){banner.classList.add('hidden');banner.innerHTML=''}
  current=null;currentConversationDetail=null;pendingLegacyReorganizationReview=null;
}
function showView(id,options={}){
  const recordingActive=mediaRecorder?.state==='recording';
  const leavingConversation=document.querySelector?.('.view.active')?.id==='voiceView'&&id!=='voiceView';
  if(id!=='voiceView'){conversationLoadSequence++;conversationLoading=false}
  if(id!=='voiceView'&&(recordingActive||voicePermissionPending||voiceUploadPending)){toast(voicePermissionPending?'正在等待麦克风权限，请稍候':'正在录音或保留原件，请稍候');reveal($('voiceView'),'h1');return false}
  viewNavigationSerial++;
  const previousView=document.querySelector?.('.view.active');if(previousView?.id!==id){cancelVoiceTurnPress();closeVoiceTurnMenu(false);if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(previousView)}
  if(leavingConversation&&!options.readOnlyHistoryOpen&&!pendingConversationDetailOpen)void pauseConversation();
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
  if(id==='recordsView')loadEvents();if(id==='homeView')renderHome();if(id==='settingsView'){refreshStorageStatus();void loadHealthMemory()}if(id==='voiceView'){void loadConversation(options.conversationId||null);void refreshVoiceOnlineStatus()}if(['photoCaptureView','archiveView'].includes(id)&&typeof refreshMediaOnlineStatus==='function')void refreshMediaOnlineStatus();return true
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
    try {
      if(await globalThis.HealthLocal.initialise() !== true) throw new Error('local_store_not_ready');
    } catch {
      localStartupFailed = true; setModeLabel(); return false;
    }
    localStartupFailed = false;
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
  const p=$('modePill'); if(p)p.textContent=localMode?(localStartupFailed?'本机资料读取失败':'本机加密保存'):demoMode?'服务未连接 · 请重试':modelProvider==='mock'?'在线服务尚未接通':'本机记录中';
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
  if(localMode){
    const requestEpoch=healthSubjectUiEpoch;
    const headers={...(opt.headers||{}),'X-Health-Subject-Id':activeHealthSubjectId,'X-Health-Subject-Version':String(healthSubjectsVersion)};
    const result=await globalThis.HealthLocal.request(path,{...opt,headers});
    if(['subject_changed','subject_mismatch'].includes(result?.j?.error)&&requestEpoch===healthSubjectUiEpoch&&!healthSubjectSwitchBusy&&typeof markHealthSubjectChanged==='function')markHealthSubjectChanged();
    if(String(opt.method||'GET').toUpperCase()==='POST'){
      const conversationReply=/^\/api\/conversations\/[^/]+\/(?:turns(?:\/[^/]+\/first-send)?|resume-assistant|reorganize-corrected)$/.test(path);
      const mediaRecognition=/^\/api\/media\/[^/]+\/recognize$/.test(path);
      if(conversationReply||mediaRecognition)void refreshVoiceOnlineStatus();
      if(mediaRecognition&&typeof refreshMediaOnlineStatus==='function')void refreshMediaOnlineStatus();
    }
    return result;
  }
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
function legacyAudioNeedsExplicitRecovery(turn){return turn?.role==='elder'&&turn.source_kind==='audio_transcript'&&turn.audio_source_reviewed!==true&&!['machine_transcribed','user_edited'].includes(turn.audio_source_status)}
function literalRecordTitle(text,date){const value=String(text||'').replace(/\s+/g,' ').trim();return value?value.length>18?`${value.slice(0,18)}…`:value:`${date||'今天'}记录`}
function shorten(text,limit=128){const value=String(text||'').replace(/\s+/g,' ').trim();return value.length>limit?value.slice(0,limit-1)+'…':value}
function conversationSummary(conversation){
  const report=globalThis.HealthLocal?.normalizeReportDisplay?.(conversation?.report)||conversation?.report;
  const lines=(report?.sections||[]).filter(section=>section.key!=='verification').flatMap(section=>section.lines||[]).filter(line=>line?.text&&!isMockContent(line)&&!mockText(line.text));
  const current=lines.filter(line=>line.kind==='summary'&&line.source_turn_ids?.length&&!line.source_context_ids?.length).map(line=>line.text.replace(/[，；,;]+$/,''));
  const fallback=elderArchiveTurns(conversation).filter(turn=>!isMockContent(turn)).map(turn=>turn.text);
  // Dates belong to the selected background source, never to today's words.
  // Keep one dated background visible even when the current summary is long.
  const backgrounds=lines.filter(line=>line.kind==='context'&&line.source_context&&line.source_context_ids?.includes(line.source_context.context_id));
  const entry=backgrounds[0]?.source_context;
  const background=entry?`${entry.temporal_status==='historical'?'既往':entry.temporal_status==='current'?'已确认背景':'背景时间未核对'}（${entry.occurred_on||'发生日期未提供'}）：${backgrounds[0].text}`:'';
  const text=[...new Set(current.length?current:fallback)].slice(0,3).join('；');
  const synopsis=text?(current.length?text:`原话历史：${text}`):'';
  const first=shorten(synopsis,background?80:128);
  return (background?[first,shorten(background,first?127-first.length:128)].filter(Boolean).join('；'):first)||(elderArchiveTurns(conversation).some(isMockContent)?'含有历史模拟识别文字，仅保留展示，不作为患者事实。':'这次对话已完整保留。');
}
function conversationLinkedRecordIds(){return new Set(conversations.flatMap(conversationRecordIds))}
function standaloneEvents(){const linked=conversationLinkedRecordIds();return events.filter(event=>event.state!=='superseded'&&!linked.has(event.record_id))}
function recentRecordItems(){
  return [
    ...conversations.filter(conversation=>elderArchiveTurns(conversation).length).map(conversation=>{const date=conversationDateLabel(conversation),first=elderArchiveTurns(conversation).find(turn=>!isMockContent(turn));return {type:'conversation',id:conversation.conversation_id,at:conversation.updated_at||`${conversation.last_local_date||conversation.local_date}T12:00:00`,date,text:isMockContent(first)?'含模拟内容':literalRecordTitle(first?.text,date)}}),
    ...standaloneEvents().map(event=>({type:'event',id:event.record_id,at:event.recorded_at,date:dateText(event.recorded_at),text:isMockContent(event)?'模拟识别内容':literalRecordTitle(event.raw_text,dateText(event.recorded_at))})),
  ].sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
}
function renderRecentRecords(box,limit=3){
  if(!box)return;
  const items=recentRecordItems().slice(0,limit);
  box.innerHTML=items.length?items.map(item=>`<button class="recent-item" ${item.type==='conversation'?`data-conversation-id="${escapeHtml(item.id)}"`:`data-id="${escapeHtml(item.id)}"`}><span class="date">${escapeHtml(item.date)}</span><p>${escapeHtml(item.text)}</p></button>`).join(''):'<p class="muted">还没有健康记录</p>';
  box.querySelectorAll('[data-conversation-id]').forEach(button=>button.onclick=()=>showHistoricalConversation(button.dataset.conversationId));
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
function filteredHandoffRecordIds(){
  const {conversationItems,eventItems}=filteredRecords();
  return new Set([...conversationItems.flatMap(conversationRecordIds),...eventItems.filter(event=>!isMockContent(event)).map(event=>event.record_id).filter(Boolean)]);
}
function clearHandoffPreview(){handoffPreviewGeneration++;const box=$('handoff');if(box){box.classList.add('hidden');box.innerHTML=''}}
function setHandoffSelection(recordIds,selected){
  for(const id of recordIds)if(id){if(selected)handoffSelection.add(id);else handoffSelection.delete(id)}
  clearHandoffPreview();
}
function renderFilterStatus(count){const status=$('filterResultsStatus');if(!status)return;const active=['filterKeyword','filterKind','filterState','filterStart','filterEnd'].some(id=>$(id)?.value);status.textContent=active?`找到 ${count} 份符合条件的记录。`:`共有 ${count} 份健康记录。`}
function renderList(){
  const box=$('eventsList');if(!box)return;
  const {conversationItems,eventItems}=filteredRecords();visibleHandoffRecordIds=filteredHandoffRecordIds();const count=conversationItems.length+eventItems.length;renderFilterStatus(count);
  if(!count){box.innerHTML=`<p class="muted">${conversations.length||events.some(event=>event.state!=='superseded')?'没有符合当前筛选的记录，请换个关键词。':'还没有记录，先说下第一次情况吧。'}</p>`;return}
  box.innerHTML='';
  conversationItems.forEach(conversation=>{
    const recordIds=conversationRecordIds(conversation),key=`conversation:${conversation.conversation_id}`;
    if(!knownHandoffEvents.has(key)){knownHandoffEvents.add(key);recordIds.forEach(recordId=>handoffSelection.add(recordId))}
    const n=document.importNode($('conversationRecordTpl').content,true),elderTurns=elderArchiveTurns(conversation);
    n.querySelector('.event-date').textContent=conversationDateLabel(conversation);
    const firstTurn=elderTurns.find(turn=>!isMockContent(turn));
    n.querySelector('.conversation-record-title').textContent=literalRecordTitle(firstTurn?.text,conversationDateLabel(conversation));
    n.querySelector('.event-raw').textContent='';
    const factualTurns=elderTurns.filter(turn=>!isMockContent(turn)),danger=factualTurns.some(turn=>turn.local_safety?.danger_detected),review=factualTurns.some(turn=>turn.local_safety?.clinical_review_required);
    const hasMock=elderTurns.some(isMockContent);n.querySelector('.badges').innerHTML='<span class="badge">完整对话已保留</span>'+(hasMock?'<span class="badge warn">含模拟文字，不作患者事实</span>':'')+(danger?'<span class="badge warn">需要关注</span>':'')+(review?'<span class="badge warn">待专业复核</span>':'');
    const openConversation=()=>showHistoricalConversation(conversation.conversation_id);
    n.querySelector('.event-item').onclick=()=>openConversation();
    n.querySelector('.event-item').onkeydown=event=>{if((event.key==='Enter'||event.key===' ')&&event.target===event.currentTarget){event.preventDefault();openConversation()}};
    n.querySelector('.event-item').tabIndex=0;n.querySelector('.event-item').setAttribute('role','link');
    n.querySelector('.event-item').setAttribute('aria-label',`${literalRecordTitle(firstTurn?.text,conversationDateLabel(conversation))}，${conversationDateLabel(conversation)}，打开完整对话`);
    box.appendChild(n);
  });
  eventItems.forEach(event=>{
    if(!knownHandoffEvents.has(event.record_id)){knownHandoffEvents.add(event.record_id);handoffSelection.add(event.record_id)}
    const mock=isMockContent(event),n=document.importNode($('eventTpl').content,true),pendingSource=documentNeedsReview(event)||audioNeedsReview(event);n.querySelector('.event-date').textContent=dateText(event.recorded_at);n.querySelector('.event-raw').textContent=mock?'模拟识别内容':literalRecordTitle(event.raw_text,dateText(event.recorded_at));n.querySelector('.badges').innerHTML='<span class="badge">单独记录</span>'+(mock?'<span class="badge warn">模拟识别，不是患者原话</span>':'')+(!mock&&!pendingSource&&event.local_safety?.danger_detected?'<span class="badge warn">需要关注</span>':'')+(!mock&&!pendingSource&&event.local_safety?.clinical_review_required?'<span class="badge warn">待专业复核</span>':'');
    const openEvent=()=>showDetail(event.record_id);
    n.querySelector('.event-item').onclick=()=>openEvent();
    n.querySelector('.event-item').onkeydown=click=>{if((click.key==='Enter'||click.key===' ')&&click.target===click.currentTarget){click.preventDefault();openEvent()}};
    n.querySelector('.event-item').tabIndex=0;n.querySelector('.event-item').setAttribute('role','link');
    n.querySelector('.event-item').setAttribute('aria-label',`${literalRecordTitle(event.raw_text,dateText(event.recorded_at))}，${dateText(event.recorded_at)}，打开记录详情`);
    box.appendChild(n);
  });
}
function applyRecordFilters(event){event?.preventDefault();clearHandoffPreview();renderList();const box=$('eventsList');box?.focus?.({preventScroll:true});box?.scrollIntoView?.({behavior:'smooth',block:'start'})}
function clearRecordFilters(){clearHandoffPreview();const form=$('recordFilters');if(form?.reset)form.reset();else for(const id of ['filterKeyword','filterKind','filterState','filterStart','filterEnd'])$(id).value='';renderList();$('filterKeyword')?.focus?.()}
function showEventsLoadFailure(){
  events=[];conversations=[];recordRelationshipsSubjectId=null;visibleHandoffRecordIds.clear();clearHandoffPreview();demoMode=true;setModeLabel();
  const message='<div class="load-error" role="status"><b>记录暂时无法读取</b><span>请恢复连接后重试；已保存内容不会删除。</span><button class="outline" type="button" data-retry-events>重新读取</button></div>';
  for(const id of ['homeRecent','eventsList','archiveEvents']){const box=$(id);if(!box)continue;box.innerHTML=message;box.querySelectorAll?.('[data-retry-events]').forEach(button=>button.onclick=loadEvents)}
  toast('记录暂时无法读取，请恢复连接后重试');return false;
}
async function loadEvents(){
  const subjectEpoch=typeof healthSubjectUiEpoch==='number'?healthSubjectUiEpoch:0;
  const dataGeneration=globalThis.recordDataGeneration||0;
  try{
    if(localMode&&!await ensureHealthSubjectReady())return false;
    const [eventResult,conversationResult]=await Promise.all([api('/api/events'),api('/api/conversations')]);
    if((typeof healthSubjectUiEpoch==='number'&&subjectEpoch!==healthSubjectUiEpoch)||dataGeneration!==globalThis.recordDataGeneration)return false;
    if(!eventResult?.r?.ok||!Array.isArray(eventResult.j?.events)||!conversationResult?.r?.ok||!Array.isArray(conversationResult.j?.conversations))return showEventsLoadFailure();
    demoMode=false;events=eventResult.j.events;conversations=conversationResult.j.conversations;recordRelationshipsSubjectId=activeHealthSubjectId;setModeLabel();renderList();renderHome();renderArchive();return true;
  }catch{
    if((typeof healthSubjectUiEpoch==='number'&&subjectEpoch!==healthSubjectUiEpoch)||dataGeneration!==globalThis.recordDataGeneration)return false;
    return showEventsLoadFailure();
  }
}
function setVoiceStatus(text,tone=''){
  const status=$('voiceConversationStatus');if(!status)return;
  status.textContent=text;status.className='conversation-status'+(tone?' '+tone:'');
}
function setVoiceComposerEnabled(enabled){
  if(typeof healthSubjectChanged!=='undefined'&&healthSubjectChanged)enabled=false;
  if(activeConversation?.saved_audio_trial||activeConversation?.trial_control&&activeConversation.trial_control.state!=='completed')enabled=false;
  if(pendingAudioReview)enabled=false;
  const input=$('voiceTextInput'),send=$('voiceTextSend');
  if(send)send.textContent=activeConversation?.trial_control?'保存原话':'发送';
  if(input)input.disabled=!enabled;if(send)send.disabled=!enabled||!input?.value.trim();
}
function trialVoiceMessage(control){
  if(control?.state==='review_required')return control.source_kind==='elder'&&!control.media_id?'本轮原话已保存在本机，尚未请求回复。请核对文字，等待本次试验批准后再继续一次。':'语音已转成文字，原话和录音已保留。请对照录音核对文字，等待本次试验批准后再继续一次。';
  return control?.state==='completed'?'原话和本次回复已保存；可补充或纠正，下一轮仍会先保存在本机并暂停核对。':control?.state==='continuing'?'这次回复已提交，原话与已有原件已保留。请等结果；重新进入不会再次发送。':'本次试验已停止，原话与已有原件已保留；请等待新的明确处理安排。';
}
function savedAudioTrialMessage(trial){
  if(trial?.state==='sending')return '正在根据已核对文字回应；原录音和已核对文字仍保留。';
  if(trial?.state==='completed')return '回复已保存；本次单次测试已结束，原录音和已核对文字仍保留。';
  if(trial?.state==='stopped')return '本次回复未完成；原录音和已核对文字仍保留，不会自动重发。';
  return '本次单次测试状态暂时无法确认；原录音和已核对文字仍保留，不会自动重发。';
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
async function showConversationOriginal(turn,box,conversation,{compact=false}={}){
  if(!box||turn?.source_kind!=='audio_transcript'||!turn.media_id||isMockContent(turn))return false;
  box.textContent='正在读取本机原录音…';
  try{
    const [x,eventsResult]=await Promise.all([
      api('/api/media/'+encodeURIComponent(turn.media_id)),api('/api/events'),
    ]);
    if(!box.isConnected&&box.isConnected!==undefined)return false;
    const view=box.closest?.('.view');if(view&&!view.classList.contains('active'))return false;
    if(!x.r.ok||!x.j.media){
      if(x.r.status===404){if(typeof unavailableConversationOriginalIds!=='undefined')unavailableConversationOriginalIds.add(turn.media_id);box.textContent='没有找到这段录音原件；识别文字与修改历史仍保留。';return false}
      if([401,403,423].includes(x.r.status)){box.textContent='目前无法读取或访问这段录音；请确认本机资料已解锁后重试。识别文字与修改历史仍保留。';return false}
      box.textContent='原录音暂时无法读取；识别文字与修改历史仍保留，请稍后重试。';return false
    }
    if(!eventsResult.r.ok||!Array.isArray(eventsResult.j?.events)){box.textContent='当前录音来源暂时无法核对；识别文字与修改历史仍保留。';return false}
    const media=x.j.media;
    const conversationId=conversation?.conversation_id,subjectId=conversation?.subject_id||'subject_self';
    const event=globalThis.HealthSafety?.currentAudioSource(media,eventsResult.j.events);
    const versionMatches=(value,current)=>value==null||Number.isSafeInteger(value)&&value===current;
    const sourceMatches=event&&event.record_id===turn.record_id&&event.raw_text===turn.text
      &&(event.subject_id||'subject_self')===subjectId;
    const reviewedVersionsMatch=turn.audio_source_reviewed!==true
      ||Number.isSafeInteger(turn.audio_source_version)&&turn.audio_source_version===event?.version
        &&Number.isSafeInteger(turn.audio_source_media_version)&&turn.audio_source_media_version===media.version;
    const versionsMatch=event&&reviewedVersionsMatch&&versionMatches(turn.audio_source_version,event.version)
      &&versionMatches(turn.audio_source_media_version,media.version)
      &&(!turn.audio_source_conversation_id||turn.audio_source_conversation_id===conversationId);
    const exactSavedAudioBinding=turn.audio_source_reviewed===true
      &&Number.isSafeInteger(turn.audio_source_version)&&turn.audio_source_version===event?.version
      &&Number.isSafeInteger(turn.audio_source_media_version)&&turn.audio_source_media_version===media.version
      &&turn.audio_source_conversation_id===conversationId;
    const ownedHere=media.conversation_id===conversationId;
    if(media.media_id!==turn.media_id||media.kind!=='audio'||isMockContent(media)||isMockContent(event)
      ||!conversationId||subjectId!==(activeHealthSubjectId||subjectId)||(media.subject_id||'subject_self')!==subjectId
      ||!sourceMatches||!versionsMatch||(!ownedHere&&!exactSavedAudioBinding)){
      box.textContent='原录音与这段原话的来源不一致，请重新打开当前记录。';return false;
    }
    const opened=await openOriginal(turn.media_id,{box,media,controls:!compact});
    if(opened&&typeof unavailableConversationOriginalIds!=='undefined')unavailableConversationOriginalIds.delete(turn.media_id);
    if(opened&&Number.isFinite(Number(media.duration_seconds))&&Number(media.duration_seconds)>0){turn.audio_duration_seconds=Number(turn.audio_duration_seconds)||Number(media.duration_seconds)}
    return opened;
  }catch{box.textContent='原录音暂时无法读取；文字仍保留，可以稍后重新打开。';return false}
}
async function playPendingAudioOriginal(){
  const review=pendingAudioReview;if(!review||review.busy||review.conversation_id!==activeConversation?.conversation_id)return false;
  const box=$('voiceConversationTurns')?.querySelector('[data-audio-review-original]');if(!box)return false;
  const turn={role:'elder',source_kind:'audio_transcript',media_id:review.media_id,record_id:review.record_id,text:review.text,
    audio_source_reviewed:review.reviewed===true,audio_source_version:review.sourceVersion,audio_source_media_version:review.mediaVersion,
    audio_source_conversation_id:review.conversation_id};
  const opened=await showConversationOriginal(turn,box,activeConversation),audio=box.querySelector?.('audio');
  if(!opened||!audio){box.textContent='原录音暂时无法播放；识别文字仍保留，暂不能确认并继续。';return false}
  audio.addEventListener('play',()=>{
    if(pendingAudioReview!==review)return;
    review.played=true;
    const current=$('voiceConversationTurns'),check=current?.querySelector('[data-audio-review-check]');if(check)check.disabled=false;
    const status=current?.querySelector('[data-audio-review-status]');if(status)status.textContent='原录音已开始播放。请对照文字核对；这不会确认医学事实。';
  },{once:true});
  return true;
}
async function confirmPendingAudioReview(){
  const review=pendingAudioReview;if(!review||review.busy||review.conversation_id!==activeConversation?.conversation_id)return false;
  const box=$('voiceConversationTurns'),textarea=box?.querySelector('#audioTranscriptReviewText');
  const text=String(textarea?.value??review.draftText??review.text).trim();
  const alreadyReviewed=review.reviewed&&text===review.reviewedText;
  if(!text||text.length>10000){setVoiceStatus('识别文字不能为空或超过长度限制；录音仍保留。','error');return false}
  if(!alreadyReviewed&&(!review.played||!review.confirmed)){
    setVoiceStatus('请先播放原录音、核对文字并勾选确认；这不代表确认医学事实。','error');return false;
  }
  review.draftText=text;review.busy=true;saveBusy=true;
  const action=box?.querySelector('[data-audio-review-confirm]');if(action)action.disabled=true;
  setVoiceStatus('正在核对录音来源并保存…','ok');
  try{
    if(!alreadyReviewed){
      const eventResult=await api('/api/events/'+encodeURIComponent(review.record_id));
      if(!eventResult.r.ok||!eventResult.j.event||eventResult.j.event.state==='superseded')throw new Error('识别记录已变化，请刷新后重新核对。');
      let event=eventResult.j.event;
      if(event.raw_text!==text){
        const revised=await api('/api/events/'+encodeURIComponent(event.record_id)+'/revise',{method:'POST',body:JSON.stringify({raw_text:text,reason:'对照原录音修正语音识别文字',expected_version:event.version})});
        if(!revised.r.ok||!revised.j.event)throw new Error(revised.j.error==='stale_version'?'识别记录已更新，请重新核对当前文字。':'修改识别文字没有保存；原录音和文字仍保留。');
        event=revised.j.event;review.record_id=event.record_id;review.text=text;review.sourceVersion=event.version;review.reviewed=false;review.reviewedText=null;review.idempotencyKey=null;
      }
      const compared=await api('/api/events/'+encodeURIComponent(event.record_id)+'/source-review',{method:'POST',body:JSON.stringify({expected_version:event.version,compared_with_original:true})});
      if(!compared.r.ok||!compared.j.event)throw new Error(compared.j.error==='audio_original_unavailable'?'暂时无法读取原录音，请保留页面稍后重试。':'文字核对没有保存；原录音和识别文字仍保留。');
      review.record_id=compared.j.event.record_id;review.sourceVersion=compared.j.event.version;review.text=text;review.reviewedText=text;review.reviewed=true;
    }
    const [mediaResult,eventsResult,conversationResult]=await Promise.all([
      api('/api/media/'+encodeURIComponent(review.media_id)),api('/api/events'),api('/api/conversations/'+encodeURIComponent(review.conversation_id)),
    ]);
    const media=mediaResult.j?.media,allEvents=eventsResult.j?.events||[],currentSource=media&&globalThis.HealthSafety?.currentAudioSource(media,allEvents);
    if(!mediaResult.r.ok||!eventsResult.r.ok||!conversationResult.r.ok||!conversationResult.j.conversation)throw new Error('刚才的核对已保存，但对话状态暂时无法读取；可重试继续。');
    if(media.kind!=='audio'||media.recognition_status!=='succeeded'||isMockContent(media)||currentSource?.record_id!==review.record_id||globalThis.HealthSafety?.audioNeedsReview(currentSource)!==false)throw new Error('录音来源或核对文字已变化；请重新读取后再继续。');
    syncConversation(conversationResult.j.conversation,{speak:false});
    review.mediaVersion=media.version;review.idempotencyKey ||= `audio-reviewed:${review.media_id}:${review.conversation_id}:${crypto.randomUUID()}`;
    pendingAudioReview=null;saveBusy=false;
    const added=await submitConversationText(text,{source_kind:'audio_transcript',record_id:review.record_id,source_version:review.sourceVersion,media_id:review.media_id,media_version:review.mediaVersion,idempotencyKey:review.idempotencyKey,keep_media_until_pause:true});
    if(!added){pendingAudioReview=review;review.busy=false;renderVoiceConversation();setVoiceComposerEnabled(true);return false}
    pendingAudioReviewCandidates=pendingAudioReviewCandidates.filter(item=>item.media_id!==review.media_id);renderVoiceConversation();
    review.busy=false;setVoiceComposerEnabled(true);return true;
  }catch(error){
    setVoiceStatus(error.message||'核对没有完成；识别文字和录音原件仍保留。','error');return false;
  }finally{
    saveBusy=false;review.busy=false;
    if(pendingAudioReview===review){renderVoiceConversation();setVoiceComposerEnabled(true)}
  }
}
function bindConversationSourceActions(box,conversation){
  box.querySelectorAll('[data-turn-play]').forEach(button=>button.onclick=async()=>{
    const turn=(conversation?.turns||[]).find(item=>item.turn_id===button.dataset.turnOriginal&&item.role==='elder'&&!item.superseded);
    const target=button.closest('.chat-turn')?.querySelector('.voice-audio-original');
    if(button.disabled||!turn||!target)return;button.disabled=true;
    try{
      let audio=target.querySelector('audio');
      if(!audio){if(!await showConversationOriginal(turn,target,conversation,{compact:true})){const message=target.textContent?.trim();setVoiceStatus(message&&message!=='正在读取本机原录音…'?message:'原录音暂时无法打开，请重新打开记录核对。','error');return}audio=target.querySelector('audio')}
      if(!audio)return;
      const updateDuration=()=>{const label=audioDurationLabel(turn.audio_duration_seconds||audio.duration),duration=button.querySelector('[data-audio-duration]');if(duration&&label)duration.textContent=label;if(label){button.setAttribute('aria-label',`播放录音，${label}`);button.style.setProperty('--audio-width',`${Math.max(112,Math.min(176,112+(Number(turn.audio_duration_seconds)||audio.duration)*2.4))}px`)}};
      audio.ondurationchange=updateDuration;audio.onloadedmetadata=updateDuration;updateDuration();
      if(!audio.paused){audio.pause();button.setAttribute('aria-pressed','false');const label=audioDurationLabel(turn.audio_duration_seconds||audio.duration);button.setAttribute('aria-label',label?`播放录音，${label}`:'播放录音');return}
      for(const [mediaId,item] of originalTargets){
        const other=item.node;
        if(other&&other!==audio&&other.tagName==='AUDIO'&&!other.paused){other.pause();for(const candidate of box.querySelectorAll('[data-turn-play]'))if(candidate.dataset.voiceOriginal===mediaId){candidate.setAttribute('aria-pressed','false');candidate.setAttribute('aria-label','播放录音')}}
      }
      audio.onended=()=>{button.setAttribute('aria-pressed','false');const label=audioDurationLabel(turn.audio_duration_seconds||audio.duration);button.setAttribute('aria-label',label?`播放录音，${label}`:'播放录音')};
      await audio.play();button.setAttribute('aria-pressed','true');button.setAttribute('aria-label','暂停录音');
    }catch{setVoiceStatus('录音暂时无法播放；识别文字和原件仍保留。','error')}
    finally{button.disabled=false;if(typeof unavailableConversationOriginalIds!=='undefined'&&unavailableConversationOriginalIds.has(turn.media_id)){button.hidden=true;button.setAttribute('aria-hidden','true')}}
  });
  box.querySelectorAll('[data-turn-source]').forEach(button=>button.onclick=()=>showDetail(button.dataset.turnSource));
}
function canShowSavedTextFirstSend(conversation,turn){
  const turns=(conversation?.turns||[]).filter(item=>!item.superseded),marker=conversation?.new_text_trial;
  return Boolean(!conversation?.trial_control&&marker?.state==='saved_only'&&marker.first_send_available===true
    &&marker.turn_id===turn?.turn_id&&turn?.role==='elder'&&turn.source_kind==='elder'&&!turn.media_id
    &&turn.text?.trim()===turn.text&&turn.text===turn.original_text&&!isMockContent(turn)&&turns.at(-1)?.turn_id===turn.turn_id);
}
function naturalCorrectionDetails(text){
  const match=/^\s*更正一下[，,]\s*刚才说(?<old>[^，。；,.!?！？;]{1,48})不准确[，,]\s*(?<replacement>[^。！？；.!?]{1,120})(?<punctuation>[。！？.!?]?)\s*$/u.exec(String(text||''));
  if(!match)return null;
  const oldQuote=match.groups.old.trim(),newQuote=match.groups.replacement.trim()+match.groups.punctuation;
  return oldQuote&&newQuote?{oldQuote,newQuote}:null;
}
function pendingNaturalCorrection(conversation,turn){
  if(!localMode||!conversation||!turn||turn.role!=='elder'||turn.source_kind!=='elder'||turn.media_id||isMockContent(turn))return null;
  if(!(conversation.completeness?.contradictions||[]).some(note=>note.text==='自然更正无法唯一定位旧原话，待核实。'&&note.evidence_turn_ids?.includes(turn.turn_id)))return null;
  if((conversation.manual_corrections||[]).some(item=>item.correction_turn_id===turn.turn_id))return null;
  const details=naturalCorrectionDetails(turn.text);return details?{...details,turn}:null;
}
function audioDurationLabel(value){const seconds=Number(value);if(!Number.isFinite(seconds)||seconds<=0)return '';const rounded=Math.max(1,Math.round(seconds));return rounded<60?`${rounded}″`:`${Math.floor(rounded/60)}′${String(rounded%60).padStart(2,'0')}″`}
function voiceAudioMessageHtml(turn,source,{recovery=false,showProvenance=true,edited=false,notice=''}={}){
  const seconds=Number(turn.audio_duration_seconds)||0,width=Math.max(112,Math.min(176,112+seconds*2.4)),duration=audioDurationLabel(seconds);
  const playBinding=recovery?`data-recovery-audio-play="${escapeHtml(turn.media_id)}"`:`data-turn-play data-turn-original="${escapeHtml(turn.turn_id)}" data-voice-original="${escapeHtml(turn.media_id)}"`;
  const provenance=showProvenance?`<small class="voice-audio-provenance">${escapeHtml(source)}</small>`:notice?`<small class="voice-audio-provenance">${escapeHtml(notice)}</small>`:edited?'<small class="voice-audio-provenance">已修改</small>':'';
  return `<div class="voice-audio-message"><button class="voice-audio-bubble" type="button" ${playBinding} aria-label="${duration?`播放录音，${escapeHtml(duration)}`:'播放录音'}" aria-pressed="false" style="--audio-width:${width}px"><span class="voice-audio-duration" data-audio-duration>${escapeHtml(duration)}</span><svg class="voice-audio-sound-icon" viewBox="0 0 28 24" aria-hidden="true"><path class="speaker-shape" d="M3 9v6h5l6 5V4L8 9H3z"/><path class="sound-wave sound-wave-one" d="M18 8a8 8 0 0 1 0 8"/><path class="sound-wave sound-wave-two" d="M21 5a12 12 0 0 1 0 14"/></svg></button><div class="voice-transcript-bubble"><p>${escapeHtml(turn.text||'')}</p></div>${provenance}<div class="voice-audio-original" aria-live="polite"></div></div>`;
}
function naturalCorrectionTargets(conversation,correctionTurn){
  return [];
}
function naturalCorrectionReviewHtml(correction,targets,review){
  return `<div class="correction-review" data-natural-correction-form data-correction-turn-id="${escapeHtml(correction.turn_id)}"><b>更正已作为新原话保留</b><p role="status">较早原话不会被回写。如需补充，请在下方继续输入；这条更正仍保留在对话中，不会调用模型。</p><button class="chat-secondary-action" type="button" data-natural-correction-cancel>知道了</button></div>`;
}
async function confirmNaturalCorrection(button){
  const form=button?.closest('[data-natural-correction-form]'),conversation=activeConversation;
  const correction=turnById(form?.dataset.correctionTurnId),choice=form?.querySelector('[data-natural-correction-target]:checked');
  const review=pendingCorrectionReview;
  if(saveBusy||!conversation?.conversation_id||!correction||!review||review.turnId!==correction.turn_id||!choice||!form.querySelector('[data-natural-correction-confirm]')?.checked)return false;
  const target=naturalCorrectionTargets(conversation,correction).find(item=>item.key===choice.value);
  if(!target)return false;
  review.selectedKey=target.key;review.confirmed=true;review.busy=true;review.error='';saveBusy=true;renderVoiceConversation();setVoiceStatus('正在核对原话版本并保存在本机…');setVoiceComposerEnabled(false);
  try{
    let expectedEventVersion=null;
    if(target.turn.record_id){
      const source=await api(`/api/events/${encodeURIComponent(target.turn.record_id)}`),event=source.j?.event;
      if(!source.r.ok||!event||event.state==='superseded'||event.source_kind!=='elder'||event.raw_text!==target.turn.text||(event.subject_id||'subject_self')!==conversation.subject_id){
        throw new Error('所选原话来源已变化或无法读取；没有保存。请重新打开对话后再核对。');
      }
      expectedEventVersion=event.version;
    }
    const result=await api(`/api/conversations/${encodeURIComponent(conversation.conversation_id)}/corrections/${encodeURIComponent(correction.turn_id)}`,{
      method:'POST',body:JSON.stringify({expected_conversation_version:conversation.version,expected_correction_version:correction.version,
        target_turn_id:target.turn.turn_id,expected_target_version:target.turn.version,expected_event_version:expectedEventVersion,
        old_quote:target.quote,confirmed:true}),
    });
    if(!result.r.ok||!result.j.conversation){
      const message=({stale_conversation:'对话刚有变化，没有保存；请重新打开后再核对。',stale_correction:'这条更正已有新版本，没有保存。',stale_target:'所选原话已有新版本，没有保存。',conversation_source_changed:'原话记录已变化或被其他对话使用，没有保存。',correction_target_invalid:'目标必须是同一对话中更早的一整句原话，且只能出现一次。',correction_not_pending:'这条更正已变化或不再待核实，没有保存。',correction_confirmation_required:'请先勾选确认，再保存。',correction_save_failed:'本机保存没有完成；原话和更正都仍保留。'})[result.j?.error]||'本机保存没有完成；原话和更正都仍保留，可以重新核对。';
      throw new Error(message);
    }
    pendingCorrectionReview=null;syncConversation(result.j.conversation,{speak:false});setVoiceStatus('更正已在本机保存；旧版和更正原文仍保留，自动整理待更新。本次没有调用模型。','ok');await loadEvents();return true;
  }catch(error){
    review.busy=false;review.error=error.message||'本机保存没有完成；原文仍保留，可以重试。';renderVoiceConversation();setVoiceStatus(review.error,'error');return false;
  }finally{saveBusy=false;review.busy=false;setVoiceComposerEnabled(true);renderVoiceConversation()}
}
function assistantFailureCopy(turn){
  if(turn?.provider_http_status===401||turn?.provider_http_status===403)return '这次联网回复未完成：模型服务暂时拒绝访问；原话和报告仍保存在本机。';
  if(turn?.provider_http_status===429)return '这次联网回复未完成：模型服务请求较多或受到限制，请稍后再试；原话和报告仍保存在本机。';
  const reason={model_timeout:'模型响应超时',model_network_error:'模型连接失败',model_configuration_invalid:'模型配置暂不可用',model_redirect_rejected:'模型地址安全检查未通过',model_response_too_large:'模型返回内容超限',model_output_truncated:'模型回复不完整',model_response_invalid:'模型返回内容无效',model_mock_unavailable:'当前是模拟回复，不能作为真实回答',model_schema_invalid:'模型回复未通过校验',model_evidence_invalid:'模型回复未通过来源校验',model_reply_unsafe:'模型回复未通过安全校验',reviewed_risk_invalid:'安全提示未通过核验',model_http_error:'模型服务请求失败',model_account_binding_required:'模型账户需要完成绑定',trial_authorization_required:'本次试验未获授权',trial_budget_exhausted:'本次试验额度已用尽',trial_stopped:'本次试验已停止',trial_review_required:'本次试验需要先核对',saved_audio_trial_source_changed:'录音来源发生变化',saved_audio_trial_not_authorized:'本次录音试验未获授权',audio_source_review_required:'录音文字尚未核对',session_unavailable:'登录状态暂不可用',authentication_required:'请重新登录',access_not_configured:'访问权限尚未配置',ai_rate_limited:'请求较多，请稍后再试',network_unavailable:'网络连接失败',subject_mismatch:'所属人已变化',conversation_not_found:'对话暂时无法读取',conversation_version_conflict:'对话内容已更新',http_401:'登录状态失效',http_403:'访问权限不足',http_408:'请求超时',http_409:'内容状态已变化',http_422:'回复未通过校验',http_429:'请求较多，请稍后再试',http_500:'服务暂时出错',http_502:'服务暂不可用',http_503:'服务暂不可用',http_504:'服务响应超时'}[turn?.error_code];
  return reason?`这次联网回复未完成：${reason}；原话和报告仍保存在本机。`:'这次回复未确认成功，原话已保存在本机。';
}
function correctedReorganizationFailureCopy(operation){
  const explanation=assistantFailureCopy({error_code:operation?.failure_code,provider_http_status:operation?.provider_http_status})
    .replace(/^这次联网回复未完成：/,'').replace(/；原话和报告仍保存在本机。$/,'');
  return `重新整理未完成：${explanation}；原话和修订历史仍保留，不会自动重发。您可以在本对话中明确重新整理。`;
}
function voiceTurnHtml(turn){
  const assistant=turn.role==='assistant'||turn.side==='assistant';
  const mock=isMockContent(turn);
  const audioTurn=!assistant&&turn.source_kind==='audio_transcript';
  const avatar=assistant?'<img class="chat-avatar" src="assets/brand-mascot.png?v=20260930-real-acceptance-9" alt="" aria-hidden="true">':'';
  const editing=!assistant&&conversationEditingTurnId===turn.turn_id;
  const latestTurn=(activeConversation?.turns||[]).filter(item=>!item.superseded).at(-1);
  const latestElderTurn=(activeConversation?.turns||[]).filter(item=>item.role==='elder'&&!item.superseded).at(-1);
  const consumedNewTextTrial=activeConversation?.new_text_trial?.turn_id===latestElderTurn?.turn_id;
  const canRetry=!activeConversation?.trial_control&&!activeConversation?.saved_audio_trial&&!consumedNewTextTrial&&assistant&&turn.ai_failed&&latestTurn?.turn_id===turn.turn_id;
  const canFirstSend=!assistant&&!editing&&canShowSavedTextFirstSend(activeConversation,turn);
  const quote=turn.quote_context;
  const quoteHtml=quote?`<details class="voice-quoted-message"><summary>引用了${quote.role==='assistant'?'小零':'您'}的话</summary><blockquote>${escapeHtml(quote.text||'')}</blockquote>${turn.quote_context_valid===false?'<small>原消息已变化，引用已失效。</small>':''}<button type="button" data-quote-source="${escapeHtml(quote.turn_id||'')}" ${turn.quote_context_valid===false?'disabled':''}>查看原消息</button></details>`:'';
  let content='';
  if(editing){
    content=`<label class="chat-edit-label" for="voice-turn-${escapeHtml(turn.turn_id)}">修改刚才说的话</label><textarea id="voice-turn-${escapeHtml(turn.turn_id)}" class="chat-edit-textarea" data-voice-turn-input rows="4">${escapeHtml(turn.editText??turn.text??'')}</textarea><div class="chat-edit-actions"><button class="chat-action" type="button" data-voice-turn-save>保存修改</button><button class="chat-secondary-action" type="button" data-voice-turn-cancel>取消</button></div>${turn.editStatus?`<small class="chat-edit-error">${escapeHtml(turn.editStatus)}</small>`:''}`;
  }else if(turn.audio_processing===true){
    const duration=audioDurationLabel(turn.audio_duration_seconds);
    const status=turn.pending_audio_stage==='sending'?'正在生成回复…':turn.pending_audio_stage==='transcribing'?'正在转成文字…':'正在保存录音…';
    content=`<div class="voice-audio-message"><button class="voice-audio-bubble" type="button" disabled aria-label="${status}" style="--audio-width:144px"><span class="voice-audio-duration">${escapeHtml(duration)}</span><svg class="voice-audio-sound-icon" viewBox="0 0 28 24" aria-hidden="true"><path class="speaker-shape" d="M3 9v6h5l6 5V4L8 9H3z"/><path class="sound-wave sound-wave-one" d="M18 8a8 8 0 0 1 0 8"/><path class="sound-wave sound-wave-two" d="M21 5a12 12 0 0 1 0 14"/></svg></button><div class="voice-transcript-bubble"><p>${escapeHtml(turn.text||status)}</p></div></div>`;
  }else if(audioTurn&&turn.media_id&&!mock){
    const source=turn.audio_source_invalidated?'录音来源已变化 · 当前文字待重新核对':turn.audio_source_reviewed===true?'文字已对照原音核对（非医学确认）':turn.audio_source_status==='user_edited'?'识别文字已修改 · 尚未对照原音':turn.audio_source_status==='machine_transcribed'?'语音识别文字 · 尚未人工核对':'历史录音文字 · 状态待确认';
    content=typeof unavailableConversationOriginalIds!=='undefined'&&unavailableConversationOriginalIds.has(turn.media_id)?`<div class="voice-transcript-bubble"><p>${escapeHtml(turn.text||'')}</p></div><small class="voice-audio-provenance">没有找到这段录音原件</small>`:voiceAudioMessageHtml(turn,source,{showProvenance:false,edited:turn.audio_source_status==='user_edited',notice:turn.audio_source_invalidated?'录音来源已变化，请重新打开记录':''});
  }else{
    content=assistant&&turn.ai_failed?`<p>${escapeHtml(assistantFailureCopy(turn))}</p>`:`<p>${escapeHtml(turn.text||'')}</p>`;
    if(mock)content=`<p class="mock-content-warning">${escapeHtml(mockWarning)}</p><p>${escapeHtml(turn.text||'')}</p>`;
    if(assistant){
      if(!mock&&canRetry)content+='<div class="chat-inline-actions"><button type="button" data-voice-retry>重试小零回复</button></div>';
      if(['urgent','soon_evaluation'].includes(turn.action)&&!turn.ai_failed)content+='<small>固定安全提醒 · 不包含诊断或用药建议</small>';
    }else{
      const audio=turn.source_kind==='audio_transcript',unreviewedAudio=audio&&turn.audio_source_reviewed!==true,source=mock?'模拟识别结果（非患者原话）':unreviewedAudio?'机器识别文字 · 尚未核对，不作为患者事实':audio?'语音文字已对照原音':'已加密保存在本机';
      content+=`<small>${escapeHtml(source)}${turn.version>1?` · 已修改，第 ${turn.version} 版`:''}</small>`;
      if(canFirstSend)content+=`<div class="chat-inline-actions"><button type="button" data-voice-first-send${saveBusy?' disabled':''}>把这段话发给小零</button></div>`;
      if(!mock&&audio)content+=`<small>${turn.audio_source_invalidated?'录音来源已变化 · 当前文字待重新核对':unreviewedAudio?'机器识别文字 · 尚未核对，不作为患者事实':'语音文字已对照原音'}</small>`;
    }
  }
  if(quoteHtml&&!assistant)content+=quoteHtml;
  return `<article class="chat-turn ${assistant?'assistant-turn':'user-turn'}${audioTurn&&!mock&&!editing?' audio-turn':''}${turn.pending?' pending-turn':''}" data-voice-turn="${escapeHtml(turn.turn_id||'')}" tabindex="0" aria-haspopup="menu" aria-label="${assistant?'小零':'老人'}消息，长按或按菜单键查看操作">${avatar}<div class="chat-bubble ${assistant?'assistant-bubble':'user-bubble'}${turn.error?' error-bubble':''}${editing?' editing-bubble':''}">${content}</div></article>`;
}
let voiceTurnMenuFocus=null,voiceTurnPressTimer=0,voiceTurnPressTarget=null;
let voiceTurnMenuGlobalsBound=false;
function cancelVoiceTurnPress(){if(voiceTurnPressTimer)clearTimeout(voiceTurnPressTimer);voiceTurnPressTimer=0;voiceTurnPressTarget=null}
function closeVoiceTurnMenu(restore=true){const menu=$('voiceTurnMenu'),target=voiceTurnMenuFocus;voiceTurnMenuFocus=null;if(menu){menu.classList?.add('hidden');menu.replaceChildren?.()}if(restore&&target?.isConnected)target.focus?.({preventScroll:true})}
function followupTargetTurn(conversation,target){
  if(target?.invalid===true)return null;
  if(typeof activeHealthSubjectId!=='undefined'&&(conversation?.subject_id||'subject_self')!==activeHealthSubjectId
    ||typeof healthSubjectSwitchBusy!=='undefined'&&healthSubjectSwitchBusy
    ||typeof healthSubjectChanged!=='undefined'&&healthSubjectChanged)return null;
  const matches=(conversation?.turns||[]).filter(turn=>turn.turn_id===target?.turn_id);
  const turn=matches[0];if(matches.length!==1||!turn||!['elder','assistant'].includes(turn.role)||turn.superseded||turn.ai_failed||isMockContent(turn)
    ||turn.text!==target.text||(turn.version??1)!==target.version)return null;
  if(turn.role==='assistant'&&(!['ask','reply','finish','urgent','soon_evaluation'].includes(turn.action)
    ||(conversation.stale_responding_to_turn_ids||[]).includes(turn.turn_id)))return null;
  if(turn.role==='assistant'){
    const selected=new Set(conversation.selected_context_ids||[]),saved=new Set((conversation.health_context||[]).map(item=>item.context_id));
    if(Array.isArray(turn.model_context_ids)&&turn.model_context_ids.some(id=>!selected.has(id)||!saved.has(id)))return null;
  }else if(turn.source_kind==='audio_transcript'&&(turn.audio_source_invalidated===true
    ||!['original_comparison','machine_transcribed','user_edited'].includes(turn.audio_source_status||'original_comparison')))return null;
  return turn;
}
function voiceSupplementTurn(conversation,turnId){
  const matches=(conversation?.turns||[]).filter(turn=>turn.turn_id===turnId),turn=matches[0];
  return matches.length===1&&turn?.role==='elder'&&!turn.superseded&&!isMockContent(turn)
    &&(turn.source_kind!=='audio_transcript'||turn.audio_source_reviewed===true&&!turn.audio_source_invalidated);
}
function selectVoiceSupplement(turnId){
  const turn=(activeConversation?.turns||[]).find(item=>item.turn_id===turnId),input=$('voiceTextInput');
  if(!input||!voiceSupplementTurn(activeConversation,turnId)||activeConversation?.trial_control||activeConversation?.saved_audio_trial){
    setVoiceStatus('这段原话当前不可用于补充；没有改动输入。','error');return false;
  }
  clearVoiceFollowupTarget();const quote=`补充我刚才说的原话：“${turn.text}”\n补充：`;input.value=input.value?`${input.value}\n${quote}`:quote;
  input.dispatchEvent?.(new Event('input',{bubbles:true}));input.focus?.();input.setSelectionRange?.(input.value.length,input.value.length);
  setVoiceComposerEnabled(true);setVoiceStatus('已把您自己的原话放进可编辑输入框；请补充后再发送。小零的回复不会作为您的原话拼入。','ok');return true;
}
function updateVoiceFollowupReference(){
  const panel=$('voiceFollowupReference'),label=$('voiceFollowupReferenceText'),input=$('voiceTextInput');if(!panel||!label)return;
  const full=$('voiceFollowupReferenceFull'),shortcuts=$('voiceQuoteShortcuts');
  if(!pendingFollowupTarget){panel.classList.add('hidden');label.textContent='';if(full)full.textContent='';shortcuts?.classList.add('hidden');if(input?.dataset.defaultPlaceholder)input.placeholder=input.dataset.defaultPlaceholder;return}
  const role=pendingFollowupTarget.role==='assistant'?'小零':'您',quote=`${role}说：“${pendingFollowupTarget.text}”`;
  panel.classList.remove('hidden');label.textContent=pendingFollowupTarget.invalid?'这条原话已变化，不能作为追问依据。':quote;
  if(full)full.textContent=quote;
  shortcuts?.classList.toggle('hidden',Boolean(pendingFollowupTarget.invalid));
  if(input){input.dataset.defaultPlaceholder||=input.placeholder;input.placeholder='请输入想追问的话'}
}
function clearVoiceFollowupTarget(){pendingFollowupTarget=null;updateVoiceFollowupReference()}
function invalidateVoiceFollowupTarget(){if(pendingFollowupTarget&&!pendingFollowupTarget.invalid){pendingFollowupTarget={...pendingFollowupTarget,invalid:true};updateVoiceFollowupReference()}}
function selectVoiceFollowupTarget(turnId){
  const turn=(activeConversation?.turns||[]).find(item=>item.turn_id===turnId),version=turn?.version??1;
  if(!turn||!followupTargetTurn(activeConversation,{turn_id:turnId,version,text:turn.text})||activeConversation?.trial_control||activeConversation?.saved_audio_trial){
    setVoiceStatus('这条回复已变化、来源不可用或当前属于单次试验；没有设置追问，请重新打开对话核对。','error');return false;
  }
  pendingFollowupTarget={conversation_id:activeConversation.conversation_id,subject_id:activeConversation.subject_id||'subject_self',turn_id:turn.turn_id,role:turn.role,version,text:turn.text};
  updateVoiceFollowupReference();const input=$('voiceTextInput');input?.focus?.();setVoiceComposerEnabled(true);
  setVoiceStatus('已选中。输入想追问的话，或选择快捷问题。','ok');return true;
}
async function sendVoiceQuoteShortcut(text){
  if(!pendingFollowupTarget||pendingFollowupTarget.invalid)return false;
  const input=$('voiceTextInput'),draft=input?.value||'';
  const ok=await submitConversationText(text,{from_quote_shortcut:true});
  if(input)input.value=draft;
  if(ok)clearVoiceFollowupTarget();
  return ok;
}
function openVoiceTurnMenu(turnNode,x,y){
  if(!turnNode?.isConnected)return;
  const turn=turnById(turnNode?.dataset.voiceTurn),menu=$('voiceTurnMenu');if(!turn||!menu||turn.pending||isMockContent(turn))return;
  voiceTurnMenuFocus=turnNode;
  const icons={copy:'<path d="M7 7V4h11v12h-3M4 8h11v12H4z"/>',edit:'<path d="m5 15-.8 4 4-.8L19 7.4 15.6 4zM13.8 5.8l4.4 4.4"/>',replay:'<path d="M20 11a8 8 0 0 0-14-5L4 8m0-4v4h4m-4 5a8 8 0 0 0 14 5l2-2m0 4v-4h-4"/>'};
  const quoteAllowed=!activeConversation?.trial_control&&!activeConversation?.saved_audio_trial
    &&followupTargetTurn(activeConversation,{turn_id:turn.turn_id,version:turn.version??1,text:turn.text});
  const supplement=turn.role==='elder'&&voiceSupplementTurn(activeConversation,turn.turn_id)?[['supplement','补充这段']]:[];
  const canEdit=turn.role==='elder'&&latestEditableOwnTurn(activeConversation)?.turn_id===turn.turn_id;
  const actions=[['followup','追问这句话',!quoteAllowed],...(turn.role==='elder'?[...(canEdit?[['edit','修改',false]]:[]),...supplement.map(item=>[...item,false])]:[['replay','再听一遍',false]]),['copy','复制',false],['select','选取文字',false]];
  menu.innerHTML=`<div class="voice-menu-row" role="group" aria-label="消息操作">${actions.map(([action,label,disabled])=>`<button type="button" role="menuitem" data-turn-menu-action="${action}"${disabled?' disabled':''}><svg class="voice-menu-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[action]||'<path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5"/>'}</svg><span>${label}</span></button>`).join('')}</div>`;
  menu.classList.remove('hidden');const bounds=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(x,innerWidth-bounds.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,innerHeight-bounds.height-8))}px`;
  menu.querySelectorAll('[data-turn-menu-action]').forEach(button=>button.onclick=async()=>{
    const action=button.dataset.turnMenuAction;
    const returnFocus=voiceTurnMenuFocus;closeVoiceTurnMenu(false);
    if(action==='copy'){try{await navigator.clipboard.writeText(turn.text||'');toast('已复制这条消息')}catch{toast('当前无法复制，请长按文字选择')}}
    if(action==='edit')beginVoiceTurnEdit(turn.turn_id);
    if(action==='replay')speakAssistant(turn,true);
    if(action==='followup')selectVoiceFollowupTarget(turn.turn_id);
    if(action==='supplement')selectVoiceSupplement(turn.turn_id);
    if(action==='select'){
      const textNode=turnNode.querySelector('.voice-transcript-bubble p, .chat-bubble p');
      if(textNode&&document.createRange&&window.getSelection){const range=document.createRange();range.selectNodeContents(textNode);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)}
      voiceTurnMenuFocus=null;return;
    }
    if(action==='copy'||action==='replay'){if(returnFocus?.isConnected)returnFocus.focus?.({preventScroll:true});voiceTurnMenuFocus=null;return}
    voiceTurnMenuFocus=null;
  });menu.querySelector('[role="menuitem"]')?.focus();
}
function bindVoiceTurnMenus(box){
  if(!voiceTurnMenuGlobalsBound){
    document.addEventListener?.('pointerdown',event=>{const menu=$('voiceTurnMenu');if(menu&&!menu.classList.contains('hidden')&&!menu.contains(event.target))closeVoiceTurnMenu()});
    document.addEventListener?.('keydown',event=>{if(event.key==='Escape'&&!$('voiceTurnMenu')?.classList.contains('hidden')){event.preventDefault();closeVoiceTurnMenu()}});
    document.addEventListener?.('keydown',event=>{
      const menu=$('voiceTurnMenu');if(!menu||menu.classList.contains('hidden')||!['ArrowLeft','ArrowRight','ArrowDown','ArrowUp'].includes(event.key))return;
      const items=[...menu.querySelectorAll('[role="menuitem"]')];if(!items.length)return;
      const index=Math.max(0,items.indexOf(document.activeElement)),delta=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1;
      event.preventDefault();items[(index+delta+items.length)%items.length].focus();
    });
    voiceTurnMenuGlobalsBound=true;
  }
  box.querySelectorAll('[data-voice-turn]').forEach(node=>{
    node.oncontextmenu=event=>{event.preventDefault();openVoiceTurnMenu(node,event.clientX,event.clientY)};
    node.onkeydown=event=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();const rect=node.getBoundingClientRect();openVoiceTurnMenu(node,rect.left,rect.bottom)}};
    if(node.dataset.voiceMenuTouchBound!=='true'){
      node.dataset.voiceMenuTouchBound='true';
      node.addEventListener('touchstart',event=>{cancelVoiceTurnPress();if(event.target.closest?.('button,textarea,input,select'))return;const touch=event.touches?.[0];if(!touch)return;voiceTurnPressTarget=node;node.dataset.pressX=touch.clientX;node.dataset.pressY=touch.clientY;const x=touch.clientX,y=touch.clientY;const timer=setTimeout(()=>{if(voiceTurnPressTimer!==timer)return;voiceTurnPressTimer=0;voiceTurnPressTarget=null;openVoiceTurnMenu(node,x,y)},550);voiceTurnPressTimer=timer},{passive:true});
      node.addEventListener('touchmove',event=>{const touch=event.touches?.[0];if(!touch||Math.abs(touch.clientX-Number(node.dataset.pressX))>10||Math.abs(touch.clientY-Number(node.dataset.pressY))>10)cancelVoiceTurnPress()},{passive:true});
      node.addEventListener('touchend',cancelVoiceTurnPress,{passive:true});
      node.addEventListener('touchcancel',cancelVoiceTurnPress,{passive:true});
    }
  });
}
function renderVoiceConversation(){
  const box=$('voiceConversationTurns');if(!box)return;
  const scroller=$('voiceConversation'),distanceFromBottom=scroller?scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight:0;
  const followTail=Boolean(scroller)&&(distanceFromBottom<96||pendingConversationTurn?.followOnRender===true);
  if(pendingConversationTurn?.followOnRender)pendingConversationTurn.followOnRender=false;
  cancelVoiceTurnPress();closeVoiceTurnMenu(false);
  if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(box);
  const turns=(activeConversation?.turns||[]).filter(turn=>!turn.superseded);
  box.innerHTML=[...turns,pendingConversationTurn].filter(Boolean).map(voiceTurnHtml).join('');
  box.querySelectorAll('[data-quote-source]').forEach(button=>button.onclick=()=>{
    const source=turnById(button.dataset.quoteSource);if(!source)return;
    const node=[...box.querySelectorAll('[data-voice-turn]')].find(item=>item.dataset.voiceTurn===source.turn_id);
    node?.scrollIntoView?.({behavior:reducedMotion()?'auto':'smooth',block:'center'});node?.focus?.({preventScroll:true});
  });
  if(pendingConversationTurn?.audio_processing&&pendingConversationTurn.pending_audio_stage==='sending'){
    box.insertAdjacentHTML('beforeend',`<article class="chat-turn assistant-turn pending-assistant-turn" role="status"><img class="chat-avatar" src="assets/brand-mascot.png?v=20260930-real-acceptance-9" alt="" aria-hidden="true"><div class="chat-bubble assistant-bubble"><p>小零正在生成回复…</p></div></article>`);
  }
  bindVoiceTurnMenus(box);
  if(activeConversation?.manual_correction_analysis_pending===true){
    const pendingAudio=turns.some(legacyAudioNeedsExplicitRecovery);
    const sending=activeConversation.manual_correction_reorganization?.state==='sending';
    const operation=activeConversation.manual_correction_reorganization||{};
    const action=pendingAudio?'先打开这段录音的记录详情，对照原录音核对文字；核对前不会整理或生成回复。':sending?'上次整理请求状态尚未确认；为避免重复发送，本次不会自动重试。':operation.state==='failed'?correctedReorganizationFailureCopy(operation):'原话和修订历史已保存；自动整理待更新。确认后可在本对话中明确重新整理。';
    box.insertAdjacentHTML('beforeend',`<div class="chat-turn correction-reorganization" role="status"><div class="chat-bubble assistant-bubble"><b>${pendingAudio?'更正后的录音文字待核对':'原话已更正，整理结果待更新'}</b><p>${escapeHtml(action)}</p>${!pendingAudio?`<button class="chat-action" type="button" data-correction-reorganize ${saveBusy||sending?'disabled':''}>${sending?'等待核对，不会自动重发':'按更正后的原话重新整理'}</button>`:''}</div></div>`);
    box.querySelector('[data-correction-reorganize]')?.addEventListener('click',event=>void reorganizeCorrectedConversation(event.currentTarget));
  }
  const recoveryCandidates=pendingAudioReviewCandidates.filter(item=>item.conversation_id===activeConversation?.conversation_id);
  if(recoveryCandidates.length){
    box.insertAdjacentHTML('beforeend',recoveryCandidates.map(item=>{
      const turn={turn_id:`recovery-${item.media_id}`,media_id:item.media_id,text:item.recovery_text,audio_duration_seconds:item.duration_seconds};
      const source=item.recovery_source_reviewed?'已对照原音核对文字（非医学确认）':'机器转写 · 尚未人工核对';
      return `<article class="chat-turn user-turn audio-turn audio-recovery-turn" data-audio-recovery="${escapeHtml(item.media_id)}" tabindex="0"><div class="chat-bubble user-bubble">${voiceAudioMessageHtml(turn,source,{recovery:true,showProvenance:false,edited:turn.audio_source_status==='user_edited'})}<button class="audio-recovery-continue" type="button" data-audio-recovery-continue="${escapeHtml(item.media_id)}">继续聊这段</button></div></article>`;
    }).join(''));
    box.querySelectorAll('[data-audio-recovery-continue]').forEach(button=>button.addEventListener('click',()=>void continueRecoveredAudioCandidate(button.dataset.audioRecoveryContinue,button)));
    box.querySelectorAll('[data-recovery-audio-play]').forEach(button=>button.addEventListener('click',async()=>{
      const item=recoveryCandidates.find(candidate=>candidate.media_id===button.dataset.recoveryAudioPlay);
      const target=button.closest('.voice-audio-message')?.querySelector('.voice-audio-original');if(!item||!target)return;
      let audio=target.querySelector('audio');
      if(!audio){const turn={role:'elder',source_kind:'audio_transcript',media_id:item.media_id,record_id:item.recovery_record_id,text:item.recovery_text,
        audio_source_reviewed:item.recovery_source_reviewed===true,audio_source_version:item.recovery_source_version,
        audio_source_media_version:item.version,audio_source_conversation_id:item.conversation_id};
        if(!await showConversationOriginal(turn,target,activeConversation,{compact:true}))return;audio=target.querySelector('audio')}
      if(!audio)return;
      try{if(!audio.paused){audio.pause();button.setAttribute('aria-pressed','false')}else{
        document.querySelectorAll('.voice-audio-original audio').forEach(other=>{if(other!==audio)other.pause()});
        await audio.play();button.setAttribute('aria-pressed','true');
        audio.addEventListener('ended',()=>button.setAttribute('aria-pressed','false'),{once:true});
        audio.addEventListener('loadedmetadata',()=>{const label=audioDurationLabel(audio.duration),slot=button.querySelector('[data-audio-duration]');if(slot)slot.textContent=label;if(label)button.setAttribute('aria-label',`播放录音，${label}`)} ,{once:true});
      }}catch{setVoiceStatus('原录音暂时无法播放；识别文字仍保留。','error')}
    }));
  }
  if(pendingAudioReview&&pendingAudioReview.conversation_id===activeConversation?.conversation_id){
    const review=pendingAudioReview,text=review.draftText??review.text,alreadyReviewed=review.reviewed&&text===review.reviewedText;
    const reviewIntro=alreadyReviewed?'这段文字此前已在记录中对照原音核对，但还没有进入本次对话。点击下方按钮会把当前核对版本接回本次对话。':'这是语音识别草稿，可能有错。对照原音确认后，文字才会进入本次对话；这不等于确认医学事实。';
    box.insertAdjacentHTML('beforeend',`<div class="chat-turn audio-review-turn"><div class="chat-bubble assistant-bubble" style="width:min(100%,34em);max-width:min(100%,34em)"><b>${alreadyReviewed?'把已核对录音接回本次对话':'请对照录音核对文字'}</b><p>${reviewIntro}</p><label class="chat-edit-label" for="audioTranscriptReviewText">识别文字，可在核对后修改</label><textarea id="audioTranscriptReviewText" class="chat-edit-textarea" rows="4" maxlength="10000">${escapeHtml(text)}</textarea><button class="chat-secondary-action" type="button" data-audio-review-play ${review.busy?'disabled':''}>对照并播放原录音</button><div class="voice-audio-original" data-audio-review-original aria-live="polite"></div><label class="audio-review-confirm"><input type="checkbox" data-audio-review-check ${review.played?'':'disabled'} ${review.confirmed?'checked':''}>我已对照原录音，确认上面的文字与录音一致</label><small data-audio-review-status role="status">${alreadyReviewed?'文字已在记录中核对；点击下方按钮仅将它加入本次对话。':review.played?'可勾选确认；核对文字不会确认医学事实。':'请先播放原录音，再核对文字。'}</small><button class="chat-action" type="button" data-audio-review-confirm ${review.busy||(!alreadyReviewed&&(!review.played||!review.confirmed))?'disabled':''}>${alreadyReviewed?'把已核对文字加入本次对话':'确认文字准确并继续对话'}</button>${review.trialControlled?'':`<div class="audio-review-exit-actions"><button class="chat-secondary-action" type="button" data-audio-review-text-continue>先用文字继续</button><button class="chat-secondary-action" type="button" data-audio-review-new>另记新的情况</button></div>`}</div></div>`);
    const textarea=box.querySelector('[data-audio-review-text]')||box.querySelector('#audioTranscriptReviewText');
    textarea?.addEventListener('input',()=>{
      review.draftText=textarea.value;review.confirmed=false;
      const check=box.querySelector('[data-audio-review-check]');if(check)check.checked=false;
      const submit=box.querySelector('[data-audio-review-confirm]');if(submit)submit.disabled=review.busy||(!review.confirmed&&!(review.reviewed&&review.draftText===review.reviewedText));
      if(submit)submit.textContent=review.reviewed&&review.draftText===review.reviewedText?'把已核对文字加入本次对话':'确认文字准确并继续对话';
      const status=box.querySelector('[data-audio-review-status]');if(status)status.textContent=review.reviewed&&review.draftText===review.reviewedText?'文字已在记录中核对；点击下方按钮仅将它加入本次对话。':review.played?'文字有修改，请再次勾选确认。':'请先播放原录音，再核对文字。';
    });
    box.querySelector('[data-audio-review-play]')?.addEventListener('click',playPendingAudioOriginal);
    box.querySelector('[data-audio-review-check]')?.addEventListener('change',event=>{
      review.confirmed=event.target.checked===true;
      const submit=box.querySelector('[data-audio-review-confirm]');if(submit)submit.disabled=review.busy||(!review.confirmed&&!(review.reviewed&&review.draftText===review.reviewedText));
    });
    box.querySelector('[data-audio-review-confirm]')?.addEventListener('click',confirmPendingAudioReview);
    box.querySelector('[data-audio-review-text-continue]')?.addEventListener('click',continueWithTextInsteadOfAudio);
    box.querySelector('[data-audio-review-new]')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;if(!await startSeparateConversation())event.currentTarget.disabled=false});
  }
  const pendingLegacyAudio=turns.find(legacyAudioNeedsExplicitRecovery);
  if(pendingLegacyAudio&&!pendingAudioReview){
    box.insertAdjacentHTML('beforeend',`<div class="chat-turn"><div class="chat-bubble assistant-bubble" style="width:min(100%,34em);max-width:min(100%,34em)"><b>这段历史录音还没核对</b><p>识别文字和原录音仍保留，但尚未核对前不会用于回复或报告。您可以打开记录对照原音，也可以先记录新的情况；这段录音不会自动带入新对话。</p>${pendingLegacyAudio.record_id?`<button class="chat-secondary-action" type="button" data-legacy-audio-open>打开记录核对原音</button>`:''}<button class="chat-action" type="button" data-legacy-audio-new>暂不使用这段录音，记录新的情况</button></div></div>`);
    box.querySelector('[data-legacy-audio-open]')?.addEventListener('click',()=>{showView('recordsView');showDetail(pendingLegacyAudio.record_id)});
    box.querySelector('[data-legacy-audio-new]')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;const started=await startSeparateConversation();if(!started)event.currentTarget.disabled=false});
  }
  const latestVoiceTurn=turns.at(-1);
  if(latestVoiceTurn?.role==='elder'&&latestVoiceTurn.source_kind==='audio_transcript'&&['machine_transcribed','user_edited'].includes(latestVoiceTurn.audio_source_status)
    &&latestVoiceTurn.quote_context_valid!==false){
    box.insertAdjacentHTML('beforeend',`<div class="chat-turn audio-reply-pending" role="status"><div class="chat-bubble assistant-bubble"><p>这段机器转写已保存在本机；重新打开不会自动重发。</p><button class="chat-action" type="button" data-audio-explicit-retry ${saveBusy?'disabled':''}>继续请求一次回复</button></div></div>`);
    box.querySelector('[data-audio-explicit-retry]')?.addEventListener('click',event=>void retryPendingAudioReply(event.currentTarget));
  }
  if(activeConversation?.trial_control){const control=activeConversation.trial_control;box.insertAdjacentHTML('beforeend',`<div class="chat-turn"><div class="chat-bubble"><p>${escapeHtml(trialVoiceMessage(control))}</p>${control.state==='review_required'?`<button class="chat-action" type="button" data-trial-continue ${saveBusy?'disabled':''}>核对并获准后继续一次</button>`:''}</div></div>`);box.querySelector('[data-trial-continue]')?.addEventListener('click',continueTrialVoice)}
  box.querySelectorAll('[data-voice-turn-cancel]').forEach(button=>button.onclick=cancelVoiceTurnEdit);
  box.querySelectorAll('[data-voice-turn-save]').forEach(button=>button.onclick=()=>saveVoiceTurnEdit(button.closest('[data-voice-turn]')?.dataset.voiceTurn,button.closest('.chat-bubble')?.querySelector('[data-voice-turn-input]')?.value||''));
  box.querySelectorAll('[data-natural-correction-review]').forEach(button=>button.onclick=()=>{
    const turn=turnById(button.closest('[data-voice-turn]')?.dataset.voiceTurn);if(!pendingNaturalCorrection(activeConversation,turn))return;
    pendingCorrectionReview={turnId:turn.turn_id,conversationId:activeConversation.conversation_id,selectedKey:'',confirmed:false,busy:false,error:''};renderVoiceConversation();
  });
  box.querySelectorAll('[data-natural-correction-target]').forEach(input=>input.onchange=()=>{
    if(pendingCorrectionReview?.turnId!==input.closest('[data-natural-correction-form]')?.dataset.correctionTurnId)return;
    pendingCorrectionReview.selectedKey=input.value;pendingCorrectionReview.confirmed=false;pendingCorrectionReview.error='';renderVoiceConversation();
  });
  box.querySelectorAll('[data-natural-correction-confirm]').forEach(input=>input.onchange=()=>{
    if(pendingCorrectionReview?.turnId!==input.closest('[data-natural-correction-form]')?.dataset.correctionTurnId)return;
    pendingCorrectionReview.confirmed=input.checked===true;renderVoiceConversation();
  });
  box.querySelectorAll('[data-natural-correction-save]').forEach(button=>button.onclick=()=>void confirmNaturalCorrection(button));
  box.querySelectorAll('[data-natural-correction-cancel]').forEach(button=>button.onclick=()=>{if(saveBusy)return;pendingCorrectionReview=null;renderVoiceConversation()});
  bindConversationSourceActions(box,activeConversation);
  box.querySelectorAll('[data-voice-retry]').forEach(button=>button.onclick=()=>retryConversationReply(button));
  box.querySelectorAll('[data-voice-first-send]').forEach(button=>button.onclick=()=>sendSavedTextFirst(button));
  const editingTurn=conversationEditingTurnId;
  (window.requestAnimationFrame||((fn)=>setTimeout(fn,0)))(()=>{
    if(editingTurn){
      box.querySelector('[data-voice-turn-input]')?.closest?.('[data-voice-turn]')?.scrollIntoView?.({block:'center',behavior:'auto'});
      return;
    }
    if(followTail)scroller.scrollTo?.({top:scroller.scrollHeight,behavior:reducedMotion()?'auto':'smooth'});
  });
}
async function retryPendingAudioReply(button){
  const latest=(activeConversation?.turns||[]).filter(turn=>!turn.superseded).at(-1);
  if(saveBusy||!activeConversation?.conversation_id||latest?.role!=='elder'||latest.source_kind!=='audio_transcript'||!['machine_transcribed','user_edited'].includes(latest.audio_source_status))return false;
  saveBusy=true;if(button)button.disabled=true;setVoiceComposerEnabled(false);setVoiceStatus('正在检查录音来源并请求一次回复…');
  try{const x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/resume-assistant`,{method:'POST',body:JSON.stringify({explicit_audio_retry:true,expected_version:activeConversation.version})});
    if(x.j?.conversation)syncConversation(x.j.conversation,{speak:false});
    if(!x.r.ok||x.j?.ai_failed){setVoiceStatus('回复没有完成；录音、转写和原话仍保留，可稍后再试。','error');return false}
    setVoiceStatus('已收到回复；录音与机器转写仍标记为未核对。','ok');return true;
  }catch{setVoiceStatus('回复没有完成；录音、转写和原话仍保留。','error');return false}
  finally{saveBusy=false;setVoiceComposerEnabled(true);renderVoiceConversation()}
}
function turnById(turnId){return activeConversation?.turns?.find(turn=>turn.turn_id===turnId&&!turn.superseded)}
function localDateValue(){
  const date=new Date(),offset=date.getTimezoneOffset()*60000;
  return new Date(date.getTime()-offset).toISOString().slice(0,10);
}
function renderConversationReport(){
  const report=activeConversation?.report,button=$('openConversationReportBtn'),body=$('conversationReportBody');
  if(button)button.disabled=!report;
  const detailButton=$('openConversationDetailBtn');if(detailButton)detailButton.disabled=!activeConversation?.conversation_id;
  const refreshButton=$('refreshConversationReportBtn');
  if(refreshButton)refreshButton.disabled=!report||!activeConversation?.conversation_id||activeConversation.manual_correction_analysis_pending===true||reportRefreshBusy;
  if(!body)return;
  if(!report){body.innerHTML='<p class="muted">说完第一句话后，这里会自动生成报告。</p>';return}
  $('conversationReportStatus').textContent=report.status_label||'自动整理 · 本人未核对';
  const transcript=(report.transcript||[]).filter(turn=>!isMockContent(turn));
  const readingGuide=report.manual_correction_analysis_pending===true?'原话已修订，以下逐段保留当前原话；自动整理待更新。':`按就诊时最常用的顺序整理，共保留 ${report.source_turn_ids?.length||0} 段患者原话。`;
  const history=[...(activeConversation.report_history||[])].filter(item=>item&&item.version!==report.version)
    .filter((item,index,list)=>list.findIndex(other=>other.version===item.version)===index).sort((a,b)=>(b.version||0)-(a.version||0));
  const historyHtml=history.length?`<details class="report-history"><summary>查看旧版报告（${history.length}）</summary>${history.map(item=>{
    const date=item.generated_at?new Date(item.generated_at).toLocaleString('zh-CN'):'日期未记录';
    const sections=(item.sections||[]).map(section=>`<section><h3>${escapeHtml(section.title||'')}</h3>${(section.lines||[]).map(line=>`<p>${escapeHtml(line.text||'')}</p>`).join('')}</section>`).join('');
    const transcriptHtml=Array.isArray(item.transcript)?`<details><summary>查看当时原话（${item.transcript.length}段）</summary><ol>${item.transcript.map(turn=>`<li><span>${turn.role==='assistant'?'小零':'老人'}</span><p>${escapeHtml(turn.text||'')}</p></li>`).join('')}</ol></details>`:'';
    return `<article class="report-history-item"><h3>第 ${item.version||1} 版 · ${escapeHtml(date)}</h3>${sections}${transcriptHtml}</article>`;
  }).join('')}</details>`:'';
  body.innerHTML=`<p><strong>就诊对象：</strong>${escapeHtml(reportSubjectLabel(activeConversation.subject_id))}</p><p class="report-reading-guide">${escapeHtml(readingGuide)}</p>`+(transcript.length!==(report.transcript||[]).length?'<p class="status error">历史模拟识别文字已从报告事实中排除，仅在完整对话历史中保留。</p>':'')+reportSectionsHtml(report)+reportOriginalSourcesHtml(report)+`<details class="report-transcript"><summary>查看完整对话（${report.transcript?.length||0} 轮）</summary><ol>${(report.transcript||[]).map(turn=>`<li><span>${turn.role==='assistant'?'小零':'老人'}${isMockContent(turn)?' · 模拟内容，不是患者事实':''}</span><p>${escapeHtml(turn.text||'')}</p></li>`).join('')||`<li><p>${escapeHtml(isMockContent(report.body)?'历史报告内容无法确认来源，原始记录仍保留。':report.body||'')}</p></li>`}</ol></details>${historyHtml}<p class="report-source-note">第 ${report.version||1} 版 · 修改聊天原话后，这份记录会自动更新。关键事实始终以患者原话为准。</p>`;
}
let reportRefreshBusy=false;
async function refreshConversationReport(){
  const conversation=activeConversation,status=$('refreshConversationReportStatus'),button=$('refreshConversationReportBtn');
  if(!conversation?.conversation_id||!conversation.report||reportRefreshBusy||conversation.manual_correction_analysis_pending===true)return;
  reportRefreshBusy=true;renderConversationReport();
  if(status)status.textContent='正在只用已绑定的原话和资料更新报告；不会生成新的 AI 回复。';
  try{
    const contextResult=await HealthLocal.request('/api/health-memory');
    if(!contextResult?.r?.ok||!contextResult?.j?.health_context)throw new Error('context_unavailable');
    const result=await HealthLocal.request(`/api/conversations/${encodeURIComponent(conversation.conversation_id)}/refresh-report`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        expected_conversation_version:conversation.version,expected_subject_id:conversation.subject_id||activeHealthSubjectId,
        expected_subject_version:healthSubjectsVersion,expected_context_version:contextResult.j.health_context.version,
      }),
    });
    if(result?.r?.ok&&result?.j?.ok&&result.j.conversation){syncConversation(result.j.conversation,{speak:false});
      if(status)status.textContent=result.j.changed===false?'报告内容没有变化，原报告保持不变。':'报告已更新；没有生成新的 AI 回复。';
    }else if(status){const error=result?.j?.error;status.textContent=error==='report_sources_not_current'?'当前原话还没有对应的整理结果；原话和本机报告已保留。请先完成对话整理，再更新报告。'
      :error==='report_correction_pending'?'原话更正尚待整理；请先完成更正核对。'
      :error==='report_update_unavailable'?'报告更新服务暂时不可用，原报告未被覆盖；请稍后重试。'
        :error==='report_update_rejected'?'当前来源暂不支持安全更新，原报告已保留。':'来源或所属人刚刚发生变化，原报告未被覆盖。请刷新对话后再试。'}
  }catch{if(status)status.textContent='报告暂时无法更新，原报告和原话都未被覆盖。请稍后重试。'}
  finally{reportRefreshBusy=false;renderConversationReport();if(button&&!button.disabled)button.focus?.({preventScroll:true})}
}
function reportSubjectLabel(subjectId){
  if(!subjectId||!healthSubjectLoaded||healthSubjectChanged)return '待确认';
  return healthSubjects.find(subject=>subject.subject_id===subjectId)?.label||(subjectId==='subject_self'?'本人':'待确认');
}
function reportSectionsHtml(report){
  report=globalThis.HealthLocal?.normalizeReportDisplay?.(report)||report;
  const sections=report?.sections||[];
  if(!sections.length)return isMockContent(report?.body)?'<p class="status error">历史报告含模拟识别内容，已从患者事实中排除。</p>':`<pre>${escapeHtml(report?.body||'')}</pre>`;
  return `<div class="clinical-report-sections">${sections.map(section=>`<section class="clinical-report-section" data-report-section="${escapeHtml(section.key||'record')}"><h3>${escapeHtml(section.title||'记录')}</h3><div class="report-fact-list">${(section.lines||[]).filter(line=>!isMockContent(line)&&!mockText(typeof line==='string'?line:line?.text)).map((line,index)=>reportFactHtml(line,index)).join('')}</div></section>`).join('')}</div>`;
}
function reportOriginalSourcesHtml(report){
  const ids=Array.isArray(report?.source_turn_ids)?report.source_turn_ids:[];
  const sources=(Array.isArray(report?.source_versions)?report.source_versions:[]).filter(source=>typeof source?.turn_id==='string'&&source.turn_id.trim()&&ids.includes(source.turn_id)&&Number.isSafeInteger(source.version)&&source.version>0&&typeof source.quote==='string'&&source.quote.trim()&&!isMockContent(source)&&!mockText(source.quote));
  const unique=sources.filter(source=>sources.filter(other=>other.turn_id===source.turn_id).length===1);
  if(!unique.length)return '';
  return `<section class="clinical-report-section report-original-sources"><h3>原话来源</h3><div class="report-fact-list"><p class="muted">以下保留每段当前原话，包括尚未整理进摘要的内容。文字核对不代表医学确认。</p>${unique.map((source,index)=>reportFactHtml({kind:'quote',text:source.quote,source_label:'当前原话',source_turn_ids:[source.turn_id],source_versions:[source]},index)).join('')}</div></section>`;
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
  if(typeof activeHealthSubjectId!=='undefined'&&conversation?.subject_id&&conversation.subject_id!==activeHealthSubjectId){clearVoiceFollowupTarget();if(typeof markHealthSubjectChanged==='function')markHealthSubjectChanged();return false}
  if(pendingCorrectionReview&&(pendingCorrectionReview.conversationId!==conversation?.conversation_id
    ||!(conversation?.turns||[]).some(turn=>turn.turn_id===pendingCorrectionReview.turnId&&!turn.superseded)))pendingCorrectionReview=null;
  if(conversation?.trial_control&&conversation.trial_control.state!=='completed')voicePermissionGeneration++;
  if(pendingMediaRetry&&pendingMediaRetry.conversation_id!==conversation?.conversation_id)pendingMediaRetry=null;
  activeConversation=conversation;conversationEditingTurnId=null;pendingConversationTurn=null;
  if(pendingFollowupTarget){
    if(pendingFollowupTarget.conversation_id!==conversation?.conversation_id
      ||pendingFollowupTarget.subject_id!==(conversation?.subject_id||'subject_self'))clearVoiceFollowupTarget();
    else if(!followupTargetTurn(conversation,pendingFollowupTarget))invalidateVoiceFollowupTarget();
  }
  document.querySelector?.('.conversation-shell')?.classList.remove('awaiting-choice');
  renderVoiceConversation();renderConversationReport();updateHealthContextButton();setVoiceComposerEnabled(true);
  if(typeof updateHealthSubjectLabels==='function')updateHealthSubjectLabels();
  const last=[...(conversation?.turns||[])].reverse().find(turn=>turn.role==='assistant'&&!turn.superseded);
  if(speak&&last&&!isMockContent(last)&&last.turn_id!==lastSpokenTurnId){
    const conversationId=conversation.conversation_id,frame=window.requestAnimationFrame||((callback)=>setTimeout(callback,16));
    frame(()=>frame(()=>{
      const latest=(activeConversation?.turns||[]).filter(turn=>!turn.superseded).at(-1);
      if(activeConversation?.conversation_id===conversationId&&latest?.turn_id===last.turn_id)speakAssistant(last);
    }));
  }
  return true;
}
function conversationHasPendingReply(conversation){
  const turns=(conversation?.turns||[]).filter(turn=>!turn.superseded),latest=turns[turns.length-1];
  return latest?.role==='elder';
}
function latestEditableOwnTurn(conversation){
  const latest=(conversation?.turns||[]).filter(turn=>turn.role==='elder'&&!turn.superseded
    &&turn.audio_source_invalidated!==true&&!isMockContent(turn)).at(-1)||null;
  if(latest?.source_kind==='audio_transcript'&&latest.audio_source_reviewed!==true
    &&!['machine_transcribed','user_edited'].includes(latest.audio_source_status))return null;
  return latest;
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
  if(latestEditableOwnTurn(activeConversation)?.turn_id!==turnId){setVoiceStatus('较早原话不能修改；可以引用或补充一条新消息。','error');return}
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
const HEALTH_CONTEXT_CATEGORY_LABELS={conditions:'疾病或长期问题',medications:'药物使用记录',allergies:'过敏情况',procedures:'手术、住院或受伤经历',tests:'已有检查或测量',similar_episodes:'以前类似情况'};
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
  const clear=$('cancelHealthContextSelectionBtn');if(clear)clear.disabled=contextSelectionSaving;
  const close=$('closeHealthContextPickerBtn');if(close)close.disabled=contextSelectionSaving;
}
function renderHealthContextPicker(){
  const list=$('healthContextPickerList');if(!list)return;
  if(contextPickerLoading){list.innerHTML='<p class="muted">正在读取本机健康背景…</p>';updateContextSelectionStatus('正在读取本机健康背景；关闭会保留原选择，也可以选择不带资料继续。');return}
  if(contextPickerLoadError){
    list.innerHTML='<div class="context-picker-empty"><p>本机健康背景暂时无法读取；这不影响继续对话，也不会清除已有选择。</p><button id="contextPickerRetryBtn" class="outline" type="button">重新读取</button></div>';
    $('contextPickerRetryBtn')?.addEventListener('click',()=>void loadHealthContextForPicker());updateContextSelectionStatus('读取失败；关闭会保留原选择，也可以选择不带资料继续。');return;
  }
  if(!healthContextEntries.length){
    list.innerHTML='<div class="context-picker-empty"><p>目前没有可带入对话的已核对资料。您可以不带资料继续。</p><button id="contextPickerOpenSettingsBtn" class="outline" type="button">去设置填写或核对健康背景</button></div>';
    $('contextPickerOpenSettingsBtn')?.addEventListener('click',()=>{closeHealthContextPicker();showView('settingsView')});
    updateContextSelectionStatus('目前没有可带入对话的已核对资料；本次可以不带资料继续。');return;
  }
  list.innerHTML=healthContextEntries.map(item=>{
    const id=escapeHtml(item.context_id||''),checked=contextDraftSelection.has(item.context_id)?' checked':'';
    const timeLabel=item.temporal_status==='current'?'目前仍适用':item.temporal_status==='historical'?'过去的情况':item.temporal_status==='uncertain'?'不确定 · 待核实':item.legacy_entry?'时间状态未核对':'';
    return `<label class="health-context-choice"><input type="checkbox" data-context-id="${id}"${checked}><span><b>${escapeHtml(HEALTH_CONTEXT_CATEGORY_LABELS[item.category]||'已确认情况')}${timeLabel?` · ${escapeHtml(timeLabel)}`:''}</b><span>${escapeHtml(item.text||'')}</span></span></label>`;
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
  const panel=$('healthContextPickerPanel');if(!panel||panel.classList.contains('hidden')||contextSelectionSaving)return;
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
async function continueWithoutHealthContextSelection(){
  const panel=$('healthContextPickerPanel');if(!panel||panel.classList.contains('hidden')||!activeConversation?.conversation_id||contextSelectionSaving)return false;
  contextPickerRequestId++;contextPickerLoading=false;contextPickerLoadError=false;contextDraftSelection.clear();renderHealthContextPicker();
  return saveHealthContextSelection({clearSelection:true});
}
async function saveHealthContextSelection({clearSelection=false}={}){
  if(!activeConversation?.conversation_id||contextSelectionSaving||(!clearSelection&&(contextPickerLoading||contextPickerLoadError)))return false;
  contextSelectionSaving=true;updateContextSelectionStatus(clearSelection?'正在保存“不带资料继续”；保存成功前，原选择仍然生效。':'正在把这次选择保存在本机；不会在此时发送健康资料。');
  try{
    const ids=clearSelection?[]:[...contextDraftSelection].slice(0,5),x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/context`,{method:'POST',body:JSON.stringify({context_ids:ids})});
    if(!x.r.ok||!x.j.conversation){
      contextSelectionSaving=false;
      const identityChanged=['subject_changed','subject_mismatch'].includes(x.j?.error);
      if(identityChanged)markHealthSubjectChanged();
      updateContextSelectionStatus(identityChanged?'所属人已变化；资料没有清除，原选择仍在本机生效。重新选择所属人后可以重试。':clearSelection?'资料没有清除；原选择仍在本机生效。可以重试，或关闭窗口保留原选择。':'选择没有保存；勾选内容还在，可以重试。');return false;
    }
    if(!syncConversation(x.j.conversation,{speak:false})){
      contextSelectionSaving=false;updateContextSelectionStatus(clearSelection?'所属人已变化；资料没有清除，原选择仍在本机生效。重新选择所属人后可以重试。':'所属人已变化；选择没有保存，原选择仍在本机生效。重新选择所属人后可以重试。');return false;
    }
    contextSelectionSaving=false;closeHealthContextPicker();
    setVoiceStatus(ids.length?`已在本机保存 ${ids.length} 项选择；下次发言时才会发送这些资料。`:'已清除资料选择；下次发言不会附带健康背景。','ok');return true;
  }catch{
    contextSelectionSaving=false;updateContextSelectionStatus(clearSelection?'资料没有清除；原选择仍在本机生效。可以重试，或关闭窗口保留原选择。':'选择没有保存；勾选内容还在，可以重试。');return false;
  }
}
async function retryConversationReply(button){
  if(activeConversation?.trial_control)return false;
  const trial=await globalThis.HealthLocal?.trialVoiceState?.();if(trial&&trial.state!=='completed'){setVoiceStatus(trialVoiceMessage(trial),'error');return false}
  const turns=(activeConversation?.turns||[]).filter(turn=>!turn.superseded),latest=turns.at(-1);
  if(activeConversation?.new_text_trial?.turn_id===turns.filter(turn=>turn.role==='elder').at(-1)?.turn_id)return false;
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
  const conversation=activeConversation,turn=turnById(turnId),text=String(value||'').trim();if(!turn||!conversation)return false;
  if(latestEditableOwnTurn(conversation)?.turn_id!==turnId){turn.editStatus='这已不是最新一条原话；没有保存。可以引用或补充一条新消息。';renderVoiceConversation();setVoiceStatus(turn.editStatus,'error');return false}
  if(!text){turn.editStatus='修改后的文字不能为空。';renderVoiceConversation();return false}
  if(text===turn.text){cancelVoiceTurnEdit();return true}
  setVoiceStatus('正在保存修改并更新报告…');setVoiceComposerEnabled(false);
  const x=await api(`/api/conversations/${encodeURIComponent(conversation.conversation_id)}/turns/${encodeURIComponent(turnId)}`,{method:'POST',body:JSON.stringify({text,expected_version:turn.version,expected_conversation_version:conversation.version})});
  if(activeConversation?.conversation_id!==conversation.conversation_id)return false;
  if(!x.r.ok||!x.j.conversation){turn.editText=text;turn.editStatus=x.j?.error==='turn_not_latest'?'较早原话不能修改；可以引用或补充一条新消息。':x.r.status===409?'这句话已经有新版本，请重新打开后再改。':'修改没有保存，文字仍在这里，可以重试。';setVoiceComposerEnabled(true);renderVoiceConversation();setVoiceStatus(turn.editStatus,'error');return false}
  syncConversation(x.j.conversation);const status=x.j.quote_context_invalidated?'原话和报告已更新；原引用已失效，旧引用没有继续发送。':x.j.text_trial?.state==='saved_only'?'原话和报告已更新并保存在本机；可以点击“把这段话发给小零”尝试回复。':x.j.ai_failed?'原话和本机报告已更新；联网回复暂未完成，可稍后重试。':'原话和报告都已更新。';setVoiceStatus(status,x.j.ai_failed?'error':'ok');await loadEvents();return true;
}
function showVoiceMediaSaved(media){
  if(pendingConversationTurn?.audio_processing){
    pendingConversationTurn={...pendingConversationTurn,media_id:media?.media_id||null,pending_audio_stage:'transcribing',text:'正在转成文字…'};
    renderVoiceConversation();
  }
  setVoiceStatus('录音原件已保存，正在尝试转成文字…','ok');
}
function audioReviewAlreadyInConversation(conversation,media,event){
  return (conversation?.turns||[]).some(turn=>turn.role==='elder'&&!turn.superseded&&turn.source_kind==='audio_transcript'
    &&turn.media_id===media.media_id&&turn.record_id===event.record_id&&turn.text===event.raw_text
    &&(turn.audio_source_reviewed===true||['machine_transcribed','user_edited'].includes(turn.audio_source_status))&&Number(turn.audio_source_version)===Number(event.version)
    &&Number(turn.audio_source_media_version)===Number(media.version));
}
function audioRecoveryScopeCurrent(scope,conversationId){
  return scope.requestId===pendingAudioRecoveryRequestId&&scope.epoch===healthSubjectUiEpoch
    &&scope.subjectId===activeHealthSubjectId&&scope.subjectVersion===healthSubjectsVersion
    &&!healthSubjectSwitchBusy&&!healthSubjectChanged&&activeConversation?.conversation_id===conversationId
    &&activeConversation?.version===scope.conversationVersion&&document.querySelector?.('.view.active')?.id==='voiceView';
}
async function findPendingAudioReviewCandidates(conversation){
  const conversationId=conversation?.conversation_id;
  if(!conversationId||activeConversation?.conversation_id!==conversationId||healthSubjectSwitchBusy||healthSubjectChanged)return {ok:false,stale:true,candidates:[]};
  const scope={requestId:++pendingAudioRecoveryRequestId,epoch:healthSubjectUiEpoch,subjectId:activeHealthSubjectId,subjectVersion:healthSubjectsVersion,conversationVersion:activeConversation.version};
  const subjectId=conversation.subject_id||activeHealthSubjectId;
  if(subjectId!==activeHealthSubjectId)return {ok:false,stale:true,candidates:[]};
  try{
    const trial=await globalThis.HealthLocal?.trialVoiceState?.();
    if(!audioRecoveryScopeCurrent(scope,conversationId))return {ok:false,stale:true,candidates:[]};
    if(conversation.trial_control&&conversation.trial_control.state!=='completed'||trial&&trial.state!=='completed')return {ok:true,trialControlled:true,candidates:[]};
    const [mediaResult,eventsResult]=await Promise.all([api('/api/media'),api('/api/events')]);
    if(!audioRecoveryScopeCurrent(scope,conversationId))return {ok:false,stale:true,candidates:[]};
    if(!mediaResult.r.ok||!eventsResult.r.ok)return {ok:false,unavailable:true,candidates:[]};
    const events=eventsResult.j?.events||[],candidates=[];
    for(const media of mediaResult.j?.media||[]){
      if(media.kind!=='audio'||media.temporary!==true||media.conversation_id!==conversationId||media.save_status!=='saved'
        ||media.recognition_status!=='succeeded'||media.trial_control||isMockContent(media))continue;
      if(media.subject_id&&media.subject_id!==subjectId)continue;
      const event=globalThis.HealthSafety?.currentAudioSource(media,events);
      if(!event||event.state==='superseded'||event.source_kind!=='audio_transcript'||isMockContent(event)||!String(event.raw_text||'').trim())continue;
      if(audioReviewAlreadyInConversation(conversation,media,event))continue;
      const needsReview=globalThis.HealthSafety?.audioNeedsReview(event);
      if(typeof needsReview!=='boolean')continue;
      candidates.push({...media,recovery_record_id:event.record_id,recovery_source_version:event.version,recovery_source_reviewed:!needsReview,recovery_text:event.raw_text});
    }
    candidates.sort((a,b)=>(Date.parse(a.created_at||'')||0)-(Date.parse(b.created_at||'')||0)||String(a.media_id).localeCompare(String(b.media_id)));
    return {ok:true,candidates};
  }catch{return {ok:false,unavailable:true,candidates:[]}}
}
async function presentAudioReview(media,{restore=false,requestId=null}={}){
  if(!media.conversation_id||activeConversation?.conversation_id!==media.conversation_id){
    setVoiceStatus('识别文字和录音已保留，但还没有进入对话。请返回对应对话后核对；核对前不会作为患者原话或进入报告。','error');return false;
  }
  const scope={requestId:restore?(requestId??++pendingAudioRecoveryRequestId):null,epoch:healthSubjectUiEpoch,subjectId:activeHealthSubjectId,subjectVersion:healthSubjectsVersion,conversationId:media.conversation_id,conversationVersion:activeConversation.version};
  try{
    const requests=[api('/api/media/'+encodeURIComponent(media.media_id)),api('/api/events')];
    if(restore)requests.push(api('/api/conversations/'+encodeURIComponent(media.conversation_id)));
    const [mediaResult,eventsResult,conversationResult]=await Promise.all(requests);
    const scopeCurrent=restore?audioRecoveryScopeCurrent(scope,scope.conversationId):scope.epoch===healthSubjectUiEpoch&&scope.subjectId===activeHealthSubjectId
      &&scope.subjectVersion===healthSubjectsVersion&&!healthSubjectSwitchBusy&&!healthSubjectChanged
      &&activeConversation?.conversation_id===scope.conversationId;
    if(!scopeCurrent)return false;
    const latest=mediaResult.j?.media,events=eventsResult.j?.events||[],event=latest&&globalThis.HealthSafety?.currentAudioSource(latest,events);
    if(!mediaResult.r.ok||!eventsResult.r.ok||!latest||latest.media_id!==media.media_id||latest.kind!=='audio'||latest.recognition_status!=='succeeded'
      ||restore&&(latest.conversation_id!==scope.conversationId||latest.temporary!==true)||isMockContent(latest)||!event||isMockContent(event)||!String(event.raw_text||'').trim()){
      throw new Error('识别文字或录音来源已变化；原件仍保留，请重新读取。');
    }
    let currentConversation=activeConversation;
    if(restore){
      const trial=await globalThis.HealthLocal?.trialVoiceState?.();
      if(!audioRecoveryScopeCurrent(scope,scope.conversationId))return false;
      if(!mediaResult.r.ok||!eventsResult.r.ok||!conversationResult?.r.ok||!conversationResult.j?.conversation)throw new Error('录音或当前对话状态暂时无法读取；原件仍保留。');
      currentConversation=conversationResult.j.conversation;
      if(currentConversation.conversation_id!==scope.conversationId||currentConversation.subject_id&&currentConversation.subject_id!==scope.subjectId
        ||currentConversation.trial_control&&currentConversation.trial_control.state!=='completed'||trial&&trial.state!=='completed'||latest?.trial_control){
        setVoiceStatus('这段录音属于受控试验停点；请按原有核对流程处理，未自动恢复或发送。','error');return false;
      }
      if(currentConversation.version!==scope.conversationVersion){setVoiceStatus('对话已有新变化，待核对状态已过期；请重新打开对话后再选择录音。','error');return false}
      if(audioReviewAlreadyInConversation(currentConversation,latest,event)){
        pendingAudioReviewCandidates=pendingAudioReviewCandidates.filter(item=>item.media_id!==latest.media_id);renderVoiceConversation();
        setVoiceStatus('这段录音已经在当前对话中；已重新读取，没有重复加入。','ok');return false;
      }
    }
    if(!mediaResult.r.ok||!eventsResult.r.ok||!latest||latest.media_id!==media.media_id||latest.kind!=='audio'||latest.recognition_status!=='succeeded'
      ||latest.conversation_id!==scope.conversationId||latest.temporary!==true||isMockContent(latest)||!event||isMockContent(event)||!String(event.raw_text||'').trim()){
      throw new Error('识别文字或录音来源已变化；原件仍保留，请重新读取。');
    }
    const sourceAlreadyReviewed=globalThis.HealthSafety?.audioNeedsReview(event)===false;
    if(restore&&typeof globalThis.HealthSafety?.audioNeedsReview(event)!=='boolean')throw new Error('录音核对状态暂时无法确认；原件仍保留。');
    pendingAudioReview={conversation_id:media.conversation_id,media_id:latest.media_id,record_id:event.record_id,sourceVersion:event.version,mediaVersion:latest.version,text:event.raw_text||latest.recognition?.text||'',draftText:event.raw_text||latest.recognition?.text||'',played:false,confirmed:false,reviewed:restore&&sourceAlreadyReviewed,reviewedText:restore&&sourceAlreadyReviewed?event.raw_text:null,busy:false,idempotencyKey:null,trialControlled:Boolean(latest.trial_control||currentConversation?.trial_control&&currentConversation.trial_control.state!=='completed')};
    renderVoiceConversation();setVoiceComposerEnabled(false);
    setVoiceStatus(restore&&sourceAlreadyReviewed?'这段文字已在记录中对照原音核对，但还没有进入本次对话；请明确选择接回。':'语音已转成草稿。请在下方播放原录音、核对文字，再确认是否作为本次对话原话。','ok');return true;
  }catch(error){setVoiceStatus(error.message||'识别文字暂时无法核对；原录音仍保留。','error');return false}
}
async function restoreAudioReviewCandidate(mediaId){
  const candidate=pendingAudioReviewCandidates.find(item=>item.media_id===mediaId&&item.conversation_id===activeConversation?.conversation_id);
  if(!candidate)return false;
  const requestId=++pendingAudioRecoveryRequestId,restored=await presentAudioReview(candidate,{restore:true,requestId});
  if(!restored&&requestId===pendingAudioRecoveryRequestId){const recovery=await findPendingAudioReviewCandidates(activeConversation);if(recovery.ok){pendingAudioReviewCandidates=recovery.candidates;renderVoiceConversation();if(recovery.candidates.some(item=>item.media_id===mediaId))setVoiceStatus('录音或对话状态已有变化，待核对列表已重新读取。','error')}}
  return restored;
}
async function continueRecoveredAudioCandidate(mediaId,button=null){
  const candidate=pendingAudioReviewCandidates.find(item=>item.media_id===mediaId&&item.conversation_id===activeConversation?.conversation_id);
  if(!candidate||saveBusy||pendingAudioReview||activeConversation?.trial_control||activeConversation?.saved_audio_trial)return false;
  const conversation=activeConversation,epoch=healthSubjectUiEpoch,subjectId=activeHealthSubjectId,subjectVersion=healthSubjectsVersion;
  if(button)button.disabled=true;
  try{
    const [mediaResult,eventsResult,conversationResult,trial]=await Promise.all([
      api('/api/media/'+encodeURIComponent(mediaId)),api('/api/events'),
      api('/api/conversations/'+encodeURIComponent(conversation.conversation_id)),
      globalThis.HealthLocal?.trialVoiceState?.(),
    ]);
    const stillCurrent=()=>activeConversation?.conversation_id===conversation.conversation_id&&activeConversation?.version===conversation.version
      &&healthSubjectUiEpoch===epoch&&activeHealthSubjectId===subjectId&&healthSubjectsVersion===subjectVersion
      &&!healthSubjectSwitchBusy&&!healthSubjectChanged;
    if(!stillCurrent())return false;
    const media=mediaResult.j?.media,events=eventsResult.j?.events||[],event=media&&globalThis.HealthSafety?.currentAudioSource(media,events);
    const latestConversation=conversationResult.j?.conversation;
    if(!mediaResult.r.ok||!eventsResult.r.ok||!conversationResult.r.ok||!latestConversation||latestConversation.version!==conversation.version
      ||trial&&trial.state!=='completed'||media?.trial_control||media?.kind!=='audio'||media.recognition_status!=='succeeded'
      ||media.save_status!=='saved'||media.temporary!==true||media.conversation_id!==conversation.conversation_id
      ||(media.subject_id||'subject_self')!==(conversation.subject_id||subjectId)||isMockContent(media)||!event||isMockContent(event)
      ||event.state==='superseded'||event.source_kind!=='audio_transcript'||!String(event.raw_text||'').trim()
      ||event.record_id!==candidate.recovery_record_id||event.version!==candidate.recovery_source_version
      ||media.version!==candidate.version||event.raw_text!==candidate.recovery_text){
      setVoiceStatus('这段录音或对话已有变化；没有发送，请重新打开后核对当前内容。','error');return false;
    }
    if(!stillCurrent())return false;
    const reviewed=globalThis.HealthSafety?.audioNeedsReview(event)===false;
    const added=await submitConversationText(event.raw_text,{
      source_kind:'audio_transcript',record_id:event.record_id,media_id:media.media_id,
      source_version:event.version,media_version:media.version,
      ...(!reviewed?{audio_source_status:'machine_transcribed'}:{}),
      ...(Number.isSafeInteger(media.duration_seconds)&&media.duration_seconds>0?{audio_duration_seconds:media.duration_seconds}:{}),
      keep_media_until_pause:true,
      explicit_recovered_audio_continue:true,
      idempotencyKey:`recovered-audio:${media.media_id}:${event.version}:${media.version}:${conversation.conversation_id}`,
    });
    if(added&&activeConversation?.conversation_id===conversation.conversation_id&&healthSubjectUiEpoch===epoch
      &&activeHealthSubjectId===subjectId&&healthSubjectsVersion===subjectVersion&&!healthSubjectSwitchBusy&&!healthSubjectChanged){
      pendingAudioReviewCandidates=pendingAudioReviewCandidates.filter(item=>item.media_id!==mediaId||item.conversation_id!==conversation.conversation_id);
      renderVoiceConversation();
    }
    return added;
  }catch{setVoiceStatus('这段录音暂时无法接入对话；原件仍保留。您可以稍后重试，也可以直接打字。','error');return false}
  finally{if(button?.isConnected)button.disabled=false}
}
function continueWithTextInsteadOfAudio(){
  const review=pendingAudioReview;if(!review||review.trialControlled)return false;
  pendingAudioRecoveryRequestId++;pendingAudioReview=null;renderVoiceConversation();setVoiceComposerEnabled(true);
  setVoiceStatus('这段录音仍保留在本机且尚未加入对话；不会用于回复或报告。您可以直接打字继续。','ok');return true;
}
function voiceRecordingIntentIsCurrent(intent,media=null){
  const currentQuote=pendingFollowupTarget,quote=intent?.quoteSnapshot;
  const quoteStillCurrent=quote
    ?Boolean(currentQuote&&!currentQuote.invalid&&currentQuote.conversation_id===quote.conversation_id&&currentQuote.subject_id===quote.subject_id
      &&currentQuote.turn_id===quote.turn_id&&currentQuote.version===quote.version&&currentQuote.role===quote.role&&currentQuote.text===quote.text
      &&followupTargetTurn(activeConversation,currentQuote))
    :!currentQuote;
  return Boolean(intent&&!intent.invalidated&&voiceCaptureIntent===intent&&activeConversation
    &&activeConversation.conversation_id===intent.conversationId&&activeConversation.version===intent.conversationVersion
    &&activeConversation.status===intent.conversationStatus&&['active','paused'].includes(intent.conversationStatus)
    &&activeHealthSubjectId===intent.subjectId&&healthSubjectsVersion===intent.subjectVersion&&healthSubjectUiEpoch===intent.epoch
    &&!healthSubjectSwitchBusy&&!healthSubjectChanged&&quoteStillCurrent
    &&(!media||media.conversation_id===intent.conversationId&&(!media.subject_id||media.subject_id===intent.subjectId)));
}
async function showVoiceMediaResult(media,{newRecording=false,durationSeconds=0,captureIntent=null}={}){
  if(!media)return;
  if(media.trial_control){
    if(media.kind==='audio'&&media.recognition_status==='succeeded'&&media.recognition?.text?.trim()&&!isMockContent(media)){
      await presentAudioReview(media);return;
    }
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
  if(media.kind==='audio'&&recognitionError==='invalid_media'){
    setVoiceStatus(unusableAudioMessage(media),'error');return;
  }
  if(media.kind==='audio'&&recognitionError==='no_text_detected'){
    setVoiceStatus('这次没有录到可用声音，请重新录音；已保存的录音原件仍可查看。','error');return;
  }
  if(isMockContent(media)){setVoiceStatus(mockWarning,'error');return}
  const currentRecordingIntent=newRecording&&voiceRecordingIntentIsCurrent(captureIntent,media);
  if(media.kind==='audio'&&media.recognition_status==='succeeded'&&media.recognition?.text?.trim()&&!mockText(media.recognition.text)
    &&!(currentRecordingIntent&&media.temporary===true)){
    if(media.temporary===true&&media.conversation_id===activeConversation?.conversation_id){
      const recovery=await findPendingAudioReviewCandidates(activeConversation);
      if(recovery.ok){pendingAudioReviewCandidates=recovery.candidates;renderVoiceConversation();setVoiceStatus('这段已保存录音没有自动加入对话。您可以点“继续聊这段”，也可以直接打字。','ok')}
      else setVoiceStatus('录音和识别文字已保留；当前待处理状态暂时无法读取。您可以直接打字或稍后重试。','error');
      return;
    }
    setVoiceStatus('这段录音尚未关联到当前对话；原件与识别文字仍保留。请回到所属对话后再决定是否继续。','error');return;
  }
  const rid=media.event_link?.record_id||media.record_id;
  const text=media.recognition?.text?.trim();
  if(currentRecordingIntent&&media.kind==='audio'&&media.temporary===true&&media.conversation_id&&media.recognition_status==='succeeded'&&text&&!mockText(text)){
    if(media.conversation_turn_id){
      const saved=await api('/api/conversations/'+encodeURIComponent(media.conversation_id));
      if(saved.r.ok&&saved.j.conversation&&activeConversation?.conversation_id===media.conversation_id){
        const voiceVisible=document.querySelector?.('.view.active')?.id==='voiceView';
        syncConversation(saved.j.conversation,{speak:voiceVisible});
        setVoiceStatus('这段录音和文字已在当前对话中；没有重复发送。您可以继续说。','ok');
      }else{
        setVoiceStatus('识别文字已保存在本机；没有重复发送。当前对话暂时无法读取，请重新打开后查看。','error');
      }
      return;
    }
    if(activeConversation?.conversation_id!==media.conversation_id){setVoiceStatus('语音文字已保存，但这段录音还没有接入原来的对话。请回到原对话核对；录音原件仍保留。','error');return}
    if(media.conversation_link_error||media.conversation_link_interrupted){prepareMediaRetry(media,text);setVoiceStatus('识别文字和录音原件已保留；加入对话没有完成。请核对下方文字后点发送重试。','error');return}
    pendingConversationTurn={turn_id:'pending-audio',role:'elder',source_kind:'audio_transcript',media_id:media.media_id,record_id:rid,text,
      audio_duration_seconds:durationSeconds,pending:true,audio_processing:true,pending_audio_stage:'sending',followOnRender:false};
    renderVoiceConversation();
    const added=await submitConversationText(text,{source_kind:'audio_transcript',audio_source_status:'machine_transcribed',record_id:rid,media_id:media.media_id,audio_duration_seconds:durationSeconds,idempotencyKey:`media-conversation:${media.media_id}`,keep_media_until_pause:true,
      ...(captureIntent.conversationStatus==='paused'?{explicit_paused_audio_capture:true}:{}),voice_capture_intent:captureIntent});
    if(!added){if(pendingConversationTurn?.audio_processing){pendingConversationTurn=null;renderVoiceConversation()}prepareMediaRetry(media,text);setVoiceStatus('识别文字和录音原件已保留；加入对话没有完成。请核对下方文字后点发送重试。','error')}
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
  pendingAudioRecoveryRequestId++;
  const x=await api('/api/conversations/start',{method:'POST',body:JSON.stringify({mode,local_date:localDateValue()})});
  if(!x.r.ok||!x.j.conversation){setVoiceStatus('会话暂时无法建立，请稍后重试。','error');return false}
  $('conversationResumeChoice')?.classList.add('hidden');
  if(mode==='new'||pendingAudioReview?.conversation_id!==x.j.conversation.conversation_id){pendingAudioReview=null;pendingAudioReviewCandidates=[]}
  syncConversation(x.j.conversation);
  if(mode==='continue'){
    const recovery=await findPendingAudioReviewCandidates(x.j.conversation);
    if(!recovery.ok){setVoiceStatus('录音待核对状态暂时无法读取；没有自动识别或发送。您可以重试，或直接输入文字继续。','error');return true}
    pendingAudioReviewCandidates=recovery.candidates;renderVoiceConversation();
    if(recovery.candidates.length){setVoiceStatus(`找到 ${recovery.candidates.length} 段已保存录音尚未进入本次对话；请逐段核对，或直接打字继续。`,'ok');return true}
  }
  if(x.j.conversation.manual_correction_analysis_pending===true){
    const pendingAudio=(x.j.conversation.turns||[]).some(turn=>!turn.superseded&&legacyAudioNeedsExplicitRecovery(turn));
    setVoiceStatus(pendingAudio?'更正后的录音文字待核对；打开这段原话的记录详情并对照原录音。核对前不会整理或生成回复。':x.j.conversation.manual_correction_reorganization?.state==='sending'?'原话已更正；上次整理状态待核实，不会自动重发。':'原话已更正；报告待重新整理。重新打开不会自动发送，可在本对话中明确重新整理。','error');return true
  }
  if(x.j.conversation.saved_audio_trial){const trial=x.j.conversation.saved_audio_trial;setVoiceStatus(savedAudioTrialMessage(trial),trial.state==='stopped'?'error':'ok');return true}
  if(x.j.conversation.new_text_trial?.state==='saved_only'){
    const status=x.j.conversation.new_text_trial.first_send_available
      ?'原话已加密保存在本机；联网回复暂不可用，稍后可以点击“把这段话发给小零”，也可以继续记录。'
      :'原话已加密保存在本机；这次没有发送，请先处理对话中的提示。';
    setVoiceStatus(status,'error');return true
  }
  setVoiceStatus('您慢慢说，我会帮您记着。','ok');return true;
}
async function startSeparateConversation(){
  if(saveBusy||conversationLoading||mediaRecorder?.state==='recording'||voicePermissionPending||voiceUploadPending){toast('请等这一段保存完成。');return false}
  if($('voiceTextInput')?.value.trim()||conversationEditingTurnId){toast('请先保存或清空正在编辑的话，再另记一件事。');return false}
  pendingAudioRecoveryRequestId++;
  conversationLoading=true;const button=$('startSeparateConversationBtn');if(button)button.disabled=true;
  try{await pauseConversation();return await startConversation('new')}
  finally{conversationLoading=false;if(button)button.disabled=false}
}
async function reorganizeCorrectedConversation(button){
  const conversation=activeConversation;
  if(saveBusy||!conversation?.conversation_id||conversation.manual_correction_analysis_pending!==true)return false;
  if((conversation.turns||[]).some(turn=>!turn.superseded&&legacyAudioNeedsExplicitRecovery(turn))){
    setVoiceStatus('更正后的录音文字还没有核对；请打开记录详情并对照原录音。核对前不会整理或发送。','error');return false;
  }
  const scope={id:conversation.conversation_id,version:conversation.version,subject:activeHealthSubjectId,subjectVersion:healthSubjectsVersion,epoch:healthSubjectUiEpoch};
  const sameOwner=()=>activeHealthSubjectId===scope.subject&&healthSubjectsVersion===scope.subjectVersion&&healthSubjectUiEpoch===scope.epoch
    &&!healthSubjectSwitchBusy&&!healthSubjectChanged;
  const stillCurrent=()=>activeConversation?.conversation_id===scope.id&&activeConversation?.version===scope.version&&sameOwner();
  saveBusy=true;if(button)button.disabled=true;setVoiceComposerEnabled(false);setVoiceStatus('正在核对更正原话、所属人和当前背景…');
  try{
    const [context,registry]=await Promise.all([api('/api/health-context'),api('/api/health-subjects')]);
    if(!stillCurrent()||!context.r.ok||!registry.r.ok||registry.j.active_subject_id!==scope.subject||registry.j.version!==scope.subjectVersion){
      setVoiceStatus('当前对话或所属人已变化；没有发送，请重新打开后核对。','error');return false;
    }
    const result=await api(`/api/conversations/${encodeURIComponent(scope.id)}/reorganize-corrected`,{method:'POST',body:JSON.stringify({
      expected_conversation_version:scope.version,expected_subject_id:scope.subject,expected_subject_version:scope.subjectVersion,
      expected_context_version:context.j.health_context?.version,
    })});
    if(!stillCurrent()){return false}
    if(result.j?.conversation)syncConversation(result.j.conversation,{speak:false});
    if(!result.r.ok){setVoiceStatus(correctedReorganizationFailureCopy(activeConversation?.manual_correction_reorganization),'error');return false}
    if(!result.j.dispatched){const message=result.j.reason==='already_sending'?'上次整理状态仍待核实；为避免重复发送，本次没有重试。':'当前暂不能联网整理；原话仍保存在本机，本次未发送。';setVoiceStatus(message,'error');return false}
    const completed=result.j.reason==='completed'&&result.j.conversation?.manual_correction_analysis_pending!==true;
    if(completed){
      const refreshed=await loadEvents();
      if(!sameOwner())return false;
      setVoiceStatus(refreshed?'已按当前更正原话重新整理；原话与旧版记录仍保留。':'整理已完成；最近记录暂未更新，请重新读取。',refreshed?'ok':'error');
      return true;
    }
    setVoiceStatus(activeConversation?.manual_correction_reorganization?.state==='failed'?correctedReorganizationFailureCopy(activeConversation.manual_correction_reorganization):'整理未能安全完成；原话和报告仍保留，且不会自动重试。','error');
    return false;
  }catch{setVoiceStatus('整理没有完成；原话、旧报告和版本记录仍保留，未自动重试。','error');return false}
  finally{saveBusy=false;setVoiceComposerEnabled(true);renderVoiceConversation()}
}
async function loadConversation(conversationId=null){
  const requestId=++conversationLoadSequence;
  if(localMode&&!await ensureHealthSubjectReady())return false;
  if(requestId!==conversationLoadSequence)return false;
  if(typeof healthSubjectSwitchBusy!=='undefined'&&healthSubjectSwitchBusy)return;
  if(conversationLoading&&!conversationId)return false;conversationLoading=true;setVoiceComposerEnabled(false);
  const subjectSnapshot={id:activeHealthSubjectId,version:healthSubjectsVersion,epoch:healthSubjectUiEpoch};
  const loadIsCurrent=()=>requestId===conversationLoadSequence
    &&(!document.querySelector?.('.view.active')?.id||document.querySelector('.view.active').id==='voiceView')
    &&activeHealthSubjectId===subjectSnapshot.id&&healthSubjectsVersion===subjectSnapshot.version
    &&healthSubjectUiEpoch===subjectSnapshot.epoch&&!healthSubjectSwitchBusy&&!healthSubjectChanged;
  try{
    if(conversationId){
      let result;try{result=await api(`/api/conversations/${encodeURIComponent(conversationId)}`)}catch{}
      if(!loadIsCurrent())return false;
      const conversation=result?.j?.conversation;
      if(!result?.r?.ok||!conversation||conversation.conversation_id!==conversationId){
        activeConversation=null;renderVoiceConversation();renderConversationReport();setVoiceStatus(result?.r?.status===404?'这条历史对话不存在或已删除；没有新建其他对话。':'这条历史对话读取失败；没有切换到其他记录。请重试。','error');
        return false;
      }
      if(localMode&&(conversation.subject_id||'subject_self')!==activeHealthSubjectId){
        activeConversation=null;renderVoiceConversation();renderConversationReport();setVoiceStatus('这条历史对话属于另一位使用者；没有打开或发送内容。','error');return false;
      }
      pendingAudioReview=null;pendingAudioReviewCandidates=[];pendingAudioRecoveryRequestId++;
      syncConversation(conversation,{speak:false});
      if(conversation.manual_correction_analysis_pending===true){setVoiceStatus('这条对话的更正仍待核对；打开记录不会自动整理或发送。','error');return true}
      if(conversation.saved_audio_trial){setVoiceStatus(savedAudioTrialMessage(conversation.saved_audio_trial),'error');return true}
      if(conversation.trial_control){setVoiceStatus(trialVoiceMessage(conversation.trial_control),'error');return true}
      setVoiceStatus(conversation.status==='paused'?'已打开这条历史对话。您可以继续补充；打开时没有自动发送。':'已打开这条对话。您可以继续补充。','ok');
      return true;
    }
    const x=await api(`/api/conversations/current?local_date=${encodeURIComponent(localDateValue())}`);
    if(!loadIsCurrent())return false;
    if(!x.r.ok){setVoiceStatus('已保存资料暂时无法读取，请稍后重试。','error');return}
    if(x.j.resume_choice_required){activeConversation=null;pendingAudioReview=null;pendingAudioReviewCandidates=[];pendingAudioRecoveryRequestId++;renderVoiceConversation();renderConversationReport();document.querySelector?.('.conversation-shell')?.classList.add('awaiting-choice');$('conversationResumeChoice')?.classList.remove('hidden');setVoiceStatus('请选择接着上次说，还是记录新的情况。');return}
    if(x.j.conversation){
      syncConversation(x.j.conversation,{speak:false});
      if(x.j.conversation.manual_correction_analysis_pending===true){
        const pendingAudio=(x.j.conversation.turns||[]).some(turn=>!turn.superseded&&legacyAudioNeedsExplicitRecovery(turn));
        const operation=x.j.conversation.manual_correction_reorganization;
        setVoiceStatus(pendingAudio?'更正后的录音文字待核对；打开这段原话的记录详情并对照原录音。核对前不会整理或生成回复。':operation?.state==='sending'?'原话已更正；上次整理状态待核实，不会自动重发。':operation?.state==='failed'?correctedReorganizationFailureCopy(operation):'原话已更正；报告待重新整理。重新打开不会自动发送，可在本对话中明确重新整理。','error');return
      }
      if(x.j.conversation.saved_audio_trial){const trial=x.j.conversation.saved_audio_trial;setVoiceStatus(savedAudioTrialMessage(trial),trial.state==='stopped'?'error':'ok');return}
      if(x.j.conversation.trial_control){const control=x.j.conversation.trial_control;setVoiceStatus(trialVoiceMessage(control),control.state==='stopped'?'error':'ok');return}
      if(x.j.conversation.new_text_trial?.state==='saved_only'){
        const status=x.j.conversation.new_text_trial.first_send_available?'原话已加密保存在本机；联网回复暂不可用，稍后可以点击“把这段话发给小零”，也可以继续记录。':'原话已加密保存在本机；这次没有发送，请先处理对话中的提示。';
        setVoiceStatus(status,'error');return
      }
      const newTextTrial=x.j.conversation.new_text_trial;
      const textTrialStatus={
        sending:'这段文字已保存在本机；上次回复的状态暂时无法确认，不会自动重发。',
        completed:'这段文字和回复已保存在本机；重新打开不会重复发送，您可以继续记录。',
        failed:'这段文字已保存在本机；本次文字回复未完成，不会自动重发，您可以继续记录新的内容。',
        discarded:'这段文字已保存在本机；资料或对话状态变化后，旧回复未写入，不会自动重发，您可以继续记录新的内容。',
      }[newTextTrial?.state];
      if(textTrialStatus){setVoiceStatus(textTrialStatus,newTextTrial.state==='completed'?'':'error');return}
      const globalTrial=await globalThis.HealthLocal?.trialVoiceState?.();
      const globalBelongsToConversation=Boolean(activeConversation?.conversation_id&&globalTrial?.conversation_id===activeConversation.conversation_id);
      if(globalTrial&&globalTrial.state!=='completed'&&globalBelongsToConversation){setVoiceStatus(trialVoiceMessage(globalTrial),globalTrial.state==='stopped'?'error':'ok');return}
      if(['processing','continuing'].includes(globalTrial?.state)){setVoiceStatus('另一段处理还未结束；本次内容已保存在本机，请稍后再继续。','error');return}
      const recovery=await findPendingAudioReviewCandidates(activeConversation);
      if(!loadIsCurrent())return false;
      if(!recovery.ok){pendingAudioReviewCandidates=[];renderVoiceConversation();setVoiceStatus('录音待核对状态暂时无法读取；本次不会自动接上联网回复。您可以重试打开对话，或直接输入文字继续。','error');return}
      pendingAudioReviewCandidates=recovery.candidates;renderVoiceConversation();
      if(recovery.candidates.length){setVoiceStatus(`找到 ${recovery.candidates.length} 段已保存录音尚未进入本次对话；请逐段核对，或直接打字继续。`,'ok');return}
      const pending=conversationHasPendingReply(activeConversation);
      if(!pending){setVoiceStatus('上次说到这里，您可以接着说。','ok');return}
      setVoiceStatus('刚才的话已保存在本机，正在尝试接上回复…','ok');
      const resumed=await api(`/api/conversations/${encodeURIComponent(x.j.conversation.conversation_id)}/resume-assistant`,{method:'POST',body:'{}'});
      if(!loadIsCurrent())return false;
      if(!resumed.r.ok||!resumed.j.conversation){setVoiceStatus('刚才的话已保存，暂时没收到回复；重新进入时会继续。','error');return}
      syncConversation(resumed.j.conversation);
      const savedTextState=resumed.j.conversation.new_text_trial?.state;
      const status=savedTextState==='saved_only'?(resumed.j.conversation.new_text_trial.first_send_available?'原话已保存在本机；还没有收到回复，可以点击“把这段话发给小零”，也可以继续打字。':'原话已保存在本机；当前还不能发送这段话，请先处理对话中的提示。'):resumed.j.ai_failed?'原话和报告已保存在本机；联网回复没完成，可点对话中的“重试小零回复”，也可以继续打字。':'已经接上刚才的话，您可以继续说。';
      setVoiceStatus(status,resumed.j.ai_failed||savedTextState==='saved_only'?'error':'ok');
      await loadEvents();return
    }
    await startConversation('new');
  }finally{if(requestId===conversationLoadSequence){conversationLoading=false;if(activeConversation)setVoiceComposerEnabled(true)}}
}
function showHistoricalConversation(id){
  if(typeof id!=='string'||!id)return false;
  return showView('voiceView',{conversationId:id,readOnlyHistoryOpen:true});
}
async function sendSavedTextFirst(button){
  const conversation=activeConversation,turn=turnById(button?.closest('[data-voice-turn]')?.dataset.voiceTurn);
  if(saveBusy||!conversation?.conversation_id||!canShowSavedTextFirstSend(conversation,turn))return false;
  const scope={conversationId:conversation.conversation_id,conversationVersion:conversation.version,turnId:turn.turn_id,
    turnVersion:turn.version,subjectId:activeHealthSubjectId,subjectVersion:healthSubjectsVersion,epoch:healthSubjectUiEpoch};
  const stillCurrent=()=>activeConversation?.conversation_id===scope.conversationId&&activeConversation?.version===scope.conversationVersion
    &&activeHealthSubjectId===scope.subjectId&&healthSubjectsVersion===scope.subjectVersion&&healthSubjectUiEpoch===scope.epoch
    &&!healthSubjectSwitchBusy&&!healthSubjectChanged&&turnById(scope.turnId)?.version===scope.turnVersion
    &&document.querySelector?.('.view.active')?.id==='voiceView';
  saveBusy=true;button.disabled=true;button.textContent='正在核对…';setVoiceComposerEnabled(false);
  setVoiceStatus('正在核对这段话和当前资料…');
  try{
    const [eventResult,contextResult,registryResult]=await Promise.all([
      api(`/api/events/${encodeURIComponent(turn.record_id)}`),api('/api/health-context'),api('/api/health-subjects'),
    ]);
    if(!stillCurrent()){setVoiceStatus('页面或所属人刚有变化；原话仍保存在本机，没有发送。请重新打开对话后再试。','error');return false}
    const event=eventResult.j?.event,context=contextResult.j?.health_context,registry=registryResult.j;
    if(!eventResult.r.ok||!contextResult.r.ok||!registryResult.r.ok||!event||event.raw_text!==turn.text||event.source_kind!=='elder'
      ||registry.active_subject_id!==scope.subjectId||registry.version!==scope.subjectVersion||contextResult.j.subject_id!==scope.subjectId){
      setVoiceStatus('原话仍保存在本机；当前所属人、资料或这段话刚有变化，没有发送。请重新查看后再试。','error');return false;
    }
    const result=await api(`/api/conversations/${encodeURIComponent(scope.conversationId)}/turns/${encodeURIComponent(scope.turnId)}/first-send`,{
      method:'POST',body:JSON.stringify({expected_conversation_version:scope.conversationVersion,expected_turn_version:scope.turnVersion,
        expected_event_version:event.version,expected_context_version:context.version,expected_subject_id:scope.subjectId,
        expected_subject_version:scope.subjectVersion}),
    });
    if(!stillCurrent()){setVoiceStatus('页面或所属人刚有变化；原话仍保存在本机。请重新打开对话查看结果。','error');return false}
    if(result.j?.conversation)syncConversation(result.j.conversation,{speak:false});
    if(!result.r.ok||!result.j?.conversation){
      setVoiceStatus('原话仍保存在本机；刚才没有发送。请重新查看这段话后再继续。','error');return false;
    }
    const state=result.j.text_trial?.state;
    const reason=result.j.text_trial?.reason;
    const message=state==='saved_only'&&reason==='grant_unavailable'?'原话已保存；联网回复暂不可用，稍后可以点击“把这段话发给小零”。'
      :state==='saved_only'?'原话仍保存在本机；这次没有发送，可能是这段话或相关资料刚有变化。请重新打开对话查看后再试。'
      :state==='sending'?'原话仍保存在本机；刚才的处理结果还不能确认。请重新打开对话核对当前状态。'
      :state==='completed'?'这段原话已发给小零，回复已保存。'
        :state==='failed'?'原话已保存在本机；这次没有收到回复，您可以继续记录新的内容。'
          :state==='discarded'?'原话仍保存在本机；等待回复时内容或资料发生变化，回复没有写入。请重新查看后再继续。'
            :'原话仍保存在本机；刚才没有发送。请稍后再查看。';
    setVoiceStatus(message,state==='failed'||state==='discarded'?'error':state==='completed'?'ok':'error');
    await loadEvents();return state==='completed';
  }catch{
    setVoiceStatus('原话仍保存在本机；刚才的处理结果还不能确认。请重新打开对话核对当前状态。','error');return false;
  }finally{
    saveBusy=false;setVoiceComposerEnabled(true);renderVoiceConversation();
  }
}
async function pauseConversation(){
  if(voiceCaptureIntent)voiceCaptureIntent.invalidated=true;
  if(typeof releaseOriginalsIn==='function')releaseOriginalsIn($('voiceConversationTurns'));
  const conversation=activeConversation;
  if(!conversation?.conversation_id)return true;
  if(conversation.trial_control)return true;
  const conversationId=conversation.conversation_id,subjectId=typeof activeHealthSubjectId==='undefined'?(conversation.subject_id||'subject_self'):activeHealthSubjectId;
  const subjectVersion=typeof healthSubjectsVersion==='undefined'?null:healthSubjectsVersion,subjectEpoch=typeof healthSubjectUiEpoch==='undefined'?null:healthSubjectUiEpoch;
  const saveWarning='退出时未能确认保存结果，请重新打开对话核对。';
  try{
    const x=await api(`/api/conversations/${encodeURIComponent(conversationId)}/pause`,{method:'POST',body:'{}'}),saved=x.j.conversation;
    if(!x.r.ok||!saved||saved.conversation_id!==conversationId||(saved.subject_id||subjectId)!==subjectId){toast(saveWarning);return false}
    if(activeConversation?.conversation_id===conversationId&&(activeConversation.subject_id||subjectId)===subjectId
      &&(subjectVersion===null||healthSubjectsVersion===subjectVersion)&&(subjectEpoch===null||healthSubjectUiEpoch===subjectEpoch)
      &&(typeof healthSubjectChanged==='undefined'||!healthSubjectChanged)
      &&!(typeof healthSubjectSwitchBusy!=='undefined'&&healthSubjectSwitchBusy))activeConversation=saved;
    return true;
  }catch{toast(saveWarning);return false}
}
async function submitConversationText(text,extra={}){
  if(typeof healthSubjectSwitchBusy!=='undefined'&&healthSubjectSwitchBusy)return false;
  if(saveBusy||!activeConversation?.conversation_id)return false;
  const clean=String(text||'').trim();if(!clean){setVoiceStatus('请先说或写下想记录的内容。','error');return false}
  let respondingTo=null,quoteRef=null;
  if(pendingFollowupTarget){
    if(activeConversation.trial_control||activeConversation.saved_audio_trial){setVoiceStatus('当前对话有单次试验停点；引用没有发送。请先处理停点。','error');return false}
    if(pendingFollowupTarget.subject_id!==(activeConversation.subject_id||'subject_self')){
      clearVoiceFollowupTarget();setVoiceStatus('所属人已变化；引用已清除，输入内容仍保留。请重新选择消息。','error');return false;
    }
    if(pendingFollowupTarget.invalid||!followupTargetTurn(activeConversation,pendingFollowupTarget)){
      invalidateVoiceFollowupTarget();setVoiceStatus('引用已失效；输入内容仍保留。请重新选择一条消息，或取消引用后再发送。','error');return false;
    }
    const captured=extra.voice_capture_intent?.quoteSnapshot;
    if(extra.source_kind==='audio_transcript'&&(!captured||captured.turn_id!==pendingFollowupTarget.turn_id||captured.version!==pendingFollowupTarget.version
      ||captured.role!==pendingFollowupTarget.role||captured.text!==pendingFollowupTarget.text)){
      setVoiceStatus('录音开始后引用已取消或变化；录音原件仍保留，没有发送。请重新选择引用并决定是否重试。','error');return false;
    }
    quoteRef={turn_id:pendingFollowupTarget.turn_id,version:pendingFollowupTarget.version};
  }
  if(extra.source_kind==='audio_transcript'&&extra.voice_capture_intent&&!voiceRecordingIntentIsCurrent(extra.voice_capture_intent)){
    setVoiceStatus('录音开始后对话、所属人或引用已有变化；录音原件仍保留，没有发送。','error');return false;
  }
  if((extra.source_kind==='audio_transcript'||extra.media_id)&&mockText(clean)){setVoiceStatus(mockWarning,'error');return false}
  if(extra.source_kind==='audio_transcript'){
    if(!extra.record_id||!extra.media_id){setVoiceStatus('录音来源信息不完整；识别文字和原件仍保留。','error');return false}
    let eventResult,mediaResult,eventsResult,conversationResult;
    try{[eventResult,mediaResult,eventsResult,conversationResult]=await Promise.all([
      api('/api/events/'+encodeURIComponent(extra.record_id)),
      api('/api/media/'+encodeURIComponent(extra.media_id)),
      api('/api/events'),
      api('/api/conversations/'+encodeURIComponent(activeConversation.conversation_id)),
    ])}catch{setVoiceStatus('录音来源或当前对话暂时无法核对；识别文字和原件仍保留。','error');return false}
    const event=eventResult.j?.event,media=mediaResult.j?.media,latestConversation=conversationResult.j?.conversation;
    const currentSource=media&&globalThis.HealthSafety?.currentAudioSource(media,eventsResult.j?.events||[]);
    if(!eventResult.r.ok||!mediaResult.r.ok||!eventsResult.r.ok||!conversationResult.r.ok||!event||!media||!latestConversation){setVoiceStatus('录音来源或当前对话暂时无法核对；识别文字和原件仍保留。','error');return false}
    const automaticTranscript=extra.audio_source_status==='machine_transcribed';
    if(media.kind!=='audio'||media.recognition_status!=='succeeded'||isMockContent(media)||currentSource?.record_id!==event.record_id
      ||event.source_kind!=='audio_transcript'||event.state==='superseded'||(!automaticTranscript&&globalThis.HealthSafety?.audioNeedsReview(event)!==false)
      ||automaticTranscript&&(!media.temporary||media.conversation_id!==activeConversation.conversation_id||media.subject_id&&media.subject_id!==activeConversation.subject_id)
      ||event.raw_text!==clean){setVoiceStatus('录音文字尚未完成核对，或来源已变化；请重新核对当前原音和文字。','error');return false}
    if((extra.source_version!==undefined&&Number(extra.source_version)!==event.version)
      ||(extra.media_version!==undefined&&Number(extra.media_version)!==media.version)){setVoiceStatus('录音或识别记录刚有更新；请重新核对后再继续。','error');return false}
    if(latestConversation.conversation_id!==activeConversation.conversation_id){setVoiceStatus('当前对话已切换；录音原件和识别文字仍保留。','error');return false}
    if(extra.voice_capture_intent&&!voiceRecordingIntentIsCurrent(extra.voice_capture_intent)){setVoiceStatus('这段录音开始后，对话或所属人已有变化；原件仍保留，没有自动发送。','error');return false}
    const explicitPausedCapture=extra.explicit_paused_audio_capture===true&&extra.voice_capture_intent?.conversationStatus==='paused'
      &&voiceRecordingIntentIsCurrent(extra.voice_capture_intent);
    if(automaticTranscript&&latestConversation.status!=='active'
      &&!(extra.explicit_recovered_audio_continue===true&&latestConversation.status==='paused')
      &&!(explicitPausedCapture&&latestConversation.status==='paused')){setVoiceStatus('对话已暂停；这段新录音只保存在本机，没有自动发送。重新进入并明确继续后，可在记录详情核对后加入。','error');return false}
    if(latestConversation.version!==activeConversation.version){syncConversation(latestConversation,{speak:false});setVoiceStatus('这份对话刚有更新，已重新读取；请核对后再继续发送。','error');return false}
    extra={...extra,source_version:event.version,media_version:media.version};
  }
  saveBusy=true;setVoiceComposerEnabled(false);globalThis.speechSynthesis?.cancel?.();
  pendingConversationTurn={turn_id:'pending',role:'elder',text:clean,pending:true,source_kind:extra.source_kind||'elder',
    ...(extra.source_kind==='audio_transcript'?{audio_processing:true,pending_audio_stage:'sending',media_id:extra.media_id||null,record_id:extra.record_id||null,
      audio_duration_seconds:extra.audio_duration_seconds||pendingConversationTurn?.audio_duration_seconds||0,followOnRender:pendingConversationTurn?.followOnRender===true}:{followOnRender:true})};
  renderVoiceConversation();setVoiceStatus(extra.source_kind==='audio_transcript'?'小零正在生成回复…':'原话正在保存，小零稍后回复…');
  const operationKey=extra.idempotencyKey||crypto.randomUUID(),body={text:clean,source_kind:extra.source_kind||'elder',record_id:extra.record_id||null,media_id:extra.media_id||null,expected_version:activeConversation.version};
  if(extra.source_version!==undefined)body.source_version=extra.source_version;
  if(extra.media_version!==undefined)body.media_version=extra.media_version;
  if(extra.audio_source_status)body.audio_source_status=extra.audio_source_status;
  if(Number.isFinite(Number(extra.audio_duration_seconds))&&Number(extra.audio_duration_seconds)>0)body.audio_duration_seconds=Math.min(3600,Math.round(Number(extra.audio_duration_seconds)));
  if(extra.keep_media_until_pause===true)body.keep_media_until_pause=true;
  if(quoteRef)body.quote_ref=quoteRef;
  else if(respondingTo)body.responding_to=respondingTo;
  const x=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}/turns`,{method:'POST',headers:{'Idempotency-Key':operationKey},body:JSON.stringify(body)});
  saveBusy=false;pendingConversationTurn=null;
  if(!x.r.ok||!x.j.conversation){
    if(['responding_to_invalid','followup_target_stale','followup_target_context_changed','followup_target_not_allowed','quote_context_invalid','quote_context_stale'].includes(x.j?.error)){
      if(respondingTo&&pendingFollowupTarget?.conversation_id===activeConversation?.conversation_id
        &&pendingFollowupTarget?.turn_id===respondingTo.turn_id)invalidateVoiceFollowupTarget();
      renderVoiceConversation();setVoiceComposerEnabled(true);
      setVoiceStatus('追问引用已失效；这句话仍在输入框，请重新选择一条可用回复，或取消引用后再发送。','error');return false;
    }
    if(x.j.error==='stale_conversation'){
      saveBusy=true;setVoiceComposerEnabled(false);
      let refreshed=null;
      try{refreshed=await api(`/api/conversations/${encodeURIComponent(activeConversation.conversation_id)}`)}catch{}
      if(refreshed?.r.ok&&refreshed.j?.conversation){syncConversation(refreshed.j.conversation,{speak:false});setVoiceComposerEnabled(false)}
      else renderVoiceConversation();
      saveBusy=false;setVoiceComposerEnabled(true);
      setVoiceStatus('对话或相关资料刚有更新；这句话尚未发送。请核对更新后的内容，再次点击发送。','error');return false
    }
    renderVoiceConversation();setVoiceComposerEnabled(true);
    if(x.j.error==='local_storage_full'){setVoiceStatus('本机存储空间不足，这次保存没有完整完成。请先复制输入文字并保留当前页面；释放设备空间后，先核对当前对话和“我的记录”，再决定是否重试。不要清除本应用的网站数据。','error');return false}
    if(x.j.error==='trial_source_changed'&&x.j.raw_text_preserved_on_device){void loadConversation();setVoiceStatus('这次原话已保存在“我的记录”，尚未接入当前对话；请先核对当前停点，输入仍保留。','error');return false}
    if(['trial_stopped','trial_review_required'].includes(x.j.error)){setVoiceStatus(x.j.error==='trial_stopped'?'本次试验已停止，这次输入尚未保存；请保留输入。':'请先处理已保存原话的核对停点，这次输入仍保留。','error');return false}
    if(x.r.status===409)void loadConversation();setVoiceStatus(x.r.status===409?'这份对话已在另一个页面更新；已重新读取，刚才输入仍保留，请再发送一次。':'这句话没有确认保存，请保留当前页面后重试。','error');return false
  }
  if((respondingTo||quoteRef)&&pendingFollowupTarget?.conversation_id===activeConversation?.conversation_id
    &&pendingFollowupTarget?.turn_id===(quoteRef?.turn_id||respondingTo?.turn_id))clearVoiceFollowupTarget();
  const synced=syncConversation(x.j.conversation);const textTrial=x.j.text_trial;if(!synced&&textTrial){setVoiceStatus('所属人已变化；原话在本次联网请求前已加密保存在原所属人的本机，本次没有发送给小零。切回原所属人后可以查看。','error');return false}const status=textTrial?.state==='saved_only'?(x.j.conversation.new_text_trial?.first_send_available?'原话已加密保存在本机；联网回复暂不可用，稍后可以点击“把这段话发给小零”，也可以继续记录。':'原话已加密保存在本机；这次没有发送，请先处理对话中的提示。'):textTrial?.state==='failed'?'原话已保存在本机；这次没有收到回复，不能重复发送同一段。您可以继续记录新的内容。':textTrial?.state==='discarded'?'原话仍保存在本机；等待回复期间资料或停点发生变化，旧回复没有写入。您可以继续记录新的内容。':x.j.ai_failed?'原话和报告已保存在本机；联网回复没完成，可点对话中的“重试小零回复”，也可以继续打字。':'原话和报告已保存。';setVoiceStatus(x.j.trial_control?trialVoiceMessage(x.j.trial_control):status,x.j.ai_failed?'error':'ok');await loadEvents();return true;
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
function audioNeedsReview(e){return e?.source_kind==='audio_transcript'&&(globalThis.HealthSafety?.audioNeedsReview?.(e)??true)}
function documentSourceReviewHtml(e){
  if(e.source_kind!=='document')return '';
  if(e.state==='superseded')return '<p class="status">这是保留的旧版本。请返回我的记录，在最新版本中核对或修订。</p>';
  return documentNeedsReview(e)?'<section class="source-review"><h3>先核对照片文字</h3><p class="status warn">这些文字是机器识别草稿，可能补错残缺内容。核对前不会用于 AI 整理、事实或交接正文。旧记录也需要核对原件。</p><p>请先打开照片，逐行核对项目、数值、单位、阴阳性和标题。有误请点“保留历史并修订”；看不清的部分改为 [无法辨认]，不要猜。</p><label><input id="sourceReviewCheck" type="checkbox" disabled>我已对照原件核对；无法确认的内容已标为无法辨认</label><button id="sourceReviewBtn" class="primary" type="button" disabled>保存原件核对结果</button><p id="sourceReviewStatus" role="status" aria-live="polite">打开照片并核对后，可以保存核对结果。</p></section>':'<p class="status">已由使用者对照原件核对文字。这是文字核对，不是医学确认；无法辨认的内容仍保持未知。</p>';
}
function audioSourceReviewHtml(e){
  if(e.source_kind!=='audio_transcript')return '';
  if(e.state==='superseded')return '<p class="status">这是保留的旧录音文字。请从原件入口打开当前版本。</p>';
  if(globalThis.HealthSafety?.audioNeedsReview(e)===false)return '<p class="status">已由使用者核对当前录音文字。仅确认文字准确，不代表医学确认；再次修订后需要重新核对。</p>';
  return '<section class="source-review"><h3>核对录音文字</h3><p>请对照原录音核对当前文字；有误请先“保留历史并修订”，听不清的内容请保留为未知。核对后才可用这份文字新建对话。</p><button id="audioOriginalBtn" class="outline" type="button">对照录音原件</button><div id="audioOriginals" aria-live="polite"></div><label><input id="audioSourceReviewCheck" type="checkbox" disabled>我已对照原录音核对当前文字</label><button id="audioSourceReviewBtn" class="primary" type="button" disabled>确认录音文字准确（非医学确认）</button><p id="audioSourceReviewStatus" role="status" aria-live="polite">打开原录音并核对后，可以保存文字核对结果。</p></section>';
}
function detailHtml(e,{organizeFailed=false,relatedRecords=null}={}){
  const mock=isMockContent(e),pending=documentNeedsReview(e),pendingAudio=audioNeedsReview(e),pendingSource=pending||pendingAudio,draft=mock||pendingSource?'':draftHtml(e,{organizeFailed});
  if(mock)return `<div class="event-date">${dateText(e.recorded_at)} · 历史模拟内容</div><h3>保留的历史文字</h3><p class="status error">${escapeHtml(mockWarning)}</p><div class="raw-box">${escapeHtml(e.raw_text)}</div><div class="actions"><button class="outline" id="historyBtn">查看历史版本</button></div><div id="subview"></div>`;
  const pendingLabel=pending?'照片文字待核对':pendingAudio?'语音转写待核对':stateLabel(e.state);
  return `<div class="event-date">${dateText(e.recorded_at)} · ${pendingLabel} · 来源：${escapeHtml(SOURCE_KIND_LABELS[e.source_kind]||'来源未标明')}</div><h3>${e.source_kind==='document'?'资料文字（请对照原件）':pendingAudio?'机器识别文字（请对照原录音）':'原话'}</h3><div class="raw-box">${escapeHtml(e.raw_text)}</div>${e.source_kind==='document'?'<button class="outline" id="documentOriginalBtn" type="button">对照照片原件</button><div id="documentOriginals" aria-live="polite"></div>':''}${documentSourceReviewHtml(e)}${audioSourceReviewHtml(e)}${pendingSource?'':safetyHtml(e.local_safety)}${draft}${relatedHistoryHtml(e,relatedRecords)}<div class="actions">${!pendingSource&&(['inbox','needs_review'].includes(e.state)||(organizeFailed&&e.state==='draft'))?'<button class="primary" id="organizeBtn">使用 AI 整理</button>':''}${!pendingSource&&e.state==='draft'&&!organizeFailed?'<button class="primary" id="reviewBtn">确认记录准确（非医学确认）</button><button class="outline" id="rejectBtn">退回重新整理</button>':''}${e.state!=='superseded'?'<button class="outline" id="reviseBtn">保留历史并修订</button>':''}<button class="outline" id="historyBtn">查看历史</button></div><div id="organizeStatus" role="status" aria-live="polite"></div>${e.supersedes_id?`<button class="outline" onclick="showDetail('${e.supersedes_id}')">查看修订前原文</button>`:''}<div id="subview"></div>`;
}
function renderDetail(e,options={}){
  const mock=isMockContent(e);current=e;safetyBanner(mock||documentNeedsReview(e)||audioNeedsReview(e)?null:e.local_safety);
  const pageTitle=$('detailPageTitle');if(pageTitle)pageTitle.textContent='单条记录详情';
  const d=$('detail');if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(d);d.classList.remove('hidden');
  const selected=!mock&&handoffSelection.has(e.record_id);
  const deleteMode=recordDeleteEntryMode(e);
  const initialDeleteScopeMessage=deleteMode==='unknown'?'先确认所属对话；读取失败时不会开放删除。':deleteMode==='unresolved'?'这条原话注明属于完整对话，但暂时找不到所属内容。':'';
  d.innerHTML=`<div class="record-detail-actions"><label><input id="eventHandoffSelect" type="checkbox" ${selected?'checked':''} ${mock?'disabled':''}>用于就诊交接</label>${localMode?`<button id="deleteEventDetailBtn" class="outline" type="button">${recordDeleteEntryLabel(deleteMode)}</button>`:''}</div>${localMode?`<div id="recordDeleteScopeStatus" class="muted" role="status" aria-live="polite">${initialDeleteScopeMessage?`<p>${initialDeleteScopeMessage}</p>`:''}</div>`:''}`+(mock?`<p class="status error">${escapeHtml(mockWarning)}</p>`:'')+detailHtml(e,options);
  const handoffChoice=d.querySelector('#eventHandoffSelect');if(handoffChoice)handoffChoice.onchange=()=>setHandoffSelection([e.record_id],!mock&&handoffChoice.checked);
  const deleteButton=d.querySelector('#deleteEventDetailBtn');if(deleteButton)deleteButton.onclick=()=>routeRecordDeleteEntry(e,deleteButton);
  if($('documentOriginalBtn'))$('documentOriginalBtn').onclick=()=>showDocumentOriginals(e.record_id);
  if($('audioOriginalBtn'))$('audioOriginalBtn').onclick=()=>showAudioOriginals(e.record_id);
  if($('audioSourceReviewCheck'))$('audioSourceReviewCheck').onchange=()=>{$('audioSourceReviewBtn').disabled=!$('audioSourceReviewCheck').checked};
  if($('audioSourceReviewBtn'))$('audioSourceReviewBtn').onclick=async()=>{
    const button=$('audioSourceReviewBtn'),status=$('audioSourceReviewStatus'),check=$('audioSourceReviewCheck'),request=detailRequestSerial;
    const linkedConversationId=(activeConversation?.turns||[]).some(turn=>turn.role==='elder'&&!turn.superseded&&turn.record_id===e.record_id)
      ?activeConversation.conversation_id:null;
    if(button.disabled||!check.checked)return;button.disabled=true;check.disabled=true;status.textContent='正在保存文字核对结果…';
    try{
      const x=await api('/api/events/'+e.record_id+'/source-review',{method:'POST',body:JSON.stringify({expected_version:e.version,compared_with_original:true})});
      if(x.r.ok){
        await loadEvents();
        if(detailStillCurrent(e,request))await showDetail(e.record_id);
        if(linkedConversationId&&activeConversation?.conversation_id===linkedConversationId){
          const latest=await api('/api/conversations/'+encodeURIComponent(linkedConversationId));
          if(latest.r.ok&&latest.j.conversation&&activeConversation?.conversation_id===linkedConversationId){
            syncConversation(latest.j.conversation,{speak:false});
            setVoiceStatus('录音文字已核对；已更新回原对话。旧整理结果未恢复，可在本对话中明确重新整理。','ok');
          }
        }
        toast('录音文字核对结果已保存（非医学确认）');
      }
      else if(detailStillCurrent(e,request)){status.textContent='文字核对结果未保存，请重新打开当前版本后再试。';check.disabled=false;button.disabled=!check.checked}
    }catch{if(detailStillCurrent(e,request)){status.textContent='文字核对结果未保存，当前文字仍保留。';check.disabled=false;button.disabled=!check.checked}}
  };
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
function recordConversationsForEvent(event,records=[event]){
  const subjectId=event?.subject_id||activeHealthSubjectId;if(subjectId!==activeHealthSubjectId)return [];
  const recordIds=new Set(records.map(item=>item?.record_id).filter(Boolean));
  const sourceConversationIds=new Set(records.map(item=>item?.source_conversation_id).filter(Boolean));
  const matches=new Map();
  for(const conversation of [...conversations,activeConversation,currentConversationDetail]){
    if(!conversation?.conversation_id||((conversation.subject_id||'subject_self')!==subjectId))continue;
    if(sourceConversationIds.has(conversation.conversation_id)
      ||(conversation.turns||[]).some(turn=>turn.role==='elder'&&recordIds.has(turn.record_id)))matches.set(conversation.conversation_id,conversation);
  }
  return [...matches.values()];
}
function recordRevisionChainFromEvents(event){
  const byId=new Map(events.map(item=>[item.record_id,item])),records=[],seen=new Set();let cursor=event;
  while(cursor){
    if(seen.has(cursor.record_id))return {ok:false,parentId:cursor.supersedes_id||cursor.record_id,cycle:true};
    seen.add(cursor.record_id);records.push(cursor);
    if(!cursor.supersedes_id)return {ok:true,records};
    cursor=byId.get(cursor.supersedes_id);
    if(!cursor)return {ok:false,parentId:records.at(-1).supersedes_id};
  }
  return {ok:false,parentId:event?.record_id};
}
async function readRecordRevisionChain(event){
  const byId=new Map(events.map(item=>[item.record_id,item])),records=[],seen=new Set();let cursor=event;
  while(cursor){
    if(seen.has(cursor.record_id))return {ok:false,parentId:cursor.supersedes_id||cursor.record_id,cycle:true};
    seen.add(cursor.record_id);records.push(cursor);
    const parentId=cursor.supersedes_id;if(!parentId)return {ok:true,records};
    let parent=byId.get(parentId);
    if(!parent){
      try{const {r,j}=await api('/api/events/'+encodeURIComponent(parentId));parent=j?.event;
        if(!r.ok||parent?.record_id!==parentId||(parent.subject_id||'subject_self')!==(event.subject_id||'subject_self'))return {ok:false,parentId};
      }catch{return {ok:false,parentId}}
    }
    cursor=parent;
  }
  return {ok:false,parentId:event?.record_id};
}
function recordDeleteEntryMode(event){
  if(recordRelationshipsSubjectId!==activeHealthSubjectId)return 'unknown';
  const chain=recordRevisionChainFromEvents(event);if(!chain.ok)return 'unresolved';
  const owners=recordConversationsForEvent(event,chain.records);
  if(owners.length>1)return 'multiple';
  if(owners.length===1)return 'linked';
  return event?.source_conversation_id?'unresolved':'record';
}
function recordDeleteEntryLabel(mode){return ({unknown:'确认所属对话',unresolved:'重新读取所属对话',linked:'查看所属完整对话',multiple:'选择所属完整对话',record:'删除这条记录'})[mode]||'确认所属对话'}
async function loadRelatedHistory(e){const request=detailRequestSerial,ids=Array.isArray(e.related_record_ids)?e.related_record_ids.slice(0,10):[];if(!ids.length)return;const records=[];for(const id of ids){const x=await api('/api/events/'+encodeURIComponent(id));if(x.r.ok&&x.j.event)records.push(x.j.event)}if(detailStillCurrent(e,request))renderDetail(e,{relatedRecords:records,focus:false})}
function conversationTurnTime(turn){return turn?.created_at?new Date(turn.created_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''}
function conversationTranscriptTurnHtml(turn){
  const assistant=turn.role==='assistant',mock=isMockContent(turn),failed=assistant&&turn.ai_failed,speaker=assistant?'小零':'我',time=conversationTurnTime(turn),history=!assistant&&!mock&&turn.versions?.length?`<details class="turn-history"><summary>查看修改前文字</summary>${turn.versions.map(version=>`<p>第 ${escapeHtml(version.version)} 版：${escapeHtml(version.text||'')}</p>`).join('')}</details>`:'',historicalFailure=failed?`<details class="turn-history"><summary>当时系统提示（历史）</summary><p>${escapeHtml(turn.text||'')}</p></details>`:'',displayText=failed?assistantFailureCopy(turn):turn.text||'';
  const audio=!assistant&&!mock&&turn.source_kind==='audio_transcript';
  const unavailable=audio&&turn.media_id&&typeof unavailableConversationOriginalIds!=='undefined'&&unavailableConversationOriginalIds.has(turn.media_id);
  const content=audio&&turn.media_id?(unavailable?`<div class="voice-transcript-bubble"><p>${escapeHtml(turn.text||'')}</p></div><small class="voice-audio-provenance">没有找到这段录音原件</small>`:voiceAudioMessageHtml(turn,'',{showProvenance:false})):`${mock?`<small class="mock-content-warning">${escapeHtml(mockWarning)}</small>`:''}<p>${escapeHtml(displayText)}</p><small>${mock?'模拟内容':speaker}${time?` · ${escapeHtml(time)}`:''}${!assistant&&!mock&&turn.version>1?` · 已修改，第 ${escapeHtml(turn.version)} 版`:''}</small>`;
  return `<article class="chat-turn ${assistant?'assistant-turn':'user-turn'}${audio&&turn.media_id?' audio-turn':''} archive-chat-turn">${assistant?'<img class="chat-avatar" src="assets/brand-mascot.png?v=20260930-real-acceptance-9" alt="" aria-hidden="true">':''}<div class="chat-bubble ${assistant?'assistant-bubble':'user-bubble'}">${content}${history}${historicalFailure}</div></article>`;
}
function legacyReorganizationOutputCandidate(conversation){
  if(!localMode)return null;
  const candidate=conversation?.legacy_reorganization_candidate;
  if(!candidate||!candidate.turn||!Number.isSafeInteger(candidate.turn.version)||candidate.turn.version<1
    ||typeof candidate.turn.text!=='string'||!candidate.turn.text.trim()||candidate.turn.text.length>1000
    ||!Number.isFinite(Date.parse(candidate.turn.created_at||''))||typeof candidate.trace_id!=='string'||!candidate.trace_id.trim()
    ||typeof candidate.provider!=='string'||!candidate.provider.trim()
    ||!/^([a-f0-9]{64})$/.test(candidate.scope_id||'')||!/^([a-f0-9]{64})$/.test(candidate.body_sha256||''))return null;
  return candidate;
}
function legacyReorganizationOutputReviewHtml(candidate,review){
  if(!candidate)return '';
  if(!review||review.turnId!==candidate.turn.turn_id)return `<section class="legacy-operation-review"><h2>核对旧的整理回复</h2><p>这次旧版重整可能把系统操作回复加入了对话。系统不会自动撤下，请先查看完整内容并由您确认。</p><button class="chat-secondary-action" type="button" data-legacy-reorganization-review>查看并核对这条旧回复</button></section>`;
  return `<section class="legacy-operation-review" data-legacy-reorganization-form><h2>核对旧的整理回复</h2><p>以下完整文字只供识别旧重整输出。确认后它会从当前有效对话中撤下，原文和来源记录仍留在历史；不会删除或改写患者原话、报告事实，也不会调用模型。</p><blockquote>${escapeHtml(candidate.turn.text)}</blockquote><label class="correction-confirm"><input type="checkbox" data-legacy-reorganization-confirm ${review.confirmed?'checked':''} ${review.busy?'disabled':''}>这是上次重新整理产生的旧回复，仅保留历史</label>${review.error?`<small class="chat-edit-error" role="status">${escapeHtml(review.error)}</small>`:''}<div class="chat-edit-actions"><button class="chat-action" type="button" data-legacy-reorganization-save ${!review.confirmed||review.busy?'disabled':''}>${review.busy?'正在本机保存…':'确认并仅保留历史'}</button><button class="chat-secondary-action" type="button" data-legacy-reorganization-cancel ${review.busy?'disabled':''}>取消</button></div></section>`;
}
function legacyReorganizationOutputHistoryHtml(conversation){
  const history=conversation?.legacy_reorganization_history||[];
  if(!history.length)return '';
  return `<section class="legacy-operation-history"><details><summary>历史整理操作回复（${history.length}）</summary>${history.map(turn=>`<article class="archive-chat-turn"><p><b>旧整理回复 · 已从当前对话撤下</b></p><blockquote>${escapeHtml(turn.text||'')}</blockquote><small>原记录 ${escapeHtml(turn.turn_id)}${turn.trace_id?` · trace ${escapeHtml(turn.trace_id)}`:''}${turn.provider?` · ${escapeHtml(turn.provider)}`:''}${turn.created_at?` · ${escapeHtml(conversationTurnTime(turn))}`:''}</small></article>`).join('')}<p class="muted">以上内容保留作历史核对，不作为当前有效对话或后续回复依据。</p></details></section>`;
}
function conversationSafety(conversation){
  const elderTurns=elderArchiveTurns(conversation).filter(turn=>!isMockContent(turn)),danger=elderTurns.find(turn=>turn.local_safety?.danger_detected),review=elderTurns.find(turn=>turn.local_safety?.clinical_review_required);
  const reviewedRisks=(conversation.report?.reviewed_risk_assessments||[]).filter(assessment=>globalThis.HealthSafety?.reviewedRiskSourcesCurrent(assessment,elderTurns));
  const reviewedRisk=reviewedRisks.find(assessment=>assessment.level==='urgent')||reviewedRisks.find(assessment=>assessment.level==='soon_evaluation');
  return {danger_detected:Boolean(danger),danger_reminder:danger?.local_safety?.danger_reminder,clinical_review_required:Boolean(review),clinical_review_notice:review?.local_safety?.clinical_review_notice,reviewed_risk_level:reviewedRisk?.level,reviewed_risk_notice:reviewedRisk?.notice};
}
function conversationDetailHtml(conversation){
  const turns=liveArchiveTurns(conversation),elderTurns=elderArchiveTurns(conversation),elderCount=elderTurns.filter(turn=>!isMockContent(turn)).length,hasMock=elderTurns.some(isMockContent),date=conversationDateLabel(conversation);
  const candidate=legacyReorganizationOutputCandidate(conversation),review=pendingLegacyReorganizationReview?.conversationId===conversation.conversation_id?pendingLegacyReorganizationReview:null;
  const recordIds=conversationRecordIds(conversation),checked=recordIds.length>0&&recordIds.every(id=>handoffSelection.has(id));
  return `<section class="conversation-detail-summary"><div class="event-date">${escapeHtml(date)} · ${escapeHtml(conversationStatusLabel(conversation.status))}</div><p><strong>就诊对象：</strong>${escapeHtml(reportSubjectLabel(conversation.subject_id))}</p><h2>这次记录了什么</h2><p>${escapeHtml(conversationSummary(conversation))}</p><div class="badges"><span class="badge">${elderCount} 段老人原话</span><span class="badge">完整上下文已保留</span>${hasMock?'<span class="badge warn">含模拟识别文字，不是患者事实</span>':''}</div><div class="record-detail-actions"><label><input id="conversationHandoffSelect" type="checkbox" ${checked?'checked':''} ${recordIds.length?'':'disabled'}>用于就诊交接</label>${localMode?'<button id="deleteConversationDetailBtn" class="outline" type="button">删除这条完整对话</button>':''}</div></section><section class="conversation-archive" aria-labelledby="conversationTranscriptTitle"><div class="conversation-archive-head"><div><h2 id="conversationTranscriptTitle">完整对话</h2><p>AI 问了什么、老人怎么回答，都按当时顺序保留。</p></div><span>${turns.length} 轮</span></div><div class="archive-conversation-stream">${turns.map(conversationTranscriptTurnHtml).join('')}</div></section>${legacyReorganizationOutputReviewHtml(candidate,review)}${legacyReorganizationOutputHistoryHtml(conversation)}`;
}
function renderConversationDetail(conversation){
  currentConversationDetail=conversation;current=conversation;safetyBanner(conversationSafety(conversation));
  const pageTitle=$('detailPageTitle');if(pageTitle)pageTitle.textContent=`${conversationDateLabel(conversation)}完整对话`;
  const d=$('detail');if(typeof releaseOriginalsIn==='function')releaseOriginalsIn(d);d.classList.remove('hidden');d.innerHTML=conversationDetailHtml(conversation);
  const recordIds=conversationRecordIds(conversation),selection=d.querySelector('#conversationHandoffSelect');if(selection)selection.onchange=()=>setHandoffSelection(recordIds,selection.checked);
  const deleteButton=d.querySelector('#deleteConversationDetailBtn');if(deleteButton)deleteButton.onclick=()=>deleteConversation(conversation,deleteButton);
  bindConversationSourceActions(d,conversation);
  d.querySelector('[data-legacy-reorganization-review]')?.addEventListener('click',()=>{
    const candidate=legacyReorganizationOutputCandidate(currentConversationDetail);if(!candidate)return;
    pendingLegacyReorganizationReview={conversationId:currentConversationDetail.conversation_id,turnId:candidate.turn.turn_id,
      expectedVersion:currentConversationDetail.version,turnVersion:candidate.turn.version,turnText:candidate.turn.text,
      traceId:candidate.trace_id,provider:candidate.provider,scopeId:candidate.scope_id,bodySha256:candidate.body_sha256,confirmed:false,busy:false,error:''};
    renderConversationDetail(currentConversationDetail);
  });
  d.querySelector('[data-legacy-reorganization-confirm]')?.addEventListener('change',event=>{
    if(pendingLegacyReorganizationReview?.conversationId!==currentConversationDetail?.conversation_id)return;
    pendingLegacyReorganizationReview.confirmed=event.target.checked===true;pendingLegacyReorganizationReview.error='';renderConversationDetail(currentConversationDetail);
  });
  d.querySelector('[data-legacy-reorganization-cancel]')?.addEventListener('click',()=>{pendingLegacyReorganizationReview=null;renderConversationDetail(currentConversationDetail)});
  d.querySelector('[data-legacy-reorganization-save]')?.addEventListener('click',()=>void confirmLegacyReorganizationOutput());
}
async function confirmLegacyReorganizationOutput(){
  const review=pendingLegacyReorganizationReview,conversation=currentConversationDetail;
  if(!localMode||!review?.confirmed||review.busy||!conversation||review.conversationId!==conversation.conversation_id)return false;
  const candidate=legacyReorganizationOutputCandidate(conversation);
  if(!candidate||candidate.turn.turn_id!==review.turnId||candidate.turn.version!==review.turnVersion||candidate.turn.text!==review.turnText
    ||candidate.trace_id!==review.traceId||candidate.provider!==review.provider||candidate.scope_id!==review.scopeId||candidate.body_sha256!==review.bodySha256){
    review.error='候选回复或整理来源已变化；没有撤下，请重新读取这段对话。';review.confirmed=false;renderConversationDetail(conversation);return false;
  }
  if(activeHealthSubjectId!==conversation.subject_id||healthSubjectSwitchBusy||healthSubjectChanged){
    review.error='当前所属人已变化；没有保存，请重新打开对话后核对。';review.confirmed=false;renderConversationDetail(conversation);return false;
  }
  review.busy=true;renderConversationDetail(conversation);const request=detailRequestSerial;
  try{
    const x=await api(`/api/conversations/${encodeURIComponent(conversation.conversation_id)}/legacy-reorganization-output/${encodeURIComponent(review.turnId)}/confirm`,{
      method:'POST',body:JSON.stringify({confirmed:true,expected_conversation_version:review.expectedVersion,expected_subject_id:conversation.subject_id,
        expected_subject_version:healthSubjectsVersion,expected_turn_id:review.turnId,expected_turn_version:review.turnVersion,
        expected_turn_text:review.turnText,expected_trace_id:review.traceId,expected_provider:review.provider,
        expected_scope_id:review.scopeId,expected_body_sha256:review.bodySha256})});
    if(request!==detailRequestSerial||currentConversationDetail?.conversation_id!==conversation.conversation_id)return false;
    if(!x.r.ok||!x.j?.conversation){review.busy=false;review.error='没有保存；候选可能已更新。原文仍保留，请重新读取后核对。';review.confirmed=false;renderConversationDetail(conversation);return false}
    pendingLegacyReorganizationReview=null;renderConversationDetail(x.j.conversation);toast('旧整理回复已从当前对话撤下，原文保留在历史区。');return true;
  }catch{
    if(request===detailRequestSerial&&currentConversationDetail?.conversation_id===conversation.conversation_id){review.busy=false;review.error='本机保存没有完成；原文仍保留，请重新读取后核对。';review.confirmed=false;renderConversationDetail(conversation)}
    return false;
  }
}
async function showConversationDetail(id){
  if(pendingConversationDetailOpen?.id===id)return pendingConversationDetailOpen.promise;
  const sequence=++conversationDetailOpenSequence;
  const promise=(async()=>{
    const fromActiveConversation=activeConversation?.conversation_id===id&&document.querySelector?.('.view.active')?.id==='voiceView';
    const navigation=viewNavigationSerial,subject=activeHealthSubjectId,subjectVersion=healthSubjectsVersion,subjectEpoch=healthSubjectUiEpoch;
    if(fromActiveConversation){
      if(mediaRecorder?.state==='recording'||voicePermissionPending||voiceUploadPending){toast(voicePermissionPending?'正在等待麦克风权限，请稍候':'正在录音或保留原件，请稍候');reveal($('voiceView'),'h1');return false}
      if(healthSubjectChanged||healthSubjectSwitchBusy||(activeConversation.subject_id||subject)!==subject){toast('所属人状态已变化，请重新选择后再打开详情。');return false}
      if(!await pauseConversation()||sequence!==conversationDetailOpenSequence||navigation!==viewNavigationSerial
        ||activeConversation?.conversation_id!==id||subject!==activeHealthSubjectId||subjectVersion!==healthSubjectsVersion
        ||subjectEpoch!==healthSubjectUiEpoch||healthSubjectChanged||healthSubjectSwitchBusy)return false;
    }
    if(!showView('recordDetailView',{readOnlyHistoryOpen:fromActiveConversation}))return false;
    const request=++detailRequestSerial,d=$('detail');if(d){d.classList.remove('hidden');d.innerHTML='<p class="muted detail-loading" role="status" aria-live="polite">正在读取完整对话…</p>'}
    const {r,j}=await api('/api/conversations/'+encodeURIComponent(id));if(request!==detailRequestSerial)return false;
    if(!r.ok||!j.conversation){if(d){d.innerHTML='<div class="load-error" role="status"><b>完整对话暂时无法读取</b><span>已有原话不会删除，请稍后重试。</span><button id="retryDetailBtn" class="outline" type="button">重新读取</button></div>';$('retryDetailBtn').onclick=()=>showConversationDetail(id)}toast('完整对话读取失败，请重试');return false}
    renderConversationDetail(j.conversation);return true;
  })();
  pendingConversationDetailOpen={id,promise};
  try{return await promise}finally{if(pendingConversationDetailOpen?.promise===promise)pendingConversationDetailOpen=null}
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
  else {toast(x.r.status===409&&x.j.error==='stale_version'?'记录已有新版本，请刷新后重试':'整理失败，原话仍在');b.disabled=false;b.textContent='整理记录';}
  await loadEvents();
}
async function review(e,action='confirm'){
  const b=$(action==='reject'?'rejectBtn':'reviewBtn');b.disabled=true;
  const request=detailRequestSerial;
  const x=await api('/api/events/'+e.record_id+'/review',{method:'POST',body:JSON.stringify({expected_version:e.version,action,note:action==='confirm'?'仅确认记录准确，不代表医生确认或风险消失':'退回重新整理'})});
  if(x.r.ok){toast(action==='confirm'?'已记录“记录准确”':'已退回重新整理');await loadEvents();if(detailStillCurrent(e,request))await showDetail(e.record_id);}
  else if(detailStillCurrent(e,request)){b.disabled=false;toast('核对未确认，请刷新后重试');}
}
function recordDeleteSnapshotIsCurrent(snapshot){
  if(!snapshot||pendingRecordDelete!==snapshot||snapshot.detailEpoch!==detailRequestSerial
    ||snapshot.subjectEpoch!==healthSubjectUiEpoch||snapshot.subjectId!==activeHealthSubjectId
    ||snapshot.subjectVersion!==healthSubjectsVersion||healthSubjectChanged||healthSubjectSwitchBusy)return false;
  if(snapshot.kind==='media')return typeof mediaItems!=='undefined'&&mediaItems.some(item=>item.media_id===snapshot.id
    &&item.version===snapshot.version&&standaloneMedia(item)&&!(typeof recognitionBusy!=='undefined'&&recognitionBusy.has(snapshot.id)));
  return snapshot.kind==='record'
    ?current?.record_id===snapshot.id&&current?.version===snapshot.version
    :currentConversationDetail?.conversation_id===snapshot.id&&currentConversationDetail?.version===snapshot.version;
}
function setRecordDeleteError(message=''){
  const error=$('recordDeleteError');if(!error)return;
  error.textContent=message;error.classList.toggle('hidden',!message);
}
function setRecordDeleteProgress(message=''){
  const status=$('recordDeleteProgress');if(!status)return;
  status.textContent=message;status.classList.toggle('hidden',!message);
}
function setRecordDeleteBusy(busy){
  const dialog=$('recordDeleteDialog'),confirmButton=$('recordDeleteConfirmBtn'),cancelButton=$('recordDeleteCancelBtn');
  if(dialog)dialog.setAttribute('aria-busy',String(busy));
  if(confirmButton){confirmButton.disabled=busy;confirmButton.textContent=busy?'正在删除…':'确认删除'}
  if(cancelButton)cancelButton.disabled=busy;
}
function cancelRecordDelete(event){
  if(recordDeleteBusy){event?.preventDefault?.();return false}
  const trigger=pendingRecordDelete?.trigger;
  pendingRecordDelete=null;setRecordDeleteError('');setRecordDeleteProgress('');
  const dialog=$('recordDeleteDialog');if(dialog?.open)dialog.close('cancel');
  if(trigger?.isConnected!==false)trigger?.focus?.();
  return true;
}
function openRecordDeleteDialog(kind,item,trigger){
  const dialog=$('recordDeleteDialog');
  if(recordDeleteBusy||!dialog||typeof dialog.showModal!=='function'){toast('无法打开删除确认窗口，请刷新页面后重试。');return false}
  const id=kind==='record'?item?.record_id:kind==='media'?item?.media_id:item?.conversation_id;
  const subjectId=item?.subject_id||activeHealthSubjectId;
  const matchesDetail=kind==='record'
    ?current?.record_id===id&&current?.version===item?.version
    :kind==='media'?typeof mediaItems!=='undefined'&&mediaItems.some(media=>media.media_id===id&&media.version===item?.version)
      &&typeof standaloneMedia==='function'&&standaloneMedia(item)&&!(typeof recognitionBusy!=='undefined'&&recognitionBusy.has(id))
    :currentConversationDetail?.conversation_id===id&&currentConversationDetail?.version===item?.version;
  if(!id||!Number.isSafeInteger(item?.version)||item.version<1||!matchesDetail
    ||!healthSubjectLoaded||healthSubjectChanged||healthSubjectSwitchBusy||subjectId!==activeHealthSubjectId){
    toast('这条记录或所属人已变化；没有删除，请重新打开详情核对。');return false;
  }
  const snapshot={kind,id,version:item.version,subjectId,subjectVersion:healthSubjectsVersion,
    subjectEpoch:healthSubjectUiEpoch,detailEpoch:detailRequestSerial,trigger};
  pendingRecordDelete=snapshot;
  $('recordDeleteTitle').textContent=kind==='record'?'确认删除这条记录？':kind==='media'?'确认删除这份未关联原件？':'确认删除这段对话？';
  $('recordDeleteExplanation').textContent=kind==='record'
    ?'这条本机记录、修订历史和关联原件将被删除，且无法撤销。旧备份不受影响。'
    :kind==='media'?'仅删除这份明确未关联的本机原件及其分片；如原件已关联记录或对话，请从对应记录统一删除。此操作无法撤销，旧备份不受影响。'
      :'这段本机对话、关联原话和本机原件将被删除，且无法撤销。旧备份不受影响。';
  setRecordDeleteError('');setRecordDeleteProgress('');setRecordDeleteBusy(false);
  try{dialog.showModal();$('recordDeleteCancelBtn')?.focus?.();return true}
  catch{pendingRecordDelete=null;toast('无法打开删除确认窗口，请刷新页面后重试。');return false}
}
function setRecordDeleteScopeStatus(message,owners=[],onOpen=null){
  const box=$('recordDeleteScopeStatus');if(!box)return;
  box.replaceChildren();
  if(message){const note=document.createElement('p');note.setAttribute('role','status');note.textContent=message;box.append(note)}
  owners.forEach((owner,index)=>{
    const button=document.createElement('button');button.type='button';button.className='outline';
    button.dataset.conversationId=owner.conversation_id||'';button.textContent=owner.label||`查看第 ${index+1} 段完整对话（${conversationDateLabel(owner)}）`;
    button.onclick=()=>owner.onOpen?owner.onOpen():onOpen?.(owner);box.append(button);
  });
}
async function routeRecordDeleteEntry(eventRecord,button){
  if(!button||button.disabled)return false;
  const initialMode=recordDeleteEntryMode(eventRecord),request=detailRequestSerial,subjectId=activeHealthSubjectId;
  button.disabled=true;button.textContent='正在确认所属对话…';setRecordDeleteScopeStatus('');
  const loaded=await loadEvents();
  if(loaded!==true||recordRelationshipsSubjectId!==subjectId||activeHealthSubjectId!==subjectId){
    if(detailStillCurrent(eventRecord,request)){button.disabled=false;button.textContent='重试确认所属对话';setRecordDeleteScopeStatus('暂时无法确认这条原话是否属于完整对话；没有删除。请重试读取。')}
    return false;
  }
  if(!detailStillCurrent(eventRecord,request)||healthSubjectChanged||healthSubjectSwitchBusy)return false;
  const latest=events.find(item=>item.record_id===eventRecord.record_id&&(item.subject_id||'subject_self')===subjectId);
  if(!latest||latest.version!==eventRecord.version){
    button.disabled=false;button.textContent='重新读取当前记录';setRecordDeleteScopeStatus('这条记录已更新或暂时无法读取；没有删除。请重新打开当前详情核对。');
    button.onclick=()=>void showDetail(eventRecord.record_id);return false;
  }
  const chain=await readRecordRevisionChain(latest);
  if(!chain.ok){
    button.disabled=false;button.textContent='读取修订前原文';
    setRecordDeleteScopeStatus(chain.cycle?'记录修订链存在循环，无法确认所属对话；没有删除。请读取原文核对。':'无法读取修订前原文，无法确认所属对话；没有删除。请先读取原文核对。',
      [{label:'读取修订前原文',onOpen:()=>void showDetail(chain.parentId)}]);return false;
  }
  const owners=recordConversationsForEvent(latest,chain.records);
  if(owners.length>1){
    button.disabled=false;button.textContent='选择所属完整对话';
    setRecordDeleteScopeStatus('这条原话被多段完整对话引用，请选择要查看的对话；不会自动删除。',owners,owner=>{
      if(detailStillCurrent(eventRecord,request)&&activeHealthSubjectId===subjectId)void showConversationDetail(owner.conversation_id);
    });return false;
  }
  if(owners.length===1){
    button.disabled=false;button.textContent='查看所属完整对话';setRecordDeleteScopeStatus('这条原话属于完整对话；打开对话只会查看，不会删除。');
    if(initialMode==='linked'){setRecordDeleteScopeStatus('');await showConversationDetail(owners[0].conversation_id);return true}
    return false;
  }
  if(chain.records.some(item=>item.source_conversation_id)){
    button.disabled=false;button.textContent='重试读取所属对话';setRecordDeleteScopeStatus('记录注明属于一段完整对话，但暂时无法读取所属对话；没有删除。请重试读取。');return false;
  }
  if(initialMode==='record'){
    button.disabled=false;button.textContent='删除这条记录';setRecordDeleteScopeStatus('');return deleteRecord(latest,button);
  }
  button.disabled=false;button.textContent='删除这条记录';setRecordDeleteScopeStatus('已确认这是一条独立记录。再次点击“删除这条记录”后，才会出现单独删除确认。');return false;
}
function recordDeleteFailureMessage(snapshot,result){
  const error=result?.j?.error;
  if(snapshot.kind==='media'&&error==='media_linked')return '这份原件已关联记录或对话，请从对应记录统一删除；原件未删除。';
  if(snapshot.kind==='media'&&error==='media_link_pending')return '这份原件仍在关联处理中；本次没有删除，请稍后刷新核对。';
  if(snapshot.kind==='media'&&error==='media_trial_controlled')return '这份原件属于受控处理；本次没有删除，请先完成核对。';
  if(snapshot.kind==='media'&&error==='media_owner_unknown')return '原件关联的所属人暂时无法确认；本次没有删除，请刷新后核对。';
  if(snapshot.kind==='media'&&['media_processing','media_upload_in_progress'].includes(error))return '这份原件仍在处理中或上传中；本次没有删除，请等处理结束后再试。';
  if(snapshot.kind==='media'&&error==='stale_version')return '这份原件刚有变化；本次没有删除，请刷新后重新确认。';
  if(snapshot.kind==='record'&&error==='conversation_source_changed')return '这条原话属于完整对话，请从就诊记录删除该对话；当前资料未删除。';
  if(snapshot.kind==='conversation'&&error==='conversation_source_shared')return result?.j?.message||'这段对话的原话还被其他对话引用，暂时不能删除；当前资料未删除。';
  if(snapshot.kind==='conversation'&&['conversation_media_owner_mismatch','conversation_media_owner_unknown'].includes(error))return result?.j?.message||'无法确认这段对话关联原件的所属人；本次没有删除，请先核对原件关联。';
  if(snapshot.kind==='record'&&error==='stale_version')return '这条记录刚有更新，请取消后重新打开再删除。';
  if(result?.r?.status===409)return '记录已有变化，本次删除没有完成；请取消后重新打开详情核对。';
  if(result?.r?.status===0)return '连接暂时不可用，删除结果未确认；请重试或取消后核对记录。';
  return '删除没有完成；请重试，或取消后重新核对详情。';
}
function finishRecordDelete(snapshot,result){
  if(snapshot.kind==='record')handoffSelection.delete(snapshot.id);
  else if(snapshot.kind==='conversation'){
    if(activeConversation?.conversation_id===snapshot.id)activeConversation=null;
    conversationRecordIds(currentConversationDetail||{}).forEach(recordId=>handoffSelection.delete(recordId));
  }
  invalidateMediaAfterDelete(snapshot.kind==='media'?[snapshot.id]:Array.isArray(result?.j?.deleted?.media_ids)?result.j.deleted.media_ids:null);
  globalThis.recordDataGeneration++;
  const mediaCount=Number(result?.j?.deleted?.local_media_count)||0;
  const dialog=$('recordDeleteDialog');pendingRecordDelete=null;recordDeleteBusy=false;setRecordDeleteBusy(false);setRecordDeleteError('');setRecordDeleteProgress('');
  if(dialog?.open)dialog.close('deleted');
  showView(snapshot.kind==='media'?'archiveView':'recordsView');
  void loadMedia();
  toast(snapshot.kind==='media'?'已删除这份未关联原件；旧备份未改变':`已删除${snapshot.kind==='record'?'这条记录':'这段对话'}${mediaCount?`和 ${mediaCount} 份关联原件`:''}；旧备份未改变`);
}
function deleteRecord(e,button=null){return openRecordDeleteDialog('record',e,button)}
function deleteConversation(conversation,button=null){return openRecordDeleteDialog('conversation',conversation,button)}
function deleteMedia(media,button=null){return openRecordDeleteDialog('media',media,button)}
async function confirmRecordDelete(){
  const snapshot=pendingRecordDelete;
  if(recordDeleteBusy||!snapshot)return false;
  if(!recordDeleteSnapshotIsCurrent(snapshot)){cancelRecordDelete();toast('记录、所属人或页面已变化；没有发起删除，请重新打开详情核对。');return false}
  recordDeleteBusy=true;setRecordDeleteBusy(true);setRecordDeleteError('');setRecordDeleteProgress(snapshot.kind==='media'?'正在删除这份本机原件…':'正在删除本机记录和关联原件…');
  const path=snapshot.kind==='record'?`/api/events/${encodeURIComponent(snapshot.id)}`:snapshot.kind==='media'?`/api/media/${encodeURIComponent(snapshot.id)}`:`/api/conversations/${encodeURIComponent(snapshot.id)}`;
  const body={delete_scope_confirmed:true,expected_version:snapshot.version};
  try{
    const result=await api(path,{method:'DELETE',body:JSON.stringify(body)});
    if(result?.r?.ok){
      if(!recordDeleteSnapshotIsCurrent(snapshot)){
        if(snapshot.kind==='record')handoffSelection.delete(snapshot.id);
        else if(snapshot.kind==='conversation'&&activeConversation?.conversation_id===snapshot.id)activeConversation=null;
        invalidateMediaAfterDelete(snapshot.kind==='media'?[snapshot.id]:Array.isArray(result?.j?.deleted?.media_ids)?result.j.deleted.media_ids:null);
        globalThis.recordDataGeneration++;
        void loadMedia();
        pendingRecordDelete=null;const dialog=$('recordDeleteDialog');if(dialog?.open)dialog.close('stale');
        toast('删除已完成，但页面或所属人已变化；请重新打开“我的记录”核对。');return true;
      }
      finishRecordDelete(snapshot,result);return true;
    }
    if(!recordDeleteSnapshotIsCurrent(snapshot)){
      pendingRecordDelete=null;const dialog=$('recordDeleteDialog');if(dialog?.open)dialog.close('stale');
      toast('页面或所属人已变化，删除结果未确认；请重新打开“我的记录”核对。');return false;
    }
    setRecordDeleteProgress('');setRecordDeleteError(recordDeleteFailureMessage(snapshot,result));return false;
  }catch{
    if(!recordDeleteSnapshotIsCurrent(snapshot)){
      pendingRecordDelete=null;const dialog=$('recordDeleteDialog');if(dialog?.open)dialog.close('stale');
      toast('页面或所属人已变化，删除结果未确认；请重新打开“我的记录”核对。');return false;
    }
    setRecordDeleteProgress('');setRecordDeleteError('连接暂时不可用，删除结果未确认；请重试，或取消后核对记录。');return false;
  }finally{
    recordDeleteBusy=false;
    if(pendingRecordDelete===snapshot)setRecordDeleteBusy(false);
  }
}
function bindRecordDeleteDialog(){
  const dialog=$('recordDeleteDialog');if(!dialog)return;
  dialog.addEventListener('cancel',event=>{
    event.preventDefault();cancelRecordDelete(event);
  });
  dialog.addEventListener('click',event=>{if(event.target===dialog)cancelRecordDelete()});
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();cancelRecordDelete(event);return}
    if(event.key!=='Tab')return;
    const focusable=[$('recordDeleteCancelBtn'),$('recordDeleteConfirmBtn')].filter(button=>button&&!button.disabled);
    if(!focusable.length){event.preventDefault();dialog.focus();return}
    const first=focusable[0],last=focusable[focusable.length-1],active=document.activeElement;
    if(!focusable.includes(active)){event.preventDefault();(event.shiftKey?last:first).focus();return}
    const index=focusable.indexOf(active),next=index+(event.shiftKey?-1:1);
    if(next<0||next>=focusable.length){event.preventDefault();(event.shiftKey?last:first).focus()}
    else{event.preventDefault();focusable[next].focus()}
  });
  $('recordDeleteCancelBtn').onclick=()=>cancelRecordDelete();
  $('recordDeleteConfirmBtn').onclick=()=>void confirmRecordDelete();
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
  const selectedRecordIds=localMode?[...handoffSelection].filter(id=>visibleHandoffRecordIds.has(id)):[];
  if(localMode&&!selectedRecordIds.length){toast('当前筛选中没有已勾选的有效记录，请调整筛选或勾选记录。');return false}
  const requestGeneration=++handoffPreviewGeneration,requestSubjectEpoch=typeof healthSubjectUiEpoch==='number'?healthSubjectUiEpoch:0;
  const b=$('handoffBtn');b.disabled=true;b.textContent='生成中…';
  const handoffBody=localMode?JSON.stringify({start_date:$('handoffStart')?.value||null,end_date:$('handoffEnd')?.value||null,record_ids:selectedRecordIds}):'{}';
  const x=await api('/api/handoffs',{method:'POST',body:handoffBody});b.disabled=false;b.textContent='生成就诊交接材料';
  if(requestGeneration!==handoffPreviewGeneration||requestSubjectEpoch!==(typeof healthSubjectUiEpoch==='number'?healthSubjectUiEpoch:0))return false;
  if(!x.r.ok){const box=$('handoff');box.classList.remove('hidden');box.innerHTML='<div class="load-error" role="status"><b>交接材料暂时无法生成</b><span>原话和原件仍保留，请恢复连接后重试。</span></div>';toast('生成失败，请重试');return;}
  const h=x.j.handoff,box=$('handoff');box.classList.remove('hidden');
  const conversationReports=(h.conversation_reports||[]).map(item=>`<article class="handoff-conversation"><div class="handoff-report-head"><b>${escapeHtml(item.report?.title||'就诊沟通记录')}</b><span class="badge warn">${escapeHtml(item.report?.status_label||'自动整理 · 本人未核对')}</span></div><p><strong>就诊对象：</strong>${escapeHtml(reportSubjectLabel(item.subject_id))}</p>${reportSectionsHtml(item.report)}${reportOriginalSourcesHtml(item.report)}<details class="report-transcript"><summary>查看完整对话（${item.transcript?.length||0} 轮）</summary><ol>${(item.transcript||[]).map(turn=>`<li><span>${turn.role==='assistant'?'小零':'老人'}</span><p>${escapeHtml(turn.text||'')}</p></li>`).join('')}</ol></details><p class="muted">报告第 ${escapeHtml(item.report?.version||1)} 版 · 内容来源为老人原话和已确认的本机健康背景</p></article>`).join('');
  box.innerHTML=`<div class="section-head"><h2 id="handoffTitle" tabindex="-1">就诊交接材料</h2><button class="view-btn" onclick="window.print()">打印</button></div><p><strong>就诊对象：</strong>${escapeHtml(reportSubjectLabel(h.subject_id))}</p><p class="handoff-disclaimer">用于沟通，不是诊断。不会提供加药、减药、停药、剂量或治疗方案。</p><p class="muted">下方列出所选记录关联的原件状态。打印只包含文字与状态，不包含照片；看图请在记录详情点“对照照片原件”。</p><p class="muted">生成于 ${dateText(h.created_at)} · ${h.unresolved_count||0} 项待处理。核对只确认记录准确，不代表医学风险已消除。</p>${conversationReports}`+
    (h.pending_documents||[]).map(i=>`<div class="handoff-item"><b>${dateText(i.recorded_at)} · 照片资料待核对</b><p>识别文字尚未对照原件确认，已从交接正文排除。请查看原件，不根据识别草稿作判断。</p><button class="outline" onclick="showDetail('${escapeHtml(i.record_id)}')">去核对原件</button></div>`).join('')+
    (h.pending_audio||[]).map(i=>`<div class="handoff-item"><b>${dateText(i.recorded_at)} · 语音转写待核对</b><p>这是机器转写，尚未对照原录音，不代表已确认的老人原话；已从交接正文和对话报告中排除。请回到记录页播放原音并核对。</p><button class="outline" onclick="showDetail('${escapeHtml(i.record_id)}')">去核对录音文字</button></div>`).join('')+
    (h.items||[]).filter(i=>!documentNeedsReview(i)).map(i=>`<div class="handoff-item"><b>${dateText(i.recorded_at)} · ${escapeHtml(SOURCE_KIND_LABELS[i.source_kind]||'来源未标明')} · ${stateLabel(i.state)}</b>${i.draft?.summary&&i.draft.summary.trim()!==i.raw_text.trim()?`<p class="handoff-summary"><strong>整理摘要：</strong>${escapeHtml(i.draft.summary)}${i.draft.summary_edited_by==='user'?'<span class="badge">已手动修改</span>':''}</p>`:''}<p class="handoff-original"><strong>${i.source_kind==='document'?'资料文字（需对照原件）：':'原话：'}</strong>${escapeHtml(i.raw_text)}</p>${safetyHtml(i.local_safety)}${i.unresolved?'<span class="badge warn">仍有待处理事项</span>':''}</div>`).join('')+
    (h.media_attachments?.length?'<h3>媒体原件与待处理状态</h3>':'')+(h.media_attachments||[]).map(m=>`<div class="handoff-item handoff-media"><b>${escapeHtml(MEDIA_KIND_LABELS[m.kind]||'媒体原件')}</b><p>${escapeHtml(SAVE_STATUS_LABELS[m.save_status]||'原件保存状态待确认')} · ${escapeHtml(RECOGNITION_LABELS[m.recognition_status]||'识别状态待确认')} · ${escapeHtml(LINK_LABELS[m.link_status]||'关联状态待确认')}${m.is_mock?' · 模拟识别，不是患者原话':''}</p>${m.is_mock?'<p class="status error">该文字不会作为患者事实；真实服务接通后可重试识别。</p>':m.pending_reason==='audio_source_review_required'?'<p>机器转写尚未对照原录音，不是已确认的患者原话，已从交接正文排除；录音原件仍保留。</p>':m.unresolved?'<p>原件与待办仍保留，请完成识别或核对。</p>':''}${m.is_mock?'':safetyHtml(m.local_safety)}</div>`).join('');
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
  if(pendingFollowupTarget&&!followupTargetTurn(activeConversation,pendingFollowupTarget)){setVoiceStatus('引用已变化，不能用于录音追问；原有输入仍保留。','error');return false}
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
  voiceCaptureIntent=null;
  const quoteSnapshot=pendingFollowupTarget?{...pendingFollowupTarget}:null;
  const permissionGeneration=++voicePermissionGeneration,conversationSnapshot=activeConversation?{conversationId:activeConversation.conversation_id,
    conversationVersion:activeConversation.version,conversationStatus:activeConversation.status}:null,
    subjectSnapshot={subjectId:activeHealthSubjectId,subjectVersion:healthSubjectsVersion,epoch:healthSubjectUiEpoch};
  const scopeStillCurrent=()=>activeConversation?.conversation_id===conversationSnapshot?.conversationId
    &&activeConversation?.version===conversationSnapshot?.conversationVersion&&activeConversation?.status===conversationSnapshot?.conversationStatus
    &&activeHealthSubjectId===subjectSnapshot.subjectId&&healthSubjectsVersion===subjectSnapshot.subjectVersion&&healthSubjectUiEpoch===subjectSnapshot.epoch
    &&!healthSubjectSwitchBusy&&!healthSubjectChanged
    &&(quoteSnapshot?pendingFollowupTarget?.conversation_id===quoteSnapshot.conversation_id
      &&pendingFollowupTarget?.subject_id===quoteSnapshot.subject_id&&pendingFollowupTarget?.turn_id===quoteSnapshot.turn_id
      &&pendingFollowupTarget?.version===quoteSnapshot.version&&pendingFollowupTarget?.role===quoteSnapshot.role
      &&pendingFollowupTarget?.text===quoteSnapshot.text&&!pendingFollowupTarget?.invalid:!pendingFollowupTarget);
  let stream,preflightReady=false,tracksClosed=false;
  const closePermissionStream=()=>{if(stream&&!tracksClosed){tracksClosed=true;stream.getTracks().forEach(track=>track.stop())}};
  try{
    const trial=await globalThis.HealthLocal?.trialVoiceState?.();
    if(permissionGeneration!==voicePermissionGeneration||!scopeStillCurrent()||typeof recognitionBusy!=='undefined'&&recognitionBusy.size){
      $('voiceHint').textContent='本次录音准备已取消；麦克风未开启。';setVoiceStatus($('voiceHint').textContent);return;
    }
    if(trial&&trial.state!=='completed'){setVoiceStatus(trialVoiceMessage(trial),trial.state==='stopped'?'error':'ok');return}
    preflightReady=true;$('voiceHint').textContent='请允许使用麦克风，授权后才开始录音';setVoiceStatus('正在请求麦克风权限…');
    stream=await getUserMedia.call(globalThis.navigator.mediaDevices,{audio:true});
    if(permissionGeneration!==voicePermissionGeneration||!scopeStillCurrent()||typeof recognitionBusy!=='undefined'&&recognitionBusy.size){
      closePermissionStream();$('voiceHint').textContent='本次录音已暂停；麦克风已关闭。';setVoiceStatus($('voiceHint').textContent);return;
    }
    cancelPendingMicrophone=closePermissionStream;
    const lateTrial=await globalThis.HealthLocal?.trialVoiceState?.();
    if(permissionGeneration!==voicePermissionGeneration||!scopeStillCurrent()||lateTrial&&lateTrial.state!=='completed'||typeof recognitionBusy!=='undefined'&&recognitionBusy.size){
      closePermissionStream();$('voiceHint').textContent='本次录音已暂停；麦克风已关闭。';setVoiceStatus(lateTrial&&lateTrial.state!=='completed'?trialVoiceMessage(lateTrial):$('voiceHint').textContent,lateTrial?.state==='stopped'?'error':'ok');return;
    }
    const preferred=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type=>typeof Recorder.isTypeSupported==='function'&&Recorder.isTypeSupported(type));
    try{mediaRecorder=preferred?new Recorder(stream,{mimeType:preferred}):new Recorder(stream)}catch{mediaRecorder=new Recorder(stream)}
    const recordingChunks=chunks;
    mediaRecorder.ondataavailable=e=>{if(e.data.size)recordingChunks.push(e.data)};
    mediaRecorder.onstop=closePermissionStream;
    mediaRecorder.onerror=()=>{ $('voiceHint').textContent='录音遇到问题；请结束这一段，系统会尽量保留已录部分';setVoiceStatus('录音遇到问题；请结束这一段，系统会尽量保留已录部分。','error'); };
    cancelPendingMicrophone=null;mediaRecorder.start();voiceCaptureIntent={...conversationSnapshot,...subjectSnapshot,quoteSnapshot,invalidated:false};const autoStop=startSilenceWatch(stream);startedAt=Date.now();timerId=setInterval(updateTimer,1000);$('voiceHint').textContent=autoStop?'正在听，停顿约 3 秒会自动结束':'正在录音；请听完后按“结束这句话”';setVoiceStatus(autoStop?'您慢慢说；停顿约 3 秒会自动保存并回复。':'您慢慢说；听完后按“结束这句话”，录音会自动保存。');
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
$('cancelVoiceFollowupBtn').onclick=clearVoiceFollowupTarget;
$('voiceQuoteShortcuts')?.querySelectorAll('[data-quote-shortcut]').forEach(button=>button.onclick=()=>void sendVoiceQuoteShortcut(button.dataset.quoteShortcut));
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
if($('openConversationDetailBtn'))$('openConversationDetailBtn').onclick=()=>{if(activeConversation?.conversation_id)void showConversationDetail(activeConversation.conversation_id)};
if($('refreshConversationReportBtn'))$('refreshConversationReportBtn').onclick=()=>void refreshConversationReport();
if($('closeConversationReportBtn'))$('closeConversationReportBtn').onclick=closeConversationReport;
if($('conversationReportPanel'))$('conversationReportPanel').addEventListener('keydown',handleConversationReportKeydown);
bindRecordDeleteDialog();
if($('openHealthContextPickerBtn'))$('openHealthContextPickerBtn').onclick=openHealthContextPicker;
if($('closeHealthContextPickerBtn'))$('closeHealthContextPickerBtn').onclick=closeHealthContextPicker;
if($('cancelHealthContextSelectionBtn'))$('cancelHealthContextSelectionBtn').onclick=continueWithoutHealthContextSelection;
if($('saveHealthContextSelectionBtn'))$('saveHealthContextSelectionBtn').onclick=saveHealthContextSelection;
if($('healthContextPickerPanel'))$('healthContextPickerPanel').addEventListener('keydown',handleHealthContextPickerKeydown);
// Keep fixed dialogs outside the bounded, phone-width app shell. This lets
// the report use its desktop reading width without being clipped by the shell.
if(document.body)for(const id of ['healthContextPickerPanel','conversationReportPanel']){const panel=$(id);if(panel&&panel.parentElement!==document.body)document.body.append(panel)}
setVoiceComposerEnabled(true);
async function refreshStorageStatus(){if(!localMode||!$('storageStatus'))return;try{const s=await HealthLocal.storageStatus(),used=(s.usage/1024/1024).toFixed(1),quota=s.quota?`${(s.quota/1024/1024).toFixed(0)} MB`:'未知';$('storageStatus').textContent=`已使用约 ${used} MB / 可用额度 ${quota}。${s.persisted?'浏览器已批准持久存储。':'浏览器尚未批准持久存储，请定期下载备份。'}`}catch{$('storageStatus').textContent='无法读取本机存储额度，请定期下载加密备份。'}}
const HEALTH_CONTEXT_FIELDS={conditions:'healthConditions',medications:'healthMedications',allergies:'healthAllergies',procedures:'healthProcedures',tests:'healthTests',similar_episodes:'healthSimilarEpisodes'};
function healthSubjectLabel(subjectId=activeHealthSubjectId){if(healthSubjectChanged)return '所属人已变化，请重新选择';if(!healthSubjectLoaded)return '尚未确认';return healthSubjects.find(subject=>subject.subject_id===subjectId)?.label||(subjectId==='subject_self'?'本人':'所属人待读取')}
const HEALTH_MEMORY_TEMPORAL_LABELS={current:'目前仍适用',historical:'过去的情况',uncertain:'不确定 · 待核实'};
const HEALTH_MEMORY_SOURCE_LABELS={self_statement:'本人陈述',family_report:'家属转述',document:'已有资料'};
const HEALTH_MEMORY_FORM_FIELDS=['healthMemoryCategory','healthMemoryText','healthMemoryTemporalStatus','healthMemorySourceKind','healthMemoryOccurredOn','healthMemoryConfirmedBy','healthMemoryConfirmed','healthMemoryRemember'];
function updateHealthSubjectLabels(){
  const currentOwner=healthSubjectLabel(activeHealthSubjectId);
  const label=$('voiceSubjectLabel');if(label)label.textContent=`当前记录：${healthSubjectLabel(activeConversation?.subject_id||activeHealthSubjectId)}`;
  const archive=$('archiveSubjectLabel');if(archive)archive.textContent=`当前资料所属人：${currentOwner}`;
  const photo=$('photoSubjectLabel');if(photo)photo.textContent=`当前资料所属人：${currentOwner}`;
}
function renderHealthSubjects(){
  const select=$('healthSubjectSelect');if(select){select.innerHTML=healthSubjects.map(subject=>`<option value="${escapeHtml(subject.subject_id)}">${escapeHtml(subject.label)}${subject.relationship==='family'?'（家属）':''}</option>`).join('');select.value=activeHealthSubjectId;select.disabled=healthMemoryBusy||healthSubjectSwitchBusy}
  updateHealthSubjectLabels();
}
function markHealthSubjectChanged(){
  if(pendingRecordDelete&&!recordDeleteBusy){cancelRecordDelete();toast('所属人已变化；没有删除，请重新打开详情核对。')}
  if(typeof clearVoiceFollowupTarget==='function')clearVoiceFollowupTarget();
  healthSubjectChanged=true;
  if(typeof setMediaCapability==='function')setMediaCapability(null);
  updateHealthSubjectLabels();
  const message='另一页面已切换所属人；本页输入仍保留。请先重新选择当前所属人，再继续保存或对话。';
  if($('healthSubjectStatus'))$('healthSubjectStatus').textContent=message;
  const notice=$('healthSubjectConflictNotice');if(notice){notice.textContent=message;notice.classList.remove('hidden')}
  $('reselectHealthSubjectBtn')?.classList.remove('hidden');
  healthMemoryStatus(message,'error');setVoiceComposerEnabled(false);setHealthMemoryBusy(healthMemoryBusy);
}
function clearHealthSubjectChangedNotice(){
  healthSubjectChanged=false;$('healthSubjectConflictNotice')?.classList.add('hidden');$('reselectHealthSubjectBtn')?.classList.add('hidden');
}
async function loadHealthSubjects(){
  if(!localMode)return false;
  if(healthSubjectsLoadPromise)return healthSubjectsLoadPromise;
  const epoch=healthSubjectUiEpoch,requestId=++healthSubjectsRequestId;
  const request=(async()=>{
    const x=await api('/api/health-subjects');if(requestId!==healthSubjectsRequestId||epoch!==healthSubjectUiEpoch)return false;
    if(!x.r.ok){if(['subject_changed','subject_mismatch'].includes(x.j.error))markHealthSubjectChanged();if($('healthSubjectStatus'))$('healthSubjectStatus').textContent='所属人暂时无法读取；请重试。';return false}
    const actual=x.j.active_subject_id||'subject_self',observed=x.j.observed_subject_id;
    const previousVersion=healthSubjectsVersion;
    healthSubjects=Array.isArray(x.j.subjects)?x.j.subjects:[];healthSubjectsVersion=x.j.version;
    if(healthSubjectLoaded&&(actual!==activeHealthSubjectId||observed&&observed!==activeHealthSubjectId)){markHealthSubjectChanged();renderHealthSubjects();return false}
    if(!healthSubjectLoaded){const unsaved=$('healthMemoryText')?.value.trim()||$('voiceTextInput')?.value.trim();healthSubjectLoaded=true;if(unsaved&&actual!==activeHealthSubjectId){markHealthSubjectChanged();renderHealthSubjects();return false}activeHealthSubjectId=observed||actual;if(activeHealthSubjectId!==actual){markHealthSubjectChanged();renderHealthSubjects();return false}}
    else if(previousVersion!==healthSubjectsVersion&&typeof setMediaCapability==='function')setMediaCapability(null);
    renderHealthSubjects();return true;
  })();
  healthSubjectsLoadPromise=request;
  try{return await request}
  finally{if(healthSubjectsLoadPromise===request)healthSubjectsLoadPromise=null}
}
async function ensureHealthSubjectReady(){
  if(!localMode)return true;
  if(healthSubjectChanged||healthSubjectSwitchBusy)return false;
  if(!healthSubjectLoaded&&!await loadHealthSubjects())return false;
  return healthSubjectLoaded&&!healthSubjectChanged&&!healthSubjectSwitchBusy;
}
function healthMemoryFormEntry(){
  const confirmed=$('healthMemoryConfirmed')?.checked===true,temporal=$('healthMemoryTemporalStatus')?.value||'uncertain';
  return {category:$('healthMemoryCategory')?.value||'conditions',text:$('healthMemoryText')?.value||'',temporal_status:temporal,source_kind:$('healthMemorySourceKind')?.value||'self_statement',occurred_on:$('healthMemoryOccurredOn')?.value||null,confirmation_status:confirmed?'confirmed':'unconfirmed',confirmed_by:$('healthMemoryConfirmedBy')?.value||'self',remember:$('healthMemoryRemember')?.checked===true&&confirmed&&['current','historical'].includes(temporal)};
}
function updateHealthMemoryRememberEligibility(){
  const remember=$('healthMemoryRemember');if(!remember)return;
  const allowed=$('healthMemoryConfirmed')?.checked===true&&['current','historical'].includes($('healthMemoryTemporalStatus')?.value);
  remember.disabled=healthMemoryBusy||!allowed;if(!allowed)remember.checked=false;
}
function resetHealthMemoryForm(){
  healthMemoryEditingId=null;
  const defaults={healthMemoryCategory:'conditions',healthMemoryText:'',healthMemoryTemporalStatus:'uncertain',healthMemorySourceKind:'self_statement',healthMemoryOccurredOn:'',healthMemoryConfirmedBy:'self'};
  for(const [id,value] of Object.entries(defaults))if($(id))$(id).value=value;
  for(const id of ['healthMemoryConfirmed','healthMemoryRemember'])if($(id))$(id).checked=false;
  if($('healthMemoryFormTitle'))$('healthMemoryFormTitle').textContent='添加一项健康背景';
  if($('saveHealthMemoryBtn'))$('saveHealthMemoryBtn').textContent='保存这一项';
  updateHealthMemoryRememberEligibility();
}
function healthMemoryStatus(message,tone=''){
  const status=$('healthMemoryStatus');if(status){status.textContent=message;status.className='status align-left'+(tone?' '+tone:'')}
}
function invalidateHealthMemoryRead(){
  healthMemoryEntries=[];healthMemoryVersion=0;healthContextEntries=[];contextDraftSelection.clear();
  const list=$('healthMemoryList');if(list)list.innerHTML='<p class="muted">健康背景暂时无法读取；请重新打开设置读取。</p>';
  healthMemoryStatus('健康背景暂时无法读取；请重新打开设置读取。','error');
}
function setHealthMemoryBusy(busy){
  healthMemoryBusy=busy;
  for(const id of ['saveHealthMemoryBtn','cancelHealthMemoryEditBtn','addHealthSubjectBtn','healthSubjectSelect'])if($(id))$(id).disabled=busy||healthSubjectSwitchBusy||healthSubjectChanged&&['saveHealthMemoryBtn','addHealthSubjectBtn'].includes(id);
  if($('reselectHealthSubjectBtn'))$('reselectHealthSubjectBtn').disabled=busy||healthSubjectSwitchBusy;
  $('healthMemoryList')?.querySelectorAll('button').forEach(button=>button.disabled=busy||healthSubjectSwitchBusy||healthSubjectChanged||button.dataset.memoryIneligible==='true');
  updateHealthMemoryRememberEligibility();
}
function renderHealthMemory(){
  const list=$('healthMemoryList');if(!list)return;
  if(!healthMemoryEntries.length){list.innerHTML=`<p class="muted">${escapeHtml(healthSubjectLabel())}还没有保存健康背景；可以先空着。</p>`;return}
  list.innerHTML=healthMemoryEntries.map(entry=>{
    const id=escapeHtml(entry.context_id),confirmed=entry.confirmation_status==='confirmed',eligible=confirmed&&['current','historical'].includes(entry.temporal_status),temporal=HEALTH_MEMORY_TEMPORAL_LABELS[entry.temporal_status]||'时间状态未核对';
    const category=entry.category==='medications'?'药物使用记录':HEALTH_CONTEXT_CATEGORY_LABELS[entry.category]||'健康背景';
    const recorded=entry.recorded_at?dateText(entry.recorded_at):'未知',updated=entry.updated_at?dateText(entry.updated_at):'未知',confirmedAt=entry.confirmed_at?dateText(entry.confirmed_at):'未确认';
    return `<article class="health-memory-item" data-health-memory-id="${id}"><div class="badges"><span class="badge">${escapeHtml(category)}</span><span class="badge${confirmed?'':' warn'}">${confirmed?'原文已核对':'尚未核对'}</span><span class="badge">${escapeHtml(temporal)}</span>${entry.remember?'<span class="badge">以后对话记住</span>':''}</div><p class="health-memory-text">${escapeHtml(entry.text||'')}</p><dl class="health-memory-provenance"><div><dt>所属人</dt><dd>${escapeHtml(healthSubjectLabel(entry.subject_id||activeHealthSubjectId))}</dd></div><div><dt>原文来源</dt><dd>${escapeHtml(HEALTH_MEMORY_SOURCE_LABELS[entry.source_kind]||'来源未核对')}</dd></div><div><dt>记录时间</dt><dd>${escapeHtml(recorded)}</dd></div><div><dt>更新时间</dt><dd>${escapeHtml(updated)}</dd></div><div><dt>情况日期</dt><dd>${escapeHtml(entry.occurred_on||'未填写')}</dd></div><div><dt>核对人 / 时间</dt><dd>${confirmed?escapeHtml((entry.confirmed_by==='family'?'家属':'本人')+' / '+confirmedAt):'未确认'}</dd></div></dl><div class="health-memory-actions"><button class="outline" type="button" data-health-memory-edit="${id}">更正</button><button class="outline" type="button" data-health-memory-remember="${id}"${eligible?'':' disabled data-memory-ineligible="true"'}>${entry.remember?'停止自动记住':'以后记住'}</button><button class="outline" type="button" data-health-memory-revoke="${id}"${confirmed?'':' disabled data-memory-ineligible="true"'}>取消记忆与确认</button><button class="danger-button" type="button" data-health-memory-delete="${id}">删除</button></div></article>`;
  }).join('');
  list.querySelectorAll('[data-health-memory-edit]').forEach(button=>button.onclick=()=>editHealthMemoryEntry(button.dataset.healthMemoryEdit));
  for(const action of ['remember','revoke','delete'])list.querySelectorAll(`[data-health-memory-${action}]`).forEach(button=>button.onclick=()=>void mutateHealthMemoryEntry(button.dataset[`healthMemory${action[0].toUpperCase()+action.slice(1)}`],action));
  setHealthMemoryBusy(healthMemoryBusy);
}
async function loadHealthMemory({preserveStatus=false}={}){
  if(!localMode||!$('healthMemoryList'))return false;
  if(!preserveStatus)healthMemoryStatus('正在读取本机长期记忆…');
  const epoch=healthSubjectUiEpoch;
  try{
    if(!await loadHealthSubjects()){if(epoch===healthSubjectUiEpoch)invalidateHealthMemoryRead();return false}
    const x=await api('/api/health-memory');if(epoch!==healthSubjectUiEpoch)return false;
    if(!x.r.ok||x.j.health_context?.subject_id&&x.j.health_context.subject_id!==activeHealthSubjectId){invalidateHealthMemoryRead();return false}
    healthMemoryEntries=Array.isArray(x.j.health_context?.entries)?x.j.health_context.entries:[];healthMemoryVersion=x.j.health_context?.version;
    renderHealthMemory();if(await loadHealthContext()===false){invalidateHealthMemoryRead();return false}
    if(!preserveStatus)healthMemoryStatus(`当前为${healthSubjectLabel()}保存 ${healthMemoryEntries.length} 项背景，${healthMemoryEntries.filter(entry=>entry.remember).length} 项将在新对话沿用。`);
    return true;
  }catch{if(epoch===healthSubjectUiEpoch)invalidateHealthMemoryRead();return false}
}
function editHealthMemoryEntry(contextId){
  if(healthMemoryBusy)return false;
  const entry=healthMemoryEntries.find(item=>item.context_id===contextId);if(!entry)return false;
  healthMemoryEditingId=contextId;
  const values={healthMemoryCategory:entry.category,healthMemoryText:entry.text,healthMemoryTemporalStatus:entry.temporal_status||'uncertain',healthMemorySourceKind:entry.source_kind||'self_statement',healthMemoryOccurredOn:entry.occurred_on||'',healthMemoryConfirmedBy:entry.confirmed_by||'self'};
  for(const [id,value] of Object.entries(values))if($(id))$(id).value=value;
  // A correction needs a fresh, explicit confirmation of the changed wording.
  if($('healthMemoryConfirmed'))$('healthMemoryConfirmed').checked=false;if($('healthMemoryRemember'))$('healthMemoryRemember').checked=false;
  if($('healthMemoryFormTitle'))$('healthMemoryFormTitle').textContent='更正这项健康背景';if($('saveHealthMemoryBtn'))$('saveHealthMemoryBtn').textContent='保存更正';
  updateHealthMemoryRememberEligibility();$('healthMemoryText')?.focus?.();return true;
}
function healthMemoryFailureMessage(error){
  if(error==='subject_changed'||error==='subject_mismatch')return '另一页面已切换所属人；这次没有保存，输入仍保留。请重新选择当前所属人后再继续。';
  if(error==='stale_health_memory'||error==='stale_health_subjects')return '资料已在另一页面更新，已重新读取；你正在填写的内容仍保留，请核对后重试。';
  if(error==='health_memory_remember_limit')return '保存没有完成：最多记住 5 项，请先取消一项自动记忆。输入仍保留。';
  if(error==='health_memory_remember_invalid')return '只有已核对且时间状态明确的资料才能记住。输入仍保留。';
  if(error==='local_operations_busy')return '还有记录正在保存或识别，请等完成后重试。';
  return '保存没有完成；请检查原文、日期和状态，输入仍保留，可以重试。';
}
async function refreshConversationAfterHealthMemoryChange(){
  clearRecordPanels();closeConversationReport();contextPickerRequestId++;healthContextEntries=[];contextDraftSelection.clear();closeHealthContextPicker();
  let refreshed=true;
  if(activeConversation?.conversation_id){
    const id=activeConversation.conversation_id,epoch=healthSubjectUiEpoch;
    // Remove cached analysis immediately, then fetch the store's rebuilt report.
    activeConversation=null;renderConversationReport();updateHealthContextButton();setVoiceComposerEnabled(false);
    const x=await api(`/api/conversations/${encodeURIComponent(id)}`);if(epoch!==healthSubjectUiEpoch)return false;
    if(x.r.ok&&x.j.conversation)syncConversation(x.j.conversation,{speak:false});else{refreshed=false;renderVoiceConversation();setVoiceStatus('背景已更新；当前对话暂时无法读取，请重新进入。','error')}
  }
  return await loadEvents()!==false&&refreshed;
}
async function saveHealthMemory(event){
  event?.preventDefault();if(healthMemoryBusy||healthSubjectSwitchBusy)return false;
  if(healthSubjectChanged){markHealthSubjectChanged();return false}
  const entry=healthMemoryFormEntry();if(!entry.text.trim()){healthMemoryStatus('请先填写要保留的原文。','error');$('healthMemoryText')?.focus?.();return false}
  if(entry.occurred_on&&entry.occurred_on>new Date().toISOString().slice(0,10)){healthMemoryStatus('情况日期不能晚于今天；输入仍保留，请更正日期。','error');$('healthMemoryOccurredOn')?.focus?.();return false}
  const editingId=healthMemoryEditingId,epoch=healthSubjectUiEpoch;
  setHealthMemoryBusy(true);healthMemoryStatus('正在加密保存这一项…');
  let writeCommitted=false;
  try{
    const path=editingId?`/api/health-memory/${encodeURIComponent(editingId)}`:'/api/health-memory';
    const x=await api(path,{method:editingId?'PATCH':'POST',body:JSON.stringify({subject_id:activeHealthSubjectId,expected_subject_version:healthSubjectsVersion,expected_version:healthMemoryVersion,entry})});if(epoch!==healthSubjectUiEpoch)return false;
    if(!x.r.ok){if(['subject_changed','subject_mismatch'].includes(x.j.error)){markHealthSubjectChanged();await loadHealthSubjects()}else if(x.r.status===409)await loadHealthMemory({preserveStatus:true});healthMemoryStatus(healthMemoryFailureMessage(x.j.error),'error');return false}
    writeCommitted=true;resetHealthMemoryForm();
    let memoryRead=false,viewsRead=false;
    memoryRead=await loadHealthMemory({preserveStatus:true});
    try{viewsRead=await refreshConversationAfterHealthMemoryChange()}catch{viewsRead=false}
    if(!memoryRead||!viewsRead){healthMemoryStatus('已保存；最新资料暂时无法确认，请重新打开设置读取。','error');return true}
    healthMemoryStatus('已保存；新对话按最新记忆使用，当前报告也已更新。');return true;
  }catch{healthMemoryStatus(writeCommitted?'已保存；最新资料暂时无法确认，请重新打开设置读取。':'保存没有完成；输入仍保留，可以重试。','error');return writeCommitted}
  finally{setHealthMemoryBusy(false)}
}
async function mutateHealthMemoryEntry(contextId,action){
  if(healthMemoryBusy||healthSubjectSwitchBusy)return false;
  if(healthSubjectChanged){markHealthSubjectChanged();return false}
  const entry=healthMemoryEntries.find(item=>item.context_id===contextId);if(!entry)return false;
  if(action==='delete'&&!confirm('删除这项长期背景？以后新对话不会再使用它；既有原始对话仍保留。'))return false;
  const epoch=healthSubjectUiEpoch,changes=action==='revoke'?{confirmation_status:'unconfirmed',remember:false}:{remember:!entry.remember};
  const updated={category:entry.category,text:entry.text,temporal_status:entry.temporal_status||'uncertain',source_kind:entry.source_kind||'self_statement',occurred_on:entry.occurred_on||null,confirmed_by:entry.confirmed_by||'self',confirmation_status:entry.confirmation_status,remember:entry.remember,...changes};
  setHealthMemoryBusy(true);
  let writeCommitted=false;
  try{
    const x=await api(`/api/health-memory/${encodeURIComponent(contextId)}`,{method:action==='delete'?'DELETE':'PATCH',body:JSON.stringify({subject_id:activeHealthSubjectId,expected_subject_version:healthSubjectsVersion,expected_version:healthMemoryVersion,...(action==='delete'?{}:{entry:updated})})});if(epoch!==healthSubjectUiEpoch)return false;
    if(!x.r.ok){if(['subject_changed','subject_mismatch'].includes(x.j.error)){markHealthSubjectChanged();await loadHealthSubjects()}else if(x.r.status===409)await loadHealthMemory({preserveStatus:true});healthMemoryStatus(healthMemoryFailureMessage(x.j.error),'error');return false}
    writeCommitted=true;if(action==='delete'&&healthMemoryEditingId===contextId)resetHealthMemoryForm();
    let memoryRead=false,viewsRead=false;
    memoryRead=await loadHealthMemory({preserveStatus:true});
    try{viewsRead=await refreshConversationAfterHealthMemoryChange()}catch{viewsRead=false}
    if(!memoryRead||!viewsRead){healthMemoryStatus('更改已保存；最新资料暂时无法确认，请重新打开设置读取。','error');return true}
    healthMemoryStatus(action==='delete'?'已删除；以后新对话不再使用这项背景。':action==='revoke'?'已取消确认和记忆；这项背景不会发送给联网 AI。':updated.remember?'以后新对话会带上这项已确认背景。':'已停止自动记住；之后仍可在对话中手动选择。');return true;
  }catch{healthMemoryStatus(writeCommitted?'更改已保存；最新资料暂时无法确认，请重新打开设置读取。':'操作没有完成；原有资料和填写内容仍保留，请重试。','error');return writeCommitted}
  finally{setHealthMemoryBusy(false)}
}
function clearHealthSubjectDisplays({epochAlreadyAdvanced=false}={}){
  if(typeof clearVoiceFollowupTarget==='function')clearVoiceFollowupTarget();
  if(!epochAlreadyAdvanced)healthSubjectUiEpoch++;detailRequestSerial++;contextPickerRequestId++;voicePermissionGeneration++;
  activeConversation=null;current=null;events=[];conversations=[];conversationEditingTurnId=null;pendingConversationTurn=null;pendingMediaRetry=null;pendingAudioReview=null;pendingAudioReviewCandidates=[];pendingAudioRecoveryRequestId++;lastSpokenTurnId=null;
  healthMemoryEntries=[];healthMemoryVersion=0;healthContextEntries=[];contextDraftSelection.clear();handoffSelection.clear();knownHandoffEvents.clear();
  globalThis.speechSynthesis?.cancel?.();closeConversationReport();closeHealthContextPicker();clearRecordPanels();
  if(typeof releaseOriginalsIn==='function')for(const id of ['archivePhotos','photoPreview','voiceConversationTurns'])releaseOriginalsIn($(id));
  if(typeof mediaItems!=='undefined')mediaItems=[];if(typeof selectedPhoto!=='undefined')selectedPhoto=null;if(typeof pendingRecordingBlob!=='undefined')pendingRecordingBlob=null;
  for(const id of ['archivePhotos','photoPreview','homeRecent','eventsList','archiveEvents'])if($(id))$(id).innerHTML='';
  for(const id of ['archiveEventCount','archivePhotoCount'])if($(id))$(id).textContent='0';
  for(const id of ['mediaStatus','photoStatus'])if($(id))$(id).textContent='';
  for(const id of ['voiceTextInput','photoInput','audioUploadInput'])if($(id))$(id).value='';
  $('savePhotoBtn')?.classList.add('hidden');$('photoPreview')?.classList.add('hidden');$('conversationResumeChoice')?.classList.add('hidden');
  resetHealthMemoryForm();renderVoiceConversation();renderConversationReport();updateHealthContextButton();setVoiceComposerEnabled(false);
}
function resetHealthSubjectScope(){
  healthSubjectUiEpoch++;healthSubjectsRequestId++;healthSubjectsLoadPromise=null;
  healthSubjects=[];healthSubjectsVersion=0;activeHealthSubjectId='subject_self';
  healthSubjectLoaded=false;healthSubjectChanged=false;healthSubjectSwitchBusy=false;
}
function handleLocalVaultState(state){
  if(!localMode)return;
  const shell=document.querySelector('.app-shell');
  if(state==='checking'){
    if(shell){shell.style.visibility='hidden';shell.inert=true}
    return;
  }
  if(state==='current'){
    if(shell){shell.style.visibility='';shell.inert=false}
    return;
  }
  if(!['invalidated','unavailable'].includes(state))return;
  if(shell){shell.style.visibility='hidden';shell.inert=true}
  if(state==='invalidated')try{sessionStorage.setItem('bingli-vault-lock-notice','restored')}catch{}
  try{cancelPendingMicrophone?.()}catch{}
  cancelPendingMicrophone=null;
  const recorder=mediaRecorder;
  if(recorder&&recorder.state!=='inactive'){
    try{recorder.ondataavailable=null;recorder.onstop=null;recorder.onerror=null;recorder.stop()}catch{}
    try{recorder.stream?.getTracks?.().forEach(track=>track.stop())}catch{}
  }
  mediaRecorder=null;voicePermissionPending=false;voiceUploadPending=false;
  if(typeof pendingRecordingBlob!=='undefined')pendingRecordingBlob=null;
  clearInterval(timerId);timerId=null;
  HealthLocal.lock();location.reload();
}
globalThis.HealthLocal?.onVaultState?.(handleLocalVaultState);
async function activateHealthSubject(subjectId){
  if(subjectId===activeHealthSubjectId&&!healthSubjectChanged)return true;
  const reselectSame=subjectId===activeHealthSubjectId&&healthSubjectChanged;
  const status=$('healthSubjectStatus'),select=$('healthSubjectSelect');
  const busy=healthMemoryBusy||saveBusy||conversationLoading||mediaRecorder?.state==='recording'||voicePermissionPending||voiceUploadPending||typeof uploadBusy!=='undefined'&&uploadBusy||typeof recognitionBusy!=='undefined'&&recognitionBusy.size;
  if(busy){if(select)select.value=activeHealthSubjectId;if(status)status.textContent='请等当前保存、录音或识别完成，再切换所属人。';return false}
  if(!reselectSame&&($('voiceTextInput')?.value.trim()||$('healthMemoryText')?.value.trim()||typeof selectedPhoto!=='undefined'&&selectedPhoto)){if(select)select.value=activeHealthSubjectId;if(status)status.textContent='还有未保存的输入；请先保存或清空，再切换所属人。';return false}
  const preservedDraft=reselectSame?{editingId:healthMemoryEditingId,fields:HEALTH_MEMORY_FORM_FIELDS.map(id=>({id,value:$(id)?.value,checked:$(id)?.checked})),legacyFields:typeof HEALTH_CONTEXT_FIELDS!=='undefined'?Object.values(HEALTH_CONTEXT_FIELDS).map(id=>({id,value:$(id)?.value})):[],voiceText:$('voiceTextInput')?.value||''}:null;
  healthSubjectsLoadPromise=null;healthSubjectUiEpoch++;pendingAudioRecoveryRequestId++;healthSubjectsRequestId++;healthSubjectSwitchBusy=true;setHealthMemoryBusy(true);setVoiceComposerEnabled(false);if(typeof setMediaCapability==='function')setMediaCapability(null);
  try{
    await pauseConversation();
    const x=await api('/api/health-subjects/active',{method:'POST',body:JSON.stringify({subject_id:subjectId,expected_version:healthSubjectsVersion})});
    if(!x.r.ok){if(select)select.value=activeHealthSubjectId;if(x.r.status===409)await loadHealthSubjects();if(status)status.textContent=healthMemoryFailureMessage(x.j.error);return false}
    clearHealthSubjectDisplays({epochAlreadyAdvanced:true});activeHealthSubjectId=x.j.active_subject_id||subjectId;healthSubjectsVersion=x.j.version||healthSubjectsVersion;healthSubjectLoaded=true;clearHealthSubjectChangedNotice();updateHealthSubjectLabels();
    if(preservedDraft){healthMemoryEditingId=preservedDraft.editingId;for(const field of preservedDraft.fields){const input=$(field.id);if(input){input.value=field.value;input.checked=field.checked}}if($('voiceTextInput'))$('voiceTextInput').value=preservedDraft.voiceText;if(healthMemoryEditingId){$('healthMemoryFormTitle').textContent='更正这项健康背景';$('saveHealthMemoryBtn').textContent='保存更正'}updateHealthMemoryRememberEligibility()}
    await loadHealthMemory();if(preservedDraft)for(const field of preservedDraft.legacyFields)if($(field.id))$(field.id).value=field.value;
  }finally{healthSubjectSwitchBusy=false;setHealthMemoryBusy(false);if(activeConversation)setVoiceComposerEnabled(true);if(!healthSubjectChanged&&typeof loadMediaCapabilities==='function')await loadMediaCapabilities()}
  await loadEvents();if(typeof loadMedia==='function')await loadMedia();if(status)status.textContent=reselectSame?`已重新选择${healthSubjectLabel()}；未保存的输入仍保留，可以继续核对。`:`已切换为${healthSubjectLabel()}；下一段对话将单独记录。`;return true;
}
async function createHealthSubject(){
  if(healthMemoryBusy||healthSubjectSwitchBusy)return false;
  if(healthSubjectChanged){markHealthSubjectChanged();return false}
  const input=$('newHealthSubjectLabel'),status=$('healthSubjectStatus'),label=input?.value.trim();if(!label){if(status)status.textContent='请填写一个家属称呼，不需要身份证号或其他详细资料。';input?.focus?.();return false}
  setHealthMemoryBusy(true);
  try{
    const x=await api('/api/health-subjects',{method:'POST',body:JSON.stringify({label,relationship:'family',expected_version:healthSubjectsVersion})});
    if(!x.r.ok){if(x.r.status===409)await loadHealthSubjects();if(status)status.textContent=healthMemoryFailureMessage(x.j.error);return false}
    input.value='';await loadHealthSubjects();if(status)status.textContent='家属称呼已保存；请在上方选择后为其记录。';return true;
  }finally{setHealthMemoryBusy(false)}
}
async function loadHealthContext(){
  if(!localMode||!$('healthContextStatus'))return;
  const controls=[...Object.values(HEALTH_CONTEXT_FIELDS).map(id=>$(id)),$('saveHealthContextBtn')].filter(Boolean);
  controls.forEach(control=>control.disabled=true);
  const status=$('healthContextStatus');status.textContent='正在读取本机健康背景…';
  try{
    const x=await api('/api/health-context');
    if(!x.r.ok){status.textContent='健康背景暂时无法读取，原有内容不会删除。';return false}
    const entries=x.j.health_context?.entries||[];
    for(const [category,id] of Object.entries(HEALTH_CONTEXT_FIELDS)){const input=$(id);if(input)input.value=entries.filter(item=>item.category===category).map(item=>item.text).join('\n')}
    status.textContent=entries.length?`有 ${entries.length} 项背景可在对话中手动选择。日期和长期记忆请在上方逐项管理。`:'还没有可手动选择的健康背景；可以先空着。';return true;
  }finally{const protectedEntries=typeof healthMemoryEntries!=='undefined'&&healthMemoryEntries.some(entry=>entry.legacy_entry!==true);controls.forEach(control=>control.disabled=protectedEntries);if(protectedEntries)status.textContent='已启用逐项管理；请在上方更正资料，原有入口停止整体替换。';}
}
async function saveHealthContext(){
  const button=$('saveHealthContextBtn'),status=$('healthContextStatus');if(!button||!status)return;
  if(typeof healthSubjectChanged!=='undefined'&&healthSubjectChanged){if(typeof markHealthSubjectChanged==='function')markHealthSubjectChanged();status.textContent='另一页面已切换所属人；输入仍保留，请重新选择后再保存。';return false}
  if(typeof healthMemoryEntries!=='undefined'&&healthMemoryEntries.some(entry=>entry.legacy_entry!==true)){status.textContent='请在上方逐项更正资料，避免整体替换丢失长期记忆。';return false}
  const fields=Object.fromEntries(Object.entries(HEALTH_CONTEXT_FIELDS).map(([category,id])=>[category,$(id)?.value||'']));
  button.disabled=true;button.textContent='保存中…';status.textContent='正在加密保存在本机…';
  const x=await api('/api/health-context',{method:'POST',body:JSON.stringify({fields,...(typeof activeHealthSubjectId!=='undefined'?{subject_id:activeHealthSubjectId,expected_subject_version:healthSubjectsVersion}:{})})});
  button.disabled=false;button.textContent='保存健康背景';
  const error=x.j?.error;
  if(['subject_changed','subject_mismatch'].includes(error)&&typeof markHealthSubjectChanged==='function'){markHealthSubjectChanged();await loadHealthSubjects()}
  status.textContent=x.r.ok?`已加密保存在本机，共 ${x.j.health_context?.entries?.length||0} 项。不会自动发送；每段对话可单独选择。`:['subject_changed','subject_mismatch'].includes(error)?'另一页面已切换所属人；这次没有保存，输入仍保留，请重新选择后继续。':error==='health_context_requires_memory_editor'?'已有逐项管理资料；请使用上方更正入口。输入仍保留。':error==='health_context_too_many'?'保存没有完成：每类最多 12 项，总共最多 30 项；每项最多 500 字。输入仍保留，请删减后重试。':error==='health_context_text_too_long'?'保存没有完成：每项最多 500 字。输入仍保留，请缩短后重试。':'保存没有完成，输入仍保留，可以重试。';
  if(x.r.ok&&$('healthMemoryList')){await loadHealthMemory({preserveStatus:true});await refreshConversationAfterHealthMemoryChange()}
}
function setupBackupRestore(){
  const input=$('restoreBackupInput'),form=$('restoreBackupForm'),passphrase=$('restoreBackupPassphrase'),fileName=$('restoreBackupFileName');
  const previewPanel=$('restoreBackupPreview'),previewSummary=$('restoreBackupPreviewSummary'),inspect=$('restoreBackupInspect');
  const confirmButton=$('restoreBackupConfirm'),cancel=$('restoreBackupCancel'),status=$('backupStatus');
  if(!input||!form||!passphrase||!previewPanel||!confirmButton||!cancel||!status)return;
  let selectedFile=null,preview=null,busy=false;
  const updateControls=()=>{input.disabled=busy;passphrase.disabled=busy;inspect.disabled=busy||!selectedFile;confirmButton.disabled=busy||!preview;cancel.disabled=busy};
  const clearPreview=()=>{preview=null;previewPanel.classList.add('hidden');previewSummary.textContent='';confirmButton.disabled=true};
  const clearFlow=(clearFile=true)=>{clearPreview();passphrase.value='';if(clearFile){selectedFile=null;fileName.textContent='';input.value='';form.classList.add('hidden')}updateControls()};
  const failureText=(error,phase)=>{
    if(['local_operations_busy','vault_restore_in_progress'].includes(error?.message))return '还有记录正在保存、回复或识别，请等完成后再试。当前资料未被替换。';
    if(['vault_changed_requires_unlock','vault_locked'].includes(error?.message))return '这份资料库已在其他页面恢复，请刷新并重新解锁后再操作。';
    return phase==='preview'?'口令不正确或备份无法验证，当前资料未改变。请重新输入口令后再试。':'恢复没有完成，当前资料未被替换。请重新输入口令并检查备份后重试。';
  };
  input.onchange=event=>{
    if(busy)return;
    selectedFile=event.target.files?.[0]||null;input.value='';passphrase.value='';clearPreview();
    form.classList.toggle('hidden',!selectedFile);fileName.textContent=selectedFile?`已选择：${selectedFile.name||'备份文件'}`:'';
    status.textContent=selectedFile?'请输入这份备份的恢复口令，然后检查备份。':'已取消选择，当前资料未改变。';
    updateControls();
  };
  passphrase.oninput=()=>{
    if(!preview)return;
    clearPreview();status.textContent='恢复口令已修改，请重新检查备份信息。';updateControls();
  };
  cancel.onclick=()=>{if(busy)return;clearFlow();status.textContent='已取消恢复，当前资料未改变。'};
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!selectedFile)return false;
    const file=selectedFile,phrase=passphrase.value;
    if(!phrase.trim()){status.textContent='请先输入这份备份的恢复口令。';passphrase.focus();return false}
    busy=true;updateControls();status.textContent='正在本机检查备份…';
    try{
      const checked=await HealthLocal.previewBackup(file,phrase);
      if(selectedFile!==file||passphrase.value!==phrase)return false;
      if(!checked?.archive||!Number.isSafeInteger(checked.eventCount)||checked.eventCount<0
        ||!Number.isSafeInteger(checked.mediaCount)||checked.mediaCount<0)throw new Error('invalid_backup');
      preview=checked;
      const exported=Number.isFinite(Date.parse(checked.exportedAt||''))
        ?new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(checked.exportedAt)):'未知';
      previewSummary.textContent=`${checked.eventCount} 条记录 · ${checked.mediaCount} 份原件 · 导出时间：${exported}。确认后才会替换当前设备资料。`;
      previewPanel.classList.remove('hidden');status.textContent='备份已通过本机检查。请核对文件名和内容，再决定是否确认恢复。';
    }catch(error){clearPreview();passphrase.value='';status.textContent=failureText(error,'preview')}
    finally{busy=false;updateControls()}
    return false;
  };
  confirmButton.onclick=async()=>{
    if(busy||!selectedFile||!preview)return false;
    const file=selectedFile,checked=preview,phrase=passphrase.value;
    if(!phrase.trim()){clearPreview();status.textContent='请重新输入恢复口令并检查备份。';updateControls();return false}
    busy=true;updateControls();status.textContent='正在安全恢复本机资料…';
    try{await HealthLocal.restoreBackup(checked,phrase)}
    catch(error){clearPreview();passphrase.value='';status.textContent=failureText(error,'restore');busy=false;updateControls();return false}
    if(selectedFile!==file||preview!==checked){busy=false;updateControls();return false}
    clearFlow();if(typeof clearHealthSubjectDisplays==='function')clearHealthSubjectDisplays();resetHealthSubjectScope();
    status.textContent='恢复完成，正在重新读取记录。';
    let memoryRead=false,eventsRead=false;
    try{
      try{memoryRead=typeof loadHealthMemory==='function'?await loadHealthMemory():true}catch{}
      try{eventsRead=await loadEvents()!==false}catch{}
      status.textContent=memoryRead&&eventsRead?'备份恢复完成，记录已重新读取。':'备份已恢复，但最新列表暂时无法确认；请重新打开设置读取。';
    }
    finally{busy=false;updateControls()}
    return true;
  };
  updateControls();
}
if($('downloadBackupBtn'))$('downloadBackupBtn').onclick=async()=>{const s=$('backupStatus');try{await HealthLocal.downloadBackup();s.textContent='加密备份已生成，请确认浏览器的下载位置。'}catch{s.textContent='备份生成失败，本机数据未改变。'}};
setupBackupRestore();
if($('lockVaultBtn'))$('lockVaultBtn').onclick=()=>{HealthLocal.lock();location.reload()};
if($('saveFeedbackBtn'))$('saveFeedbackBtn').onclick=async()=>{const text=$('feedbackText').value,s=$('feedbackStatus');try{await HealthLocal.saveFeedback(text,document.querySelector('.view.active')?.id);$('feedbackText').value='';s.textContent='内测问题已加密保存在本机，未附带健康原文。'}catch{s.textContent='请先写下问题描述（不要粘贴密钥）。'}};
if($('saveHealthContextBtn'))$('saveHealthContextBtn').onclick=saveHealthContext;
if($('healthMemoryForm'))$('healthMemoryForm').onsubmit=saveHealthMemory;
if($('cancelHealthMemoryEditBtn'))$('cancelHealthMemoryEditBtn').onclick=resetHealthMemoryForm;
for(const id of ['healthMemoryConfirmed','healthMemoryTemporalStatus'])if($(id))$(id).onchange=updateHealthMemoryRememberEligibility;
if($('healthSubjectSelect'))$('healthSubjectSelect').onchange=event=>void activateHealthSubject(event.target.value);
if($('addHealthSubjectBtn'))$('addHealthSubjectBtn').onclick=createHealthSubject;
if($('reselectHealthSubjectBtn'))$('reselectHealthSubjectBtn').onclick=async()=>{await loadHealthSubjects();await activateHealthSubject(activeHealthSubjectId)};
if($('healthMemoryOccurredOn'))$('healthMemoryOccurredOn').max=new Date().toISOString().slice(0,10);
const today=$('todayLabel');if(today)today.textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
health().then(async ready=>{if(!ready&&localMode)return;if(localMode&&!await loadHealthSubjects())return;await loadEvents()}).catch(()=>{if(localMode){localStartupFailed=true;setModeLabel()}});
if(typeof navigator!=='undefined'&&'serviceWorker'in navigator&&['https:','http:'].includes(location.protocol))navigator.serviceWorker.register('/service-worker.js?build=v171-media-original-delete-20261023',{updateViaCache:'none'}).then(registration=>registration.update()).catch(()=>{});
