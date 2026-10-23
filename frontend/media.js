// Saved-media upload and recognition. Recording pause is manual; no fake VAD.
let mediaItems=[], mediaEventsForDisplay=null, uploadBusy=false, selectedPhoto=null, pendingRecordingBlob=null, pendingRecordingIntent=null, mediaCapabilities=null, mediaOnlineStatusRequestId=0, mediaCapabilitiesRequestId=0, mediaLoadRequestId=0;
const localMediaJobs=new Map();
const recognitionBusy=new Set();
const originalUrls=new Map();
const originalTargets=new Map();
const mediaStatus=$('mediaStatus');
async function readBlobBytes(source){
  if(typeof FileReader!=='undefined'){
    try{return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error||new Error('media_read_failed'));reader.readAsArrayBuffer(source)})}catch{}
  }
  if(typeof source?.arrayBuffer==='function')return source.arrayBuffer();
  throw new Error('media_read_failed');
}
async function retainSelectedFile(source){
  try{
    const bytes=await readBlobBytes(source);
    // Reports saved by messaging apps may keep a .jpg name around PNG bytes.
    // Preserve the bytes; the server still validates the actual format.
    const head=String.fromCharCode(...new Uint8Array(bytes).subarray(0,12));
    const type=head.startsWith('\x89PNG\r\n\x1a\n')?'image/png':head.startsWith('\xff\xd8\xff')?'image/jpeg':/^GIF8[79]a/.test(head)?'image/gif':head.startsWith('RIFF')&&head.slice(8)==='WEBP'?'image/webp':head.startsWith('II*\x00')||head.startsWith('MM\x00*')?'image/tiff':source.type;
    const copy=new Blob([bytes],{type});
    Object.defineProperty(copy,'name',{value:source.name||'media-original',enumerable:true});
    Object.defineProperty(copy,'lastModified',{value:source.lastModified||Date.now(),enumerable:true});
    return copy;
  }catch{throw new Error('media_read_failed')}
}
const MEDIA_SAVE_LABELS={uploading:'原件上传中，尚未保存完整',saved:'原件已保存',failed:'原件保存失败'};
const MEDIA_RECOGNITION_LABELS={not_started:'待识别',processing:'识别处理中',succeeded:'文字已识别，待核对',failed:'识别失败',interrupted:'识别中断'};
const MEDIA_LINK_LABELS={not_linked:'尚未关联记录',pending:'关联处理中',linked:'已关联记录',link_failed:'关联失败'};
const AUDIO_REVIEW_LABELS={reviewed:'当前录音文字已核对（非医学确认）',pending:'当前文字待核对',unknown:'状态暂不可确认'};
const isMockMedia=m=>m?.is_mock===true||m?.recognition?.is_mock===true||/^\s*\[Mock (?:ASR|OCR)\]/i.test(String(m?.recognition?.text||m?.text||''));
const mediaLabel=m=>`${m.kind==='audio'?'录音':'照片'} · ${MEDIA_SAVE_LABELS[m.save_status]||'原件保存状态待确认'} · ${isMockMedia(m)?'模拟识别结果（非患者原话）':m.kind==='audio'&&m.recognition_status==='succeeded'?'文字已识别':MEDIA_RECOGNITION_LABELS[m.recognition_status]||'识别状态待确认'} · ${MEDIA_LINK_LABELS[m.link_status]||'关联状态待确认'}`;
function audioReviewDisplay(media,events){
  const unknown={state:'unknown',event:null,originalIsHistorical:false};
  if(media?.kind!=='audio'||!Array.isArray(events)||media.recognition_status!=='succeeded'||isMockMedia(media))return unknown;
  if(events.some(event=>!event||typeof event!=='object'||typeof event.record_id!=='string'))return unknown;
  const rootId=media.event_link?.record_id||media.record_id,owner=media.subject_id||'subject_self';
  if(!rootId||typeof globalThis.HealthSafety?.currentAudioSource!=='function'||typeof globalThis.HealthSafety?.audioNeedsReview!=='function')return unknown;
  if(typeof activeHealthSubjectId==='string'&&activeHealthSubjectId&&activeHealthSubjectId!==owner)return unknown;
  const owned=events.filter(event=>(event?.subject_id||'subject_self')===owner);
  if(new Set(owned.map(event=>event.record_id)).size!==owned.length)return unknown;
  const rootMatches=owned.filter(event=>event?.record_id===rootId);
  if(rootMatches.length!==1)return unknown;
  const current=globalThis.HealthSafety.currentAudioSource(media,events);
  const currentIsMock=typeof isMockContent==='function'?isMockContent(current):current?.is_mock===true||/^\s*\[Mock (?:ASR|OCR)\]/i.test(String(current?.raw_text||''));
  if(!current||current.source_kind!=='audio_transcript'||current.state==='superseded'||currentIsMock
    ||typeof current.raw_text!=='string'||!current.raw_text.trim())return unknown;
  let cursor=rootMatches[0];const seen=new Set();
  while(cursor&&cursor.record_id!==current.record_id){
    if(seen.has(cursor.record_id))return unknown;
    seen.add(cursor.record_id);
    const foreignChildren=events.filter(event=>event?.supersedes_id===cursor.record_id&&(event.subject_id||'subject_self')!==owner);
    const children=owned.filter(event=>event?.supersedes_id===cursor.record_id);
    if(foreignChildren.length||children.length!==1||cursor.state!=='superseded')return unknown;
    cursor=children[0];
  }
  if(cursor?.record_id!==current.record_id)return unknown;
  if(events.some(event=>event?.supersedes_id===current.record_id&&(event.subject_id||'subject_self')!==owner))return unknown;
  const needsReview=globalThis.HealthSafety.audioNeedsReview(current);
  if(typeof needsReview!=='boolean')return unknown;
  const receipt=current.source_review;
  if(needsReview===false&&!(receipt?.method==='original_comparison'&&receipt.record_id===current.record_id
    &&receipt.confirmed_at&&receipt.text===current.raw_text))return unknown;
  const recognized=String(media.recognition?.text||'').trim();
  return {state:needsReview?'pending':'reviewed',event:current,originalIsHistorical:Boolean(recognized&&recognized!==current.raw_text)};
}
async function readAudioEvents(){
  try{const {r,j}=await api('/api/events');return r.ok&&Array.isArray(j.events)?j.events:null;}catch{return null;}
}
function mediaMessage(text,kind=null){mediaStatus.textContent=text;if(kind==='image'){const photo=$('photoStatus');if(photo)photo.textContent=text;}}
function formatMediaUploadLimit(bytes){
  const value=Number(bytes);
  if(!Number.isFinite(value)||value<=0)return '当前上传限制';
  const unit=value>=1024*1024?1024*1024:value>=1024?1024:1;
  const label=unit===1024*1024?'MB':unit===1024?'KB':'字节';
  if(unit===1)return `${Math.floor(value)} ${label}`;
  const hundredths=Math.floor(value/unit*100);
  const fraction=String(hundredths%100).padStart(2,'0').replace(/0+$/,'');
  return `${Math.floor(hundredths/100)}${fraction?'.'+fraction:''} ${label}`;
}
function readableMediaError(value,fallback='媒体操作未完成，请保留原件并重试'){
  return typeof value==='string'&&/[\u3400-\u9fff]/.test(value)?value:fallback;
}
function unusableAudioMessage(m){
  const code=m?.recognition?.error?.code||m?.recognition?.error?.error||m?.error;
  if(m?.kind!=='audio')return '';
  if(code==='invalid_media')return '录音文件无法读取，请重新选有效录音，原件保留。';
  if(code==='no_text_detected')return '这段录音没有可识别的声音，请重新录音；原件仍保存在本机。';
  return '';
}
function mediaRetryable(m){
  if(m?.trial_control)return false;
  // The API puts retryability on the current attempt's error.  Accept the
  // compatibility locations too, but never infer that a terminal failure is
  // retryable merely because it has a failed status.
  if(m?.recognition_status==='interrupted')return m.recognition?.retryable!==false;
  if(m?.recognition_status!=='failed')return false;
  if(m.recognition?.manual_retry_after_authorization===true&&['trial_authorization_required','trial_budget_exhausted'].includes(m.recognition?.error?.code))return true;
  return m.recognition?.retryable===true||m.recognition?.error?.retryable===true||m.retryable===true;
}
function trialRetryMessage(m){
  if(m?.trial_control)return m.trial_control.state==='stopped'?'本次语音试验已停止；原件和已识别文字保留，等待明确处理安排。':'本次语音试验已暂停核对；原件和已识别文字保留。';
  const code=m?.recognition?.error?.code;
  return code==='trial_budget_exhausted'?'本次试验额度已用尽；原件已保留，需要新的预算授权后才能手动重试。':code==='trial_authorization_required'?'试验尚未获预算授权；原件已保留，获得授权后可手动重试。':'';
}
function capabilityMessage(c){
  if(c?.enabled===true)return '';
  if(c?.disabled_reason==='media_limits_not_configured')return '当前实例未配置媒体资源保护边界，媒体上传暂不可用。';
  return '媒体上传能力暂不可用，请检查服务配置后刷新。';
}
function mediaRecognitionLabel(capability){
  if(typeof capabilityStatusText==='function')return capabilityStatusText(capability);
  if(['provider_mock','provider_not_configured','provider_configuration_missing_or_invalid','provider_configuration_invalid','media_configuration_invalid'].includes(capability?.reason))return '尚未接通';
  return capability?.available?'已配置，连接待验证':'暂不可用';
}
async function refreshMediaOnlineStatus(){
  const photo=$('photoRecognitionStatus'),archive=$('mediaRecognitionStatus');if(!photo&&!archive)return;
  const requestId=++mediaOnlineStatusRequestId;
  try{
    if(typeof globalThis.HealthLocal?.onlineStatus!=='function')throw new Error('online_status_unavailable');
    const status=await globalThis.HealthLocal.onlineStatus();if(requestId!==mediaOnlineStatusRequestId)return;
    const image=status?.image_recognition,audio=status?.audio_recognition;
    const imageLabel=mediaRecognitionLabel(image),audioLabel=mediaRecognitionLabel(audio);
    photo&&(photo.textContent=imageLabel==='尚未接通'?`图片识别尚未接通；图片原件仍可保存在本机。`:image?.available?`图片识别已配置，连接待验证；保存后会尝试识别，原件先保存在本机。`:`图片识别${imageLabel}；不影响原件在本机保存，服务恢复后可重试。`);
    archive&&(archive.textContent=`图片识别${imageLabel}；语音转文字${audioLabel}。识别失败不会删除已保存的原件。`);
  }catch{
    if(requestId!==mediaOnlineStatusRequestId)return;
    photo&&(photo.textContent='照片识别状态暂时无法确认；请以上方原件保存状态为准。');
    archive&&(archive.textContent='联网识别状态暂时无法确认；原件是否保存以上方状态为准。');
  }
}
function setMediaCapability(c){
  mediaCapabilities=c||null;
  const disabled=!c||c.enabled!==true;
  const status=$('mediaCapabilityStatus');if(status){status.textContent=capabilityMessage(c);status.classList.toggle('error',disabled);}
  const photoStatus=$('photoCapabilityStatus');if(photoStatus){photoStatus.textContent=capabilityMessage(c);photoStatus.classList.toggle('error',disabled);}
  for(const id of ['photoInput','audioUploadInput','savePhotoBtn']){
    const el=$(id);if(el)el.disabled=disabled;
  }
  for(const id of ['photoUploadLabel','audioUploadLabel']){
    const el=$(id);if(!el)continue;
    el.disabled=disabled;
    el.setAttribute?.('aria-disabled',String(disabled));
    el.classList.toggle('media-disabled',disabled);
  }
  document.querySelectorAll('[data-media-entry]').forEach(el=>{
    el.classList.toggle('media-unavailable',disabled);
  });
  if(disabled){
    selectedPhoto=null;
    $('photoPreview')?.classList.add('hidden');
    $('savePhotoBtn')?.classList.add('hidden');
  }
  return !disabled;
}
async function loadMediaCapabilities(){
  const requestId=++mediaCapabilitiesRequestId,isCurrent=()=>requestId===mediaCapabilitiesRequestId;
  try{
    if(localMode&&(healthSubjectSwitchBusy||healthSubjectChanged)){
      if(isCurrent())setMediaCapability(null);
      return false;
    }
    if(localMode&&typeof loadHealthSubjects==='function'&&!await loadHealthSubjects()){
      if(isCurrent())setMediaCapability(null);
      return false;
    }
    const scope=localMode?{epoch:healthSubjectUiEpoch,subjectId:activeHealthSubjectId,version:healthSubjectsVersion}:null;
    if(localMode&&(!healthSubjectLoaded||healthSubjectSwitchBusy||healthSubjectChanged)){
      if(isCurrent())setMediaCapability(null);
      return false;
    }
    const {r,j}=await api('/api/media/capabilities');
    if(!isCurrent())return false;
    if(scope&&(scope.epoch!==healthSubjectUiEpoch||scope.subjectId!==activeHealthSubjectId||scope.version!==healthSubjectsVersion||healthSubjectSwitchBusy||healthSubjectChanged)){
      if(!healthSubjectSwitchBusy&&!healthSubjectChanged)setMediaCapability(null);
      return false;
    }
    if(!r.ok||!j.capabilities){
      setMediaCapability(null);
      return false;
    }
    return setMediaCapability(j.capabilities);
  }catch{
    // Capability discovery is advisory for an already rendered archive. A
    // transient read failure must not create an unhandled rejection; upload
    // still performs a mandatory, authoritative capability check.
    if(isCurrent())setMediaCapability(null);
    return false;
  }
}
async function mediaRequest(path,opt){
  const x=await api(path,opt);
  if(!x.r.ok){
    const errorMessages={trial_stopped:'这次语音处理已停止；录音原件仍在本机，不会自动重发。',trial_review_required:'这段录音仍在待核对状态；原件已保留，请先处理核对停点。',trial_authorization_required:'没有匹配到这段录音的当前单次识别授权；原件已保留，不会自动重试。',audio_recognition_in_progress:'另一段录音正在识别，请等它完成；这段原录音已保存。'};
    const error=new Error(x.r.status===0?'连接中断，请重试，原文件和重试信息保留':(errorMessages[x.j.error]||(x.j.error==='media_mock_unavailable'?'识别服务尚未接通；原件已保存，可直接打字记录。':readableMediaError(x.j.message||x.j.error))));
    error.code=x.j.error||'';error.status=x.r.status;error.retryable=x.j.retryable===true;throw error;
  }
  return x.j;
}
async function loadMedia(){
  const requestId=++mediaLoadRequestId,dataGeneration=globalThis.recordDataGeneration||0;
  const subjectEpoch=typeof healthSubjectUiEpoch==='number'?healthSubjectUiEpoch:0;
  if(localMode&&typeof ensureHealthSubjectReady==='function'&&!await ensureHealthSubjectReady())return false;
  if(typeof healthSubjectUiEpoch==='number'&&subjectEpoch!==healthSubjectUiEpoch||requestId!==mediaLoadRequestId||dataGeneration!==globalThis.recordDataGeneration)return false;
  const {r,j}=await api('/api/media');
  if(typeof healthSubjectUiEpoch==='number'&&subjectEpoch!==healthSubjectUiEpoch||requestId!==mediaLoadRequestId||dataGeneration!==globalThis.recordDataGeneration)return false;
  if(!r.ok){mediaMessage('媒体列表暂时无法读取，请恢复连接后刷新');const box=$('archivePhotos');if(box){releaseOriginalsIn(box);box.innerHTML='<div class="load-error" role="status"><b>原件列表暂时无法读取</b><span>已保存原件不会删除，请恢复连接后刷新。</span></div>';}return false;}
  const nextItems=j.media||[],nextEvents=nextItems.some(m=>m.kind==='audio'&&(m.event_link?.record_id||m.record_id))?await readAudioEvents():null;
  if(typeof healthSubjectUiEpoch==='number'&&subjectEpoch!==healthSubjectUiEpoch||requestId!==mediaLoadRequestId||dataGeneration!==globalThis.recordDataGeneration)return false;
  mediaItems=nextItems;mediaEventsForDisplay=nextEvents;
  renderMedia(mediaEventsForDisplay);return true;
}
function standaloneMedia(m){return Boolean(m?.media_id&&m.delete_eligibility?.allowed===true&&m.save_status==='saved'&&m.recognition_status!=='processing')}
function mediaDeleteBlockMessage(m){const reason=m?.delete_eligibility?.reason;return reason==='linked'?'这份原件仍被记录或对话引用，不能单独删除。':reason==='link_pending'?'这份原件仍在关联处理中，暂不能删除。':reason==='processing'?'这份原件仍在处理中，暂不能删除。':reason==='upload_in_progress'?'这份原件仍在上传，暂不能删除。':reason==='trial_controlled'?'这份原件属于受控处理，暂不能删除。':reason==='owner_unknown'?'原件关联的所属人暂时无法确认，请刷新核对。':''}
function invalidateMediaAfterDelete(mediaId=null){
  mediaLoadRequestId++;
  const exactIds=Array.isArray(mediaId)?[...new Set(mediaId.filter(id=>typeof id==='string'&&id))]:mediaId?[mediaId]:null;
  const releaseIds=exactIds||[...originalTargets.keys()];
  releaseIds.forEach(id=>{releaseOriginal(id);recognitionBusy.delete(id)});
  if(exactIds){
    const deleted=new Set(exactIds);
    for(const [key,job] of localMediaJobs)if(deleted.has(job?.mediaId))localMediaJobs.delete(key);
    try{for(let index=localStorage.length-1;index>=0;index--){const key=localStorage.key(index);if(!key?.startsWith('elder_media_upload_v2:'))continue;try{if(deleted.has(JSON.parse(localStorage.getItem(key)||'null')?.mediaId))localStorage.removeItem(key)}catch{}}}catch{}
    mediaItems=mediaItems.filter(item=>!deleted.has(item.media_id));
    if(exactIds.length)mediaEventsForDisplay=null;
  }else{mediaItems=[];mediaEventsForDisplay=null;}
  renderMedia(mediaEventsForDisplay);
}
function renderMedia(events=typeof mediaEventsForDisplay==='undefined'?null:mediaEventsForDisplay){
  releaseOriginalsIn($('archivePhotos'));
  $('archivePhotoCount').textContent=mediaItems.filter(m=>m.kind==='image'&&m.save_status==='saved').length;
  $('archivePhotos').innerHTML=mediaItems.length?latestMediaFirst(mediaItems).map(m=>{
    const mock=isMockMedia(m);
    const terminalUnavailable=['failed','interrupted'].includes(m.recognition_status)&&!mediaRetryable(m);
    const trialRetry=m.recognition?.manual_retry_after_authorization===true&&trialRetryMessage(m);
    const action=trialRetry?(m.recognition.error.code==='trial_budget_exhausted'?'新授权后重试':'获授权后重试'):mock?(mediaRetryable(m)?'重新识别原录音':'查看模拟结果'):m.recognition_status==='succeeded'?'查看识别文字':m.recognition_status==='processing'?'识别处理中':terminalUnavailable?'':'识别 / 重试';
    const actionButton=action?`<button class="outline" data-recognize="${m.media_id}" ${m.save_status!=='saved'||m.recognition_status==='processing'?'disabled':''}>${action}</button>`:'';
    const unusableAudio=unusableAudioMessage(m);
    const audioReview=m.kind==='audio'?audioReviewDisplay(m,events):null;
    const audioReviewStatus=audioReview?`<p class="status">${AUDIO_REVIEW_LABELS[audioReview.state]}</p>`:'';
    const recognitionError=(m.recognition?.error_message||unusableAudio)?`<p class="status error">${escapeHtml(unusableAudio||readableMediaError(m.recognition.error_message,'识别没有完成，请保留原件并重试'))}</p>`:'';
    const terminalMessage=terminalUnavailable&&!unusableAudio?'<p class="status error">该识别失败不可重试，原件仍可查看。</p>':'';
    const deletable=standaloneMedia(m);
    const deleteButton=deletable?`<button class="outline" data-delete-media="${m.media_id}">删除这份未关联原件</button>`:'';
    const deleteBlock=deletable?'':mediaDeleteBlockMessage(m)?`<p class="status" role="status">${escapeHtml(mediaDeleteBlockMessage(m))}</p>`:'';
    return `<article class="handoff-item" id="media-${m.media_id}"><b>${escapeHtml(m.original_filename||'媒体原件')}</b><p>${mediaLabel(m)}</p>${audioReviewStatus}${mock?'<p class="status error">模拟识别结果，不是患者原话；不会进入报告或对话事实。原始录音仍保留。</p>':''}${recognitionError}${terminalMessage}<button class="outline" data-original="${m.media_id}" ${m.save_status!=='saved'?'disabled':''}>查看原件</button>${actionButton}${deleteButton}${deleteBlock}<div class="media-result"></div></article>`;
  }).join(''):'<p class="muted">还没有上传原件</p>';
  document.querySelectorAll('[data-original]').forEach(b=>b.onclick=()=>openOriginal(b.dataset.original));
  document.querySelectorAll('[data-recognize]').forEach(b=>b.onclick=()=>recognizeMedia(b.dataset.recognize));
  document.querySelectorAll('[data-delete-media]').forEach(b=>b.onclick=()=>deleteMedia(mediaItems.find(item=>item.media_id===b.dataset.deleteMedia),b));
}
function latestMediaFirst(items){return items.slice().sort((a,b)=>{const at=Date.parse(a.created_at||a.updated_at||'')||0;const bt=Date.parse(b.created_at||b.updated_at||'')||0;return bt-at||String(b.media_id||'').localeCompare(String(a.media_id||''))})}
function releaseOriginal(id){
  const node=originalTargets.get(id)?.node;
  try{node?.pause?.();node?.removeAttribute?.('src');node?.load?.()}catch{}
  if(originalUrls.has(id))URL.revokeObjectURL(originalUrls.get(id));
  originalUrls.delete(id);originalTargets.delete(id);
}
function releaseOriginalsIn(container){
  if(!container)return;
  for(const [id,target] of originalTargets){
    if(target.box===container||container.contains?.(target.box)||target.box?.isConnected===false)releaseOriginal(id);
  }
}
async function openOriginal(id,{box=null,media=null,controls=true}={}){
  let url,target;
  try{
    const m=media||mediaItems.find(m=>m.media_id===id);box=box||$('media-'+id)?.querySelector('.media-result');
    if(!m||!box||box.isConnected===false)throw new Error('原件暂时无法读取');
    releaseOriginalsIn(box);releaseOriginal(id);
    target={box,node:null};originalTargets.set(id,target);
    if(globalThis.HealthLocal?.active)url=await globalThis.HealthLocal.originalObjectUrl(id);
    else{await health();const r=await fetch(API+`/api/media/${id}/original`,{credentials:'include',headers:{'X-Session-Token':token}});if(!r.ok){const error=new Error('original_read_failed');error.status=r.status;throw error}url=URL.createObjectURL(await r.blob());}
    if(box.isConnected===false||originalTargets.get(id)!==target){URL.revokeObjectURL(url);if(originalTargets.get(id)===target)originalTargets.delete(id);return false}
    originalUrls.set(id,url);
    const node=document.createElement(m.kind==='audio'?'audio':'img');target.node=node;if(m.kind==='audio')node.preload='metadata';node.src=url;
    if(m.kind==='audio'){node.controls=controls;node.style.maxWidth='100%';if(!controls){node.hidden=true;node.setAttribute('aria-hidden','true')}}else{node.alt='已保存的照片原件';node.style.maxWidth='100%';}
    box.replaceChildren(node);
    if(m.kind==='image'){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.textContent='放大查看原件';box.append(link);}
    return true;
  }catch(e){
    if(url&&originalUrls.get(id)!==url)URL.revokeObjectURL(url);
    if(target&&originalTargets.get(id)===target){
      releaseOriginal(id);
      const missing=e?.message==='原件不存在'||e?.message==='original_unavailable'||e?.status===404;
      const denied=e?.message==='subject_mismatch'||[401,403,423].includes(e?.status);
      if(missing&&typeof unavailableConversationOriginalIds!=='undefined')unavailableConversationOriginalIds.add(id);
      if(box&&box.isConnected!==false)box.textContent=missing?'没有找到这段录音原件；识别文字与修改历史仍保留。':denied?'目前无法读取或访问这段录音；请确认本机资料已解锁后重试。':'原录音暂时无法读取；识别文字与修改历史仍保留，请稍后重试。';
    }else if(!box)mediaMessage(e.message);
  }
  return false;
}
async function showDocumentOriginals(recordId){
  const box=$('documentOriginals'),button=$('documentOriginalBtn');if(!box)return;
  const check=$('sourceReviewCheck');if(check){check.checked=false;check.disabled=true;const save=$('sourceReviewBtn');if(save)save.disabled=true;}
  button.disabled=true;box.textContent='正在读取关联照片…';
  try{
    // Reuse the local handoff's revision ancestry selection; unrelated photos stay out.
    const {r,j}=await api('/api/handoffs',{method:'POST',body:JSON.stringify({record_ids:[recordId]})});
    if(current?.record_id!==recordId)return;
    if(!r.ok)throw new Error('original_lookup_failed');
    const included=new Set([recordId]);let previous=current?.supersedes_id;
    while(previous&&!included.has(previous)){included.add(previous);const old=await api('/api/events/'+encodeURIComponent(previous));previous=old.j.event?.supersedes_id;}
    const photos=(j.handoff?.media_attachments||[]).filter(m=>m.kind==='image'&&m.save_status==='saved'&&included.has(m.record_id||m.event_link?.record_id));
    box.replaceChildren();
    if(!photos.length)box.textContent='这条记录没有可读取的照片原件。';
    for(const media of photos){const target=document.createElement('div');box.append(target);await openOriginal(media.media_id,{box:target,media});}
    const images=[...box.querySelectorAll('img')];
    const enableReview=()=>{if(current?.record_id===recordId&&images.length===photos.length&&images.length&&images.every(img=>img.complete&&img.naturalWidth>0)){const check=$('sourceReviewCheck');if(check)check.disabled=false;const status=$('sourceReviewStatus');if(status)status.textContent='照片已打开。请逐行核对，再勾选并保存核对结果。';}};
    images.forEach(img=>img.addEventListener('load',enableReview,{once:true}));enableReview();
  }catch{box.textContent='原件暂时无法读取，请点击按钮重试。';}
  finally{button.disabled=false;}
}
async function uploadMedia(file,kind,{temporary=false,conversationId=null}={}){
  if(uploadBusy)return;
  uploadBusy=true;
  try{
    if(!await health())throw new Error('服务未连接，文件仍在本页，请重试');
    const {capabilities:c}=await mediaRequest('/api/media/capabilities');
    setMediaCapability(c);
    if(!c.enabled)throw new Error('当前实例未配置媒体资源保护边界，请负责人按启动说明配置');
    if(!file?.size)throw new Error('这个文件是空的，尚未保存。请重新选择文件。');
    if(file.size>c.max_total_bytes)throw new Error(`文件超过当前上限（${formatMediaUploadLimit(c.max_total_bytes)}），尚未保存。请保留原文件，选择较小的文件再上传。`);
    const sourceType=(file.type||'').split(';')[0];
    const type=kind==='audio'&&sourceType==='video/webm'?'audio/webm':sourceType;
    if(!(kind==='audio'?c.audio_content_types:c.image_content_types).includes(type))throw new Error('当前服务不支持该文件格式，请保留原件并换用支持的格式');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await readBlobBytes(file))),v=>v.toString(16).padStart(2,'0')).join('');
    const jobKey=`elder_media_upload_v2:${kind}:${hash}:${type}:${temporary?'temporary':'retained'}:${conversationId||'standalone'}`;
    let job;if(globalThis.HealthLocal?.active)job=localMediaJobs.get(jobKey);else try{job=JSON.parse(localStorage.getItem(jobKey)||'null')}catch{}
    if(job?.mediaId){
      try{
        const {media}=await mediaRequest('/api/media/'+job.mediaId);
        if(media.save_status==='saved'){mediaMessage('原件已经保存，重复提交已复用同一条媒体',kind);await loadMedia();return media;}
      }catch(error){
        if(error.status!==404)throw error;
        // Deletion, successful temporary-audio cleanup or backup restore can
        // remove an earlier upload. A new user upload gets a fresh identity.
        if(globalThis.HealthLocal?.active)localMediaJobs.delete(jobKey);else localStorage.removeItem(jobKey);
        job=null;
      }
    }
    if(!job){
      const chunkSize=c.max_part_bytes,total=Math.ceil(file.size/chunkSize);
      if(total>c.max_parts)throw new Error('文件分片数量超过当前实例边界');
      job={key:crypto.randomUUID(),chunkSize,metadata:{kind,content_type:type,total_parts:String(total),expected_size:String(file.size),expected_sha256:hash,original_filename:file.name||`recording.${type.split('/')[1]}`,actor_name:'老人',temporary:String(temporary===true),conversation_id:conversationId||''}};
      if(globalThis.HealthLocal?.active)localMediaJobs.set(jobKey,job);else localStorage.setItem(jobKey,JSON.stringify(job));
    }
    mediaMessage('正在创建上传，原件尚未保存完整',kind);
    const form=new FormData();Object.entries(job.metadata).forEach(([k,v])=>form.append(k,v));
    const {upload}=await mediaRequest('/api/media/uploads',{method:'POST',headers:{'Idempotency-Key':job.key+':create'},body:form});
    job.mediaId=upload.media_id;job.uploadId=upload.upload_id;if(globalThis.HealthLocal?.active)localMediaJobs.set(jobKey,job);else localStorage.setItem(jobKey,JSON.stringify(job));
    for(let i=0;i<Number(job.metadata.total_parts);i++){
      mediaMessage(`正在上传 ${i+1}/${job.metadata.total_parts}，原件尚未保存完整`,kind);
      const part=new FormData();part.append('file',file.slice(i*job.chunkSize,(i+1)*job.chunkSize),`part-${i}`);
      await mediaRequest(`/api/media/uploads/${job.uploadId}/parts/${i}`,{method:'POST',headers:{'Idempotency-Key':job.key+':part:'+i},body:part});
    }
    const {media}=await mediaRequest(`/api/media/uploads/${job.uploadId}/complete`,{method:'POST',headers:{'Idempotency-Key':job.key+':complete'},body:'{}'});
    if(media.save_status!=='saved')throw new Error('原件尚未确认保存，请重试');
    mediaMessage('原件已保存，正在开始识别',kind);await loadMedia();return media;
  }catch(e){mediaMessage(e.message,kind);toast(e.message);}
  finally{uploadBusy=false;}
}
async function currentSavedAudioSource(media){
  const {media:latest}=await mediaRequest('/api/media/'+media.media_id);
  const rid=latest?.event_link?.record_id||latest?.record_id;
  if(!latest||latest.kind!=='audio'||latest.recognition_status!=='succeeded'||isMockMedia(latest)||!rid||!latest.recognition?.text?.trim()){
    throw new Error('录音记录已变化，请刷新并核对识别文字后再开始。');
  }
  const {r,j}=await api('/api/events');
  const event=r.ok?globalThis.HealthSafety?.currentAudioSource(latest,j.events):null;
  if(!event||isMockContent(event))throw new Error('当前录音记录无法读取，请刷新后再核对。');
  return {media:latest,event};
}
async function showCurrentAudioSource(media){
  try{const {event}=await currentSavedAudioSource(media);showView('recordsView');await showDetail(event.record_id)}
  catch(e){mediaMessage(e.message)}
}
async function showAudioOriginals(recordId){
  const box=$('audioOriginals');if(!box)return;box.textContent='正在读取原录音…';
  try{
    const [{media:items},{r,j}]=await Promise.all([mediaRequest('/api/media'),api('/api/events')]);
    const originals=r.ok?(items||[]).filter(m=>globalThis.HealthSafety?.currentAudioSource(m,j.events)?.record_id===recordId):[];
    if(!originals.length)throw new Error('原录音暂时无法读取；核对结果尚未保存。');
    box.replaceChildren();
    for(const media of originals){const target=document.createElement('div');box.append(target);await openOriginal(media.media_id,{box:target,media});
      target.querySelector('audio')?.addEventListener('play',()=>{if(current?.record_id===recordId){const check=$('audioSourceReviewCheck');if(check)check.disabled=false;const status=$('audioSourceReviewStatus');if(status)status.textContent='原录音已开始播放，请对照当前文字核对；这不代表医学确认。';}},{once:true});}
  }catch(e){box.textContent=readableMediaError(e.message,'原录音暂时无法读取；核对结果尚未保存。')}
}
async function startConversationFromSavedAudio(media){
  const {media:latest,event}=await currentSavedAudioSource(media);
  if(latest.version!==media.version)throw new Error('录音记录已变化，请刷新后再开始。');
  if(globalThis.HealthSafety?.audioNeedsReview(event)!==false)throw new Error('请先对照原录音核对当前文字，再新建对话。');
  const trial=await globalThis.HealthLocal?.trialVoiceState?.();
  if(latest.trial_control||trial&&trial.state!=='completed'){
    mediaMessage('正在根据已核对文字回应；原录音和已核对文字仍保留。');
    const x=await api('/api/conversations/saved-audio-trial/start',{method:'POST',body:JSON.stringify({media_id:latest.media_id,media_version:latest.version,record_id:event.record_id,source_version:event.version,local_date:localDateValue()})});
    if(!x.r.ok)throw new Error('本次没有收到可确认的回复；原录音和已核对文字仍保留，不会自动重发。');
    syncConversation(x.j.conversation,{speak:x.j.created&&!x.j.ai_failed});showView('voiceView');
    setVoiceStatus(savedAudioTrialMessage(x.j.conversation.saved_audio_trial),x.j.conversation.saved_audio_trial?.state==='stopped'?'error':'ok');
    setVoiceComposerEnabled(false);await loadEvents();return !x.j.ai_failed;
  }
  if(!await startSeparateConversation())return false;
  showView('voiceView');
  return await submitConversationText(event.raw_text,{source_kind:'audio_transcript',record_id:event.record_id,source_version:event.version,media_id:latest.media_id,idempotencyKey:`saved-audio-conversation:${latest.media_id}:${activeConversation.conversation_id}`});
}
function showRecognition(m,events=typeof mediaEventsForDisplay==='undefined'?null:mediaEventsForDisplay){
  const box=$('media-'+m.media_id)?.querySelector('.media-result');if(!box)return;
  box.savedAudioGrantRender=null;
  const mock=isMockMedia(m);
  const audioReview=m.kind==='audio'?audioReviewDisplay(m,events):null;
  const originalHeading=audioReview?.originalIsHistorical?'首次机器识别（修订前，仅作历史参考）':m.kind==='audio'?'原始机器识别文字':'识别文字（请核对）';
  const currentText=audioReview?.originalIsHistorical?`<h4>当前录音文字</h4><div class="raw-box">${escapeHtml(audioReview.event.raw_text)}</div>`:'';
  box.innerHTML=`<h4 tabindex="-1">${mock?'历史模拟识别结果':originalHeading}</h4>`+(mock?'<p class="status error">这是模拟内容，不是患者原话；不能核对为事实。请以上方原件保存状态为准，真实服务接通后可重试。</p>':m.kind==='image'?'<p class="status warn">这是识别草稿，可能猜错残缺内容；请进入记录对照原件。核对前不会用于整理或交接正文。</p>':m.kind==='audio'?`<p class="status">${AUDIO_REVIEW_LABELS[audioReview.state]}</p>${safetyHtml(m.local_safety||m.recognition?.local_safety)}`:safetyHtml(m.local_safety||m.recognition?.local_safety))+`<div class="raw-box">${escapeHtml(m.recognition?.text||unusableAudioMessage(m)||readableMediaError(m.recognition?.error_message,'没有可用识别文字；原件仍保留'))}</div>${currentText}`;
  if(mock){reveal(box,'h4');return}
  const rid=m.event_link?.record_id||m.record_id;
  if(rid&&m.kind==='audio'&&audioReview?.event){const b=document.createElement('button');b.className='primary';b.textContent=audioReview.state==='reviewed'?'查看当前记录':'核对当前文字';b.onclick=()=>showCurrentAudioSource(m);box.append(b);}
  else if(rid&&m.kind!=='audio'){const b=document.createElement('button');b.className='primary';b.textContent='核对识别记录';b.onclick=()=>{showView('recordsView');showDetail(rid)};box.append(b);}
  else if(m.recognition_status==='succeeded'){
    const b=document.createElement('button');b.className='outline';b.textContent=globalThis.HealthLocal?.active?'把识别文字保存为待核对记录':'恢复记录关联';
    b.onclick=async()=>{b.disabled=true;try{const {media:latest}=await mediaRequest('/api/media/'+m.media_id);await mediaRequest(`/api/media/${m.media_id}/link`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({expected_version:latest.version})});await loadMedia();const {media}=await mediaRequest('/api/media/'+m.media_id);showRecognition(media);await loadEvents();}catch(e){mediaMessage(e.message);b.disabled=false;}};box.append(b);
  }
  if(m.kind==='audio'&&m.recognition_status==='succeeded'&&rid){
    const addStart=()=>{const b=document.createElement('button');b.className='outline';b.textContent='用录音文字新建对话';
      b.onclick=async()=>{if(b.disabled)return;b.disabled=true;try{if(!await startConversationFromSavedAudio(m))b.disabled=false}catch(e){mediaMessage(e.message);b.disabled=false}};box.append(b);};
    if(!m.conversation_id)addStart();
    else if(m.trial_control&&globalThis.HealthLocal?.savedAudioTrialAvailable){
      const render=Symbol();box.savedAudioGrantRender=render;
      globalThis.HealthLocal.savedAudioTrialAvailable(m.media_id).then(allowed=>{
        if(allowed&&box.isConnected!==false&&box.savedAudioGrantRender===render)addStart();
      }).catch(()=>{});
    }
  }
  reveal(box,'h4');
}
function recognitionStillFinishing(m){
  return m.recognition_status==='processing'||(m.link_pending_reason==='conversation_link_pending'&&!m.conversation_turn_id)||(m.recognition_status==='succeeded'&&!m.event_link?.record_id&&!m.record_id&&['safety_scan_pending','event_link_pending'].includes(m.link_pending_reason));
}
async function recognizeMedia(id){
  if(recognitionBusy.has(id))return null;
  recognitionBusy.add(id);
  try{
    let {media:m}=await mediaRequest('/api/media/'+id);
    if(['failed','interrupted'].includes(m.recognition_status)&&!mediaRetryable(m)){
      showRecognition(m,m.kind==='audio'?await readAudioEvents():mediaEventsForDisplay);
      mediaMessage('该识别失败不可重试；原件仍可查看');
      return m;
    }
    if(m.recognition_status==='succeeded'&&!recognitionStillFinishing(m)){showRecognition(m,m.kind==='audio'?await readAudioEvents():mediaEventsForDisplay);return m;}
    if(!['processing','succeeded'].includes(m.recognition_status)){
      const opKey='elder_media_recognize_v1:'+id;
      let op;try{op=JSON.parse(localStorage.getItem(opKey)||'null')}catch{}
      // Reuse uncertain submissions. A terminal failure needs a new attempt/version.
      if(!op||op.version!==m.version)op={key:crypto.randomUUID(),version:m.version};
      localStorage.setItem(opKey,JSON.stringify(op));
      await mediaRequest(`/api/media/${id}/recognize`,{method:'POST',headers:{'Idempotency-Key':op.key},body:JSON.stringify({expected_version:op.version})});
    }
    mediaMessage('识别处理中；原件已保存，可以稍后刷新查看');await loadMedia();
    for(let i=0;i<120;i++){
      const {media}=await mediaRequest('/api/media/'+id);
      if(!recognitionStillFinishing(media)){
        await loadMedia();showRecognition(media,media.kind==='audio'?await readAudioEvents():mediaEventsForDisplay);await loadEvents();
        mediaMessage(media.recognition_status==='succeeded'?'识别文字已保留，请核对来源和内容':trialRetryMessage(media)||unusableAudioMessage(media)||(mediaRetryable(media)?'识别没有完成，原件仍可查看和重试':'识别没有完成，原件仍可查看；请查看下方说明。'));return media;
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    await loadMedia();
    const {media}=await mediaRequest('/api/media/'+id);showRecognition(media,media.kind==='audio'?await readAudioEvents():mediaEventsForDisplay);
    mediaMessage(media.link_pending_reason==='conversation_link_pending'?'识别已完成，正在接入这次对话；原件已保存，请稍后刷新查看':'识别或记录关联仍待完成，请稍后刷新或恢复关联；原件已保存');
    return media;
  }catch(e){mediaMessage(e.message);await loadMedia();const latest=mediaItems.find(item=>item.media_id===id);if(latest&&e.code)latest.recognition={...(latest.recognition||{}),error:{code:e.code,retryable:e.retryable},error_message:e.message,retryable:e.retryable};return latest||null;}
  finally{recognitionBusy.delete(id);}
}
$('photoInput').onchange=async e=>{
  if(mediaCapabilities&&mediaCapabilities.enabled!==true)return;
  const source=e.target.files?.[0];if(!source)return;
  // Clearing the value after capturing the File permits selecting the same
  // path again after a failed upload. Copy the bytes first because some
  // embedded browsers revoke their temporary file handle when it is cleared.
  try{selectedPhoto=await retainSelectedFile(source)}catch{e.target.value='';mediaMessage('照片原件读取失败，请重新选择','image');return}
  e.target.value='';
  mediaMessage('照片已选好，尚未上传','image');
  const preview=$('photoPreview'),savePhoto=$('savePhotoBtn');preview.replaceChildren();const img=document.createElement('img');
  img.src=URL.createObjectURL(selectedPhoto);img.alt='待上传照片预览';img.onload=()=>{URL.revokeObjectURL(img.src);savePhoto.scrollIntoView?.({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'})};preview.append(img);
  const note=document.createElement('p');note.textContent='仅预览，尚未上传或识别';preview.append(note);preview.classList.remove('hidden');savePhoto.classList.remove('hidden');savePhoto.scrollIntoView?.({behavior:'auto',block:'center'});
};
$('savePhotoBtn').onclick=async()=>{if(uploadBusy)return;const m=await uploadMedia(selectedPhoto,'image');if(m){showView('archiveView');await recognizeMedia(m.media_id);}};
$('audioUploadInput').onchange=async e=>{if(mediaCapabilities&&mediaCapabilities.enabled!==true)return;const source=e.target.files?.[0];if(!source)return;let f;try{f=await retainSelectedFile(source)}catch{e.target.value='';mediaMessage('录音原件读取失败，请重新选择');return}e.target.value='';const m=await uploadMedia(f,'audio');showView('archiveView');if(m)await recognizeMedia(m.media_id);};
async function savePendingRecording(){
  if(!pendingRecordingBlob||uploadBusy)return;
  const recordingDurationSeconds=Math.max(1,Math.round(Number(elapsedMs||0)/1000));
  const retry=$('retryVoiceUploadBtn');retry.disabled=true;
  const media=await uploadMedia(pendingRecordingBlob,'audio',{temporary:true,conversationId:pendingRecordingIntent?.conversationId??activeConversation?.conversation_id??null});
  if(media){
    pendingRecordingBlob=null;voiceUploadPending=false;setRecording(false);
    retry.classList.add('hidden');$('voiceHint').textContent='原录音已保存，正在尝试语音转文字';if(typeof showVoiceMediaSaved==='function')showVoiceMediaSaved(media);
    const captureIntent=pendingRecordingIntent;
    const recognized=await recognizeMedia(media.media_id);if(typeof showVoiceMediaResult==='function')await showVoiceMediaResult(recognized||media,{newRecording:true,durationSeconds:recordingDurationSeconds,captureIntent});
    if(pendingConversationTurn?.audio_processing){pendingConversationTurn=null;renderVoiceConversation()}
    if(pendingRecordingIntent===captureIntent)pendingRecordingIntent=null;
  }else{
    // A non-retryable capability/provider failure cannot be fixed by clicking
    // this button.  Keep the original in memory, but avoid presenting a
    // misleading retry affordance.
    const retryable=mediaCapabilities?.enabled!==false;
    if(pendingConversationTurn?.audio_processing){pendingConversationTurn={...pendingConversationTurn,pending_audio_stage:'upload_failed',text:'录音尚未保存；可点重试。'};renderVoiceConversation()}
    retry.classList.toggle('hidden',!retryable);
    $('voiceHint').textContent=retryable?'录音尚未保存，请在本页重试，先不要刷新或关闭页面':'录音尚未保存；当前媒体能力不可用，请恢复配置后再试';
    if(typeof setVoiceStatus==='function')setVoiceStatus($('voiceHint').textContent,'error');
  }
  retry.disabled=false;
}
// Capture this recorder's array before a later recording can replace globals.
$('finishVoiceBtn').onclick=()=>{
  if(voiceUploadPending||voicePermissionPending)return;
  const recorder=mediaRecorder;
  if(!recorder||recorder.state==='inactive'){stopVoice('没有可上传录音，请先开启麦克风或上传已有录音');return;}
  const elapsedAtFinishMs=Number(elapsedMs||0)+(recorder.state==='recording'&&Number.isFinite(Number(startedAt))?Math.max(0,Date.now()-Number(startedAt)):0);
  const recordingChunks=chunks;
  pendingRecordingIntent=typeof voiceCaptureIntent==='undefined'?null:voiceCaptureIntent;
  voiceUploadPending=true;
  pendingConversationTurn={turn_id:'pending-audio',role:'elder',source_kind:'audio_transcript',text:'正在保存录音…',audio_duration_seconds:Math.max(1,Math.round(elapsedAtFinishMs/1000)),pending:true,audio_processing:true,pending_audio_stage:'saving',followOnRender:true};
  renderVoiceConversation();
  const keepRecording=async()=>{
    const blob=new Blob(recordingChunks,{type:recorder.mimeType||recordingChunks[0]?.type||''});
    if(blob.size){
      pendingRecordingBlob=blob;
      $('retryVoiceUploadBtn').classList.remove('hidden');
      await savePendingRecording();
    }
    else {pendingRecordingIntent=null;voiceUploadPending=false;setRecording(false);if(pendingConversationTurn?.audio_processing){pendingConversationTurn=null;renderVoiceConversation()}const message='没有录到声音，请检查麦克风后重试，也可以上传已有录音或直接输入文字';mediaMessage(message);$('voiceHint').textContent=message;if(typeof setVoiceStatus==='function')setVoiceStatus(message,'error');}
  };
  recorder.addEventListener('stop',keepRecording,{once:true});
  if(!stopVoice('正在保留这一段录音'))void keepRecording();
};
$('retryVoiceUploadBtn').onclick=savePendingRecording;
$('photoUploadLabel').onclick=()=>{if(!$('photoUploadLabel').disabled)$('photoInput').click?.()};
$('audioUploadLabel').onclick=()=>{if(!$('audioUploadLabel').disabled)$('audioUploadInput').click?.()};
window.addEventListener('beforeunload',e=>{if(voiceUploadPending||pendingRecordingBlob||mediaRecorder?.state==='recording'){e.preventDefault();e.returnValue='';}});
$('refreshMediaBtn').onclick=async()=>{await health();await loadMediaCapabilities();await loadMedia();await refreshMediaOnlineStatus();};
document.querySelectorAll('[data-view="archiveView"]').forEach(b=>b.addEventListener('click',async()=>{await loadMediaCapabilities();await loadMedia();}));
setMediaCapability(null);
health().then(async()=>{await loadMediaCapabilities();if(localMode&&(!healthSubjectLoaded||healthSubjectChanged||healthSubjectSwitchBusy))return;await loadMedia();await refreshMediaOnlineStatus();});
