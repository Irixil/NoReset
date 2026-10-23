(function () {
  'use strict';

  const core = globalThis.HealthLocalCore;
  const safety = globalThis.HealthSafety;
  if (!core || !safety || !globalThis.indexedDB) return;

  const driver = new core.IndexedDbDocumentStore();
  const vault = new core.EncryptedVault(driver);
  const SOURCE_KINDS = new Set(['elder', 'family_observation', 'family_report', 'caregiver', 'clinician_evidence', 'document', 'audio_transcript', 'system', 'unknown']);
  const MEDIA_TYPES = {
    audio: ['audio/aac', 'audio/flac', 'audio/m4a', 'audio/mp3', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/x-m4a', 'audio/x-wav'],
    image: ['image/gif', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp'],
  };
  const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
  const UNRESOLVED_CORRECTION_NOTE = '自然更正无法唯一定位旧原话，待核实。';
  const RECOVERABLE_MEDIA_ERRORS = new Set(['media_mock_unavailable', 'provider_not_configured', 'media_configuration_invalid', 'session_unavailable', 'authentication_required', 'access_not_configured', 'ai_rate_limited', 'configuration_missing', 'network_unavailable', 'provider_timeout', 'provider_unavailable', 'provider_rate_limited']);
  const CONVERSATION_FAILURE_CODES = new Set(['ai_conversation_failed', 'model_timeout', 'model_network_error', 'model_configuration_invalid', 'model_redirect_rejected', 'model_response_too_large', 'model_output_truncated', 'model_response_invalid', 'model_mock_unavailable', 'model_http_error', 'model_account_binding_required', 'model_schema_invalid', 'model_evidence_invalid', 'model_reply_unsafe', 'reviewed_risk_invalid', 'trial_authorization_required', 'trial_budget_exhausted', 'trial_stopped', 'trial_review_required', 'saved_audio_trial_source_changed', 'saved_audio_trial_not_authorized', 'audio_source_review_required', 'session_unavailable', 'authentication_required', 'access_not_configured', 'ai_rate_limited', 'network_unavailable', 'subject_mismatch', 'conversation_not_found', 'conversation_version_conflict']);
  const CONVERSATION_HTTP_FAILURE_STATUSES = new Set([401, 403, 408, 409, 422, 429, 500, 502, 503, 504]);
  const PROVIDER_HTTP_FAILURE_STATUSES = new Set([401, 403, 408, 429, 500, 502, 503, 504]);
  let initialisePromise;
  let active = false;
  let pendingLocalOperations = 0;
  let restoringBackup = false;
  let vaultCheckSequence = 0;
  const vaultStateListeners = new Set();
  const vaultTabId = crypto.randomUUID();
  // The patient displayed in this unlocked page stays bound to this realm.
  // A shared IndexedDB selection changed by another tab cannot retarget a form.
  let observedSubjectId = null;
  const conversationWrites = new Map();
  const eventWrites = new Map();
  const mediaWrites = new Map();
  const mediaRecognitionWrites = new Map();
  const audioRecognitionWrites = new Map();
  const AUDIO_RECOGNITION_LOCK = 'bingli-audio-recognition-active-v1';
  let localAudioRecognitionScopes = 0;
  const localMediaRecognitionIds = new Set();
  const TRIAL_VOICE_KEY = 'trial-control:voice';
  function notifyVaultState(state) {
    for (const listener of vaultStateListeners) {
      try { listener(state); } catch {}
    }
  }
  function invalidateVaultSession() {
    if (!active && !vault.dataKey) return false;
    vaultCheckSequence += 1;
    vault.lock(); active = false; initialisePromise = null; observedSubjectId = null;
    notifyVaultState('invalidated');
    return true;
  }
  async function verifyCurrentVault() {
    if (!active) return false;
    const sequence = ++vaultCheckSequence;
    notifyVaultState('checking');
    try {
      await vault.ensureCurrentVault();
      if (sequence !== vaultCheckSequence || !active) return false;
      notifyVaultState('current');
      return true;
    } catch (error) {
      if (sequence !== vaultCheckSequence || !active) return false;
      if (['vault_changed_requires_unlock', 'vault_locked'].includes(error.message)) {
        invalidateVaultSession();
        return false;
      }
      notifyVaultState('unavailable');
      return false;
    }
  }
  function announceVaultRestore() {
    try { vaultRestoreChannel?.postMessage({ type: 'vault-restored', tabId: vaultTabId }); } catch {}
  }
  function consumeVaultInvalidationNotice() {
    try {
      if (sessionStorage.getItem('bingli-vault-lock-notice') !== 'restored') return false;
      sessionStorage.removeItem('bingli-vault-lock-notice');
      return true;
    } catch { return false; }
  }
  const vaultRestoreChannel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('bingli-local-vault-restore-v1') : null;
  if (vaultRestoreChannel) vaultRestoreChannel.addEventListener('message', event => {
    if (event.data?.type === 'vault-restored' && event.data.tabId !== vaultTabId) void verifyCurrentVault();
  });
  globalThis.addEventListener?.('pageshow', () => { void verifyCurrentVault(); });
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') void verifyCurrentVault();
  });
  function trialMarker(body) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, 'trial_control')) return null;
    const marker = body.trial_control;
    const valid = marker && typeof marker === 'object' && !Array.isArray(marker)
      && marker.review_required === true && Object.keys(marker).every(key => ['review_required', 'stopped'].includes(key))
      && (!Object.prototype.hasOwnProperty.call(marker, 'stopped') || marker.stopped === true);
    return { review_required: true, state: valid && marker.stopped !== true ? 'review_required' : 'stopped' };
  }
  async function trialVoiceState() { return await vault.get(TRIAL_VOICE_KEY) || null; }
  function sameTrialOwner(a, b) {
    return a && b && typeof a.conversation_id === 'string' && a.conversation_id
      && typeof a.turn_id === 'string' && a.turn_id && Number.isInteger(a.turn_version) && a.turn_version > 0
      && a.conversation_id === b.conversation_id && a.turn_id === b.turn_id && a.turn_version === b.turn_version
      && (a.media_id ?? null) === (b.media_id ?? null);
  }
  async function saveTrialConversation(conversation, control, extraPuts = [], unchanged = []) {
    const saved = { ...conversation, trial_control: control, version: conversation.version + 1, updated_at: now() };
    await ownedMutation({ puts: [{ key: conversationKey(saved.conversation_id), value: saved }, { key: TRIAL_VOICE_KEY, value: control }, ...extraPuts], unchanged });
    return saved;
  }

  function apiUrl(path) { return globalThis.BingliConfig?.apiUrl(path) || path; }

  function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`; }
  function now() { return new Date().toISOString(); }
  function ok(status, payload) { return { r: { ok: status >= 200 && status < 300, status }, j: payload }; }
  function fail(status, error, extra = {}) { return ok(status, { ok: false, error, ...extra }); }
  function parseBody(options) {
    if (!options?.body) return {};
    if (typeof options.body === 'string') return JSON.parse(options.body || '{}');
    return options.body;
  }
  function eventKey(recordId) { return `event:${recordId}`; }
  function mediaKey(mediaId) { return `media:${mediaId}`; }
  function mediaBinaryKey(mediaId) { return `media-binary:${mediaId}`; }
  function conversationKey(conversationId) { return `conversation:${conversationId}`; }
  const HEALTH_CONTEXT_KEY = 'health-context:current';
  const HEALTH_SUBJECTS_KEY = 'health-subjects:current';
  const SELF_SUBJECT_ID = 'subject_self';
  const HEALTH_CATEGORIES = new Set(['conditions', 'medications', 'allergies', 'procedures', 'tests', 'similar_episodes']);
  const CLINICAL_CATEGORIES = ['main_complaint', 'onset_course', 'symptom_character', 'aggravating_relieving', 'associated_symptoms', 'functional_impact', 'relevant_history', 'prior_actions_results'];
  const REPORT_CATEGORY_LABELS = {
    main_complaint: '主要不适', onset_course: '开始与变化', symptom_character: '感觉与程度',
    aggravating_relieving: '加重或缓解', associated_symptoms: '同时出现', functional_impact: '生活影响',
    relevant_history: '相关经历', prior_actions_results: '已做处理',
  };
  const REPORT_PATTERNS = {
    main_complaint: /疼|痛|晕|咳|喘|闷|恶心|吐|发热|发烧|无力|没劲|麻|痒|肿|不舒服|难受|睡不着|吃不下|伸不直/,
    onset_course: /今天|昨天|前天|刚才|早上|上午|中午|下午|晚上|半夜|最近|小时|分钟|天|周|月|年|开始|一直|后来|突然|慢慢|越来越|反复|时好时坏/,
    symptom_character: /刺|胀|酸|麻|烧|灼|跳着|隐隐|钝|刀割|压着|一阵|持续|轻|重|厉害|剧烈|程度|分|前侧|后侧|内侧|外侧|左边|右边/,
    aggravating_relieving: /活动|走路|上楼|下楼|弯|伸|躺|坐|站|休息|吃饭|空腹|更疼|减轻|缓解/,
    associated_symptoms: /同时|还会|伴随|另外|发烧|咳|吐|恶心|晕|麻|肿|喘|心慌|出汗/,
    functional_impact: /影响|费劲|不稳|抓不住|拿不住|抬不起来|睡不着|睡不好|吃不下|走不了|不能走|下不了地|起不来|伸不直|活动|自理|干活/,
    relevant_history: /以前|之前也|老毛病|长期|过敏|手术|住院|一直吃|既往|病史/,
    prior_actions_results: /量过|测过|做过|看过|查过|用了|吃了|处理|结果|报告|数值/,
  };
  const REPORT_META_MESSAGE = /没听懂|没听我说|不明白我|没理解|为什么不?问|怎么不问|你问的是|这个问题|问错|照本宣科|固定流程|太死板|你不能告诉我|怎么就突然/;
  const CONVERSATION_OPENING_TEXT = '您好，我会帮您把不舒服的地方记清楚，方便和医生说。您今天最难受的是什么？';
  const CONVERSATION_FINISH_TEXT = '我已经把您刚才说的主要情况记下来了。还有想补充的可以继续说，不想说也可以直接退出。';
  const CONVERSATION_FAILURE_TEXT = '这次回复未确认成功，原话已保存在本机。';
  const CONVERSATION_BLOCKED_TEXT = '我不能提供诊断、用药或治疗建议。我先把您刚才说的原话记下来了。';

  function openingConversationController() {
    const counts = Object.fromEntries(CLINICAL_CATEGORIES.map(category => [category, 0]));
    counts.main_complaint = 1;
    return {
      asked_categories: ['main_complaint'], closed_categories: [], question_counts: counts,
      asked_questions: [CONVERSATION_OPENING_TEXT], question_count: 1,
      no_new_fact_count: 0, last_question_category: 'main_complaint',
    };
  }
  function editedConversationController(previous) {
    const next = openingConversationController();
    if (!previous || typeof previous !== 'object') return next;
    for (const key of ['session_id', 'session_anchor_turn_id']) {
      if (typeof previous[key] === 'string') next[key] = previous[key];
    }
    if (Array.isArray(previous.session_turn_ids)) next.session_turn_ids = [...previous.session_turn_ids];
    if (Array.isArray(previous.non_health_sources)) next.non_health_sources = JSON.parse(JSON.stringify(previous.non_health_sources));
    return next;
  }
  function liveConversationTurns(conversation) {
    return (conversation?.turns || []).filter(turn => !turn.superseded);
  }
  function reportableConversationTurns(conversation) {
    const turns = liveConversationTurns(conversation).filter(turn => turn.audio_source_invalidated !== true);
    const pendingAudioIndex = turns.findIndex(turn => turn.role === 'elder'
      && turn.source_kind === 'audio_transcript' && turn.audio_source_reviewed !== true
      && !['machine_transcribed', 'user_edited'].includes(turn.audio_source_status));
    return pendingAudioIndex < 0 ? turns : turns.slice(0, pendingAudioIndex);
  }
  function explicitNaturalCorrection(text) {
    const match = /^\s*更正一下[，,]\s*刚才说(?<old>[^，。；,.!?！？;]{1,48})不准确[，,]\s*(?<replacement>[^。！？；.!?]{1,120})(?<punctuation>[。！？.!?]?)\s*$/u.exec(String(text || ''));
    if (!match) return null;
    const oldQuote = match.groups.old.trim(), newQuote = match.groups.replacement.trim() + match.groups.punctuation;
    return oldQuote && newQuote ? { oldQuote, newQuote } : null;
  }
  function fullSentenceQuotes(text) {
    return (String(text || '').match(/[\s\S]+?(?:[。！？!?]|\.(?!\d)|(?<!\d)\.|$)/gu) || [])
      .map(value => value.trim()).filter(Boolean);
  }
  function exactOccurrenceCount(text, quote) {
    let count = 0, offset = 0;
    while (quote && (offset = text.indexOf(quote, offset)) >= 0) { count += 1; offset += 1; }
    return count;
  }
  function mockSource(item) {
    return item?.is_mock === true || /\[Mock (?:ASR|OCR)\]/i.test(String(item?.raw_text || item?.text || ''));
  }
  function audioReviewCurrent(turn, eventIndex, mediaIndex = null, conversationId = null, expectedSubjectId = null) {
    const event = eventIndex.get(turn?.record_id);
    const media = mediaIndex && turn?.media_id ? mediaIndex.get(turn.media_id) : null;
    return turn?.source_kind === 'audio_transcript' && turn.audio_source_reviewed === true
      && event?.source_kind === 'audio_transcript' && event.state !== 'superseded'
      && event.version === turn.audio_source_version && event.raw_text === turn.text
      && event.source_review?.method === 'original_comparison'
      && event.source_review.record_id === event.record_id && event.source_review.text === turn.text
      && (!conversationId || !turn.audio_source_conversation_id || turn.audio_source_conversation_id === conversationId)
      && (!expectedSubjectId || subjectOf(event) === expectedSubjectId)
      && (!media || subjectOf(media) === subjectOf(event)
        && (!Number.isInteger(turn.audio_source_media_version) || media.version === turn.audio_source_media_version))
      && !safety.audioNeedsReview(event);
  }
  function audioConversationSourceBindingCurrent(turn, eventIndex, mediaIndex, conversationId, expectedSubjectId) {
    if (audioReviewCurrent(turn, eventIndex, mediaIndex, conversationId, expectedSubjectId)) return true;
    if (!['machine_transcribed', 'user_edited'].includes(turn?.audio_source_status)) return false;
    const event = eventIndex.get(turn.record_id), media = mediaIndex.get(turn.media_id);
    return turn.source_kind === 'audio_transcript' && turn.audio_source_reviewed !== true
      && event?.source_kind === 'audio_transcript' && event.state !== 'superseded'
      && event.version === turn.audio_source_version && event.raw_text === turn.text
      && media?.kind === 'audio' && media.recognition_status === 'succeeded'
      && !mockSource(media) && media.version === turn.audio_source_media_version
      && Number.isSafeInteger(turn.audio_source_media_version) && Number.isSafeInteger(turn.audio_source_version)
      && subjectOf(media) === subjectOf(event)
      && (!expectedSubjectId || subjectOf(event) === expectedSubjectId)
      && turn.audio_source_conversation_id === conversationId && media.conversation_id === conversationId
      && (!event.source_conversation_id || event.source_conversation_id === conversationId)
      && (turn.audio_source_status !== 'user_edited' || !event.source_review)
      && safety.currentAudioSource(media, [...eventIndex.values()])?.record_id === event.record_id;
  }
  function audioConversationSourceCurrent(turn, eventIndex, mediaIndex, conversationId, expectedSubjectId) {
    return turn?.audio_source_invalidated !== true
      && audioConversationSourceBindingCurrent(turn, eventIndex, mediaIndex, conversationId, expectedSubjectId);
  }
  async function quoteContextCurrent(conversation, quote) {
    if (!quote || quote.conversation_id !== conversation?.conversation_id || !Array.isArray(conversation.turns)) return false;
    const matches = conversation.turns.filter(turn => turn.turn_id === quote.turn_id);
    const turn = matches[0], source = quote.source || {};
    if (matches.length !== 1 || !turn || turn.superseded || mockSource(turn) || turn.text !== quote.text
      || turn.role !== quote.role || (turn.version ?? 1) !== quote.version) return false;
    if (turn.role === 'assistant') {
      if (source.source_kind !== 'assistant_message' || source.record_id !== null || source.record_version !== null
        || source.media_id !== null || source.media_version !== null || turn.ai_failed
        || !['ask', 'reply', 'finish', 'urgent', 'soon_evaluation'].includes(turn.action)
        || (conversation.stale_responding_to_turn_ids || []).includes(turn.turn_id)) return false;
      const currentContext = await healthContext(subjectOf(conversation));
      if (Number(conversation.health_context_version || 0) !== Number(currentContext.version || 0)) return false;
      const selectedContextIds = new Set((conversation.selected_context_ids || []).filter(contextId =>
        currentContext.entries.some(entry => entry.context_id === contextId && usableHealthEntry(entry, subjectOf(conversation)))));
      return !Array.isArray(turn.model_context_ids) || turn.model_context_ids.every(contextId => selectedContextIds.has(contextId));
    }
    if (turn.role !== 'elder' || !turn.record_id || source.record_id !== turn.record_id) return false;
    const event = await vault.get(eventKey(turn.record_id));
    if (!event || subjectOf(event) !== subjectOf(conversation) || event.state === 'superseded'
      || event.raw_text !== turn.text || event.version !== source.record_version) return false;
    if (turn.source_kind !== 'audio_transcript') return source.source_kind === 'elder'
      && source.media_id === null && source.media_version === null && event.source_kind === 'elder';
    const media = turn.media_id ? await vault.get(mediaKey(turn.media_id)) : null;
    if (!media || source.source_kind !== 'audio_transcript' || source.media_id !== media.media_id
      || source.media_version !== media.version || media.kind !== 'audio' || mockSource(media)
      || media.recognition_status !== 'succeeded' || !(await vault.get(mediaBinaryKey(media.media_id)))?.bytes) return false;
    return audioConversationSourceCurrent(turn, new Map([[event.record_id, event]]), new Map([[media.media_id, media]]),
      conversation.conversation_id, subjectOf(conversation));
  }
  function reportHistoryIncluding(history, previous, next) {
    if (!previous || !next || previous.version === next.version) return Array.isArray(history) ? history : [];
    const saved = Array.isArray(history) ? history : [];
    return saved.some(item => item?.version === previous.version) ? saved : [...saved, previous];
  }
  function removeRevokedContextFromReport(report, changed) {
    if (!report || !Array.isArray(report.sections)) return report;
    const revoked=new Set(changed||[]),sections=report.sections.map(section=>({...section,lines:(section.lines||[]).filter(line=>{
      const ids=[...(line.source_context_ids||[]),line.source_context?.context_id].filter(Boolean);
      return !ids.some(contextId=>revoked.has(contextId));
    })})).filter(section=>section.lines.length);
    const transcript=Array.isArray(report.transcript)?report.transcript.filter(turn=>turn.role==='elder').map(turn=>turn.text).filter(Boolean):[];
    const bodyParts=sections.map(section=>`${section.title}\n${section.lines.map(line=>`- ${line.tags?.length?`${line.tags.join('、')}：`:''}${line.text}`).join('\n')}`);
    if(transcript.length)bodyParts.push(`老人原话历史（按说话顺序完整保留）\n${transcript.join('\n')}`);
    const scrubCoverage=coverage=>{
      if(!coverage||typeof coverage!=='object')return coverage;
      const scrubNomination=nomination=>nomination?{...nomination,context:(nomination.context||[]).filter(item=>!revoked.has(item.context_id)),
        selected_context_ids:(nomination.selected_context_ids||[]).filter(contextId=>!revoked.has(contextId))}:nomination;
      const sources=coverage.sources?{...coverage.sources,context:(coverage.sources.context||[]).filter(item=>!revoked.has(item.context_id)),
        selected_context_ids:(coverage.sources.selected_context_ids||[]).filter(contextId=>!revoked.has(contextId))}:coverage.sources;
      return {...coverage,...(sources?{sources}:{}),...(Array.isArray(coverage.candidates)?{candidates:coverage.candidates.map(item=>({...item,nomination:scrubNomination(item.nomination)}))}:{})};
    };
    const safeCoverage=scrubCoverage(report.question_coverage);
    return {...report,sections,body:bodyParts.join('\n\n'),source_context_ids:(report.source_context_ids||[]).filter(contextId=>!revoked.has(contextId)),
      ...(safeCoverage?{question_coverage:safeCoverage}:{})};
  }
  function audioConversationSourcesCurrent(conversation, eventIndex, mediaIndex) {
    return liveConversationTurns(conversation).filter(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript')
      .every(turn => ['machine_transcribed', 'user_edited'].includes(turn.audio_source_status)
        ? audioConversationSourceCurrent(turn, eventIndex, mediaIndex, conversation.conversation_id, subjectOf(conversation))
        : audioReviewCurrent(turn, eventIndex, mediaIndex, conversation.conversation_id, subjectOf(conversation)));
  }
  function reconcileConversationAudioReview(conversation, events, mediaItems = null) {
    if (!conversation || !Array.isArray(events)) return conversation;
    const eventIndex = new Map(events.map(event => [event.record_id, event]));
    const mediaIndex = Array.isArray(mediaItems) ? new Map(mediaItems.map(item => [item.media_id, item])) : null;
    let changed = false;
    const turns = (conversation.turns || []).map(turn => {
      if (turn.role !== 'elder' || turn.source_kind !== 'audio_transcript') return turn;
      const status = turn.audio_source_status;
      const managedStatus = ['machine_transcribed', 'user_edited'].includes(status);
      if (!managedStatus && turn.audio_source_reviewed !== true) return turn;
      const current = managedStatus
        ? Boolean(mediaIndex && audioConversationSourceBindingCurrent(turn, eventIndex, mediaIndex, conversation.conversation_id, subjectOf(conversation)))
        : audioReviewCurrent(turn, eventIndex, mediaIndex, conversation.conversation_id, subjectOf(conversation));
      if (current && turn.audio_source_invalidated !== true || !current && turn.audio_source_invalidated === true) return turn;
      changed = true;
      return { ...turn, audio_source_invalidated: !current };
    });
    if (!changed) return conversation;
    const updated = { ...conversation, turns };
    return { ...updated, report: buildConversationReport(updated, conversation.report) };
  }
  function excludeMockFacts(conversation) {
    if (!conversation || conversation.mock_facts_excluded || !conversation.turns?.some(mockSource)) return conversation;
    // Preserve the incident history, but invalidate clinical state derived from
    // a placeholder. The next real response rebuilds it from patient turns.
    const clean = { ...conversation, mock_facts_excluded: true,
      turns: conversation.turns.map(turn => mockSource(turn) ? { ...turn, is_mock: true } : turn),
      controller: openingConversationController(), completeness: null, relevant_health_context: [] };
    return { ...clean, report: buildConversationReport(clean, conversation.report) };
  }
  function pendingElderTurn(conversation) {
    const turns = liveConversationTurns(conversation);
    const latest = turns[turns.length - 1];
    if (turns.some(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript'
      && (turn.audio_source_invalidated === true || turn.audio_source_reviewed !== true
        && !['machine_transcribed', 'user_edited'].includes(turn.audio_source_status)))) return null;
    if (latest?.role === 'elder' && !mockSource(latest)) return latest;
    return latest?.role === 'assistant' && latest.ai_failed && turns.at(-2)?.role === 'elder' && !mockSource(turns.at(-2)) ? turns.at(-2) : null;
  }
  async function withLocalLock(name, writes, task) {
    if (globalThis.navigator?.locks?.request) {
      return globalThis.navigator.locks.request(name, task);
    }
    const prior = writes.get(name) || Promise.resolve();
    const pending = prior.catch(() => {}).then(task);
    writes.set(name, pending);
    try { return await pending; }
    finally { if (writes.get(name) === pending) writes.delete(name); }
  }
  async function withConversationLock(conversationId, task) {
    return withLocalLock(`bingli-conversation:${conversationId}`, conversationWrites, task);
  }
  async function withEventLock(recordId, task) {
    return withLocalLock(`bingli-event:${recordId}`, eventWrites, task);
  }
  async function withMediaLock(mediaId, task) {
    return withLocalLock(`bingli-media:${mediaId}`, mediaWrites, task);
  }
  async function withMediaLocks(mediaIds, task) {
    const ids = [...new Set(mediaIds.filter(Boolean))].sort();
    const run = index => index >= ids.length ? task() : withMediaLock(ids[index], () => run(index + 1));
    return run(0);
  }
  async function audioRecognitionInFlight() {
    if (localAudioRecognitionScopes > 0) return true;
    const locks = globalThis.navigator?.locks;
    if (!locks) return false;
    if (typeof locks.query === 'function') {
      try {
        const state = await locks.query();
        if ([...(state.held || []), ...(state.pending || [])].some(lock => lock.name === AUDIO_RECOGNITION_LOCK)) return true;
        return false;
      } catch { /* Fall through to a non-blocking lock probe. */ }
    }
    if (typeof locks.request !== 'function') return true;
    try {
      let acquired = false;
      await locks.request(AUDIO_RECOGNITION_LOCK, { ifAvailable: true }, lock => { acquired = Boolean(lock); });
      return !acquired;
    } catch { return true; }
  }
  async function withEventLocks(recordIds, task) {
    const ids = [...new Set(recordIds.filter(Boolean))].sort();
    const run = index => index >= ids.length ? task() : withEventLock(ids[index], () => run(index + 1));
    return run(0);
  }
  async function withConversationLocks(conversationIds, task) {
    const ids = [...new Set(conversationIds.filter(Boolean))].sort();
    const run = index => index >= ids.length ? task() : withConversationLock(ids[index], () => run(index + 1));
    return run(0);
  }
  async function conversationsUsingRecords(recordIds) {
    const ids = new Set(recordIds);
    const owners = new Set((await Promise.all(recordIds.map(readEvent))).map(event => event?.source_conversation_id).filter(Boolean));
    return (await listConversations()).filter(conversation => owners.has(conversation.conversation_id)
      || conversation.turns.some(turn => turn.role === 'elder' && ids.has(turn.record_id)));
  }
  function linkedSourceConflict() {
    return fail(409, 'conversation_source_changed', {
      message: '这条原话仍属于一段对话，请在历史对话中删除整段对话，避免报告失去来源。',
    });
  }

  function validLocalDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
  function currentLocalDate() {
    const date=new Date();
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  async function listConversations() {
    const values = await vault.list('conversation:');
    const [currentContext, events, mediaItems] = await Promise.all([healthContext(), listEvents(), mediaList()]);
    return (await Promise.all(values.filter(item => item?.conversation_id && subjectOf(item) === currentContext.subject_id)
      .map(item => conversationWithCurrentReport(reconcileConversationAudioReview({ ...item, subject_id: subjectOf(item) }, events, mediaItems), currentContext, events, mediaItems))))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }
  function subjectOf(item) { return item?.subject_id || SELF_SUBJECT_ID; }
  function healthContextKey(subjectId) { return subjectId === SELF_SUBJECT_ID ? HEALTH_CONTEXT_KEY : `health-context:${subjectId}`; }
  async function healthSubjects() {
    const saved = await vault.get(HEALTH_SUBJECTS_KEY);
    if (saved) return saved;
    const initial = { version: 1, active_subject_id: SELF_SUBJECT_ID,
      subjects: [{ subject_id: SELF_SUBJECT_ID, label: '本人', relationship: 'self', created_at: now() }] };
    if (await vault.putIfUnchanged(HEALTH_SUBJECTS_KEY, undefined, initial)) return initial;
    return vault.get(HEALTH_SUBJECTS_KEY);
  }
  async function activeSubjectId(registry = null) {
    const current = registry || await healthSubjects();
    if (observedSubjectId === null) observedSubjectId = current.active_subject_id;
    if (observedSubjectId !== current.active_subject_id) throw new Error('subject_changed');
    return observedSubjectId;
  }
  async function checkSubjectBinding(options = {}, body = {}) {
    const registry = await healthSubjects(), subjectId = await activeSubjectId(registry);
    const header = name => typeof options.headers?.get === 'function' ? options.headers.get(name)
      : Object.entries(options.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const headerSubject = header('X-Health-Subject-Id'), headerVersion = header('X-Health-Subject-Version');
    if (headerSubject != null && headerSubject !== subjectId
      || Object.prototype.hasOwnProperty.call(body, 'subject_id') && body.subject_id !== subjectId) throw new Error('subject_mismatch');
    if (headerVersion != null && (!Number.isInteger(Number(headerVersion)) || Number(headerVersion) !== registry.version)
      || Object.prototype.hasOwnProperty.call(body, 'expected_subject_version')
        && (!Number.isInteger(body.expected_subject_version) || body.expected_subject_version !== registry.version)) throw new Error('stale_health_subjects');
    return registry;
  }
  async function ownedMutation(changes) {
    const registry = await healthSubjects();
    await activeSubjectId(registry);
    try {
      return await vault.mutate({ ...changes, unchanged: [...(changes.unchanged || []), { key: HEALTH_SUBJECTS_KEY, value: registry }] });
    } catch (error) {
      if (error.message === 'document_changed') {
        const current = await healthSubjects();
        if (current.active_subject_id !== observedSubjectId) throw new Error('subject_changed');
        if (JSON.stringify(current) !== JSON.stringify(registry)) throw new Error('stale_health_subjects');
      }
      throw error;
    }
  }
  async function ownedPut(key, value) { return ownedMutation({ puts: [{ key, value }] }); }
  function legacyHealthEntry(item, subjectId) {
    return { ...item, subject_id: subjectId, legacy_entry: true,
      temporal_status: item.temporal_status ?? null, confirmation_status: item.confirmation_status || (item.source === 'user_confirmed' ? 'confirmed' : 'unconfirmed'),
      confirmed_by: item.confirmed_by || 'self', occurred_on: item.occurred_on || null,
      recorded_at: item.recorded_at || item.confirmed_at || item.updated_at || null,
      confirmed_at: item.confirmed_at || null, updated_at: item.updated_at || null,
      remember: item.remember === true, source_kind: item.source_kind || 'self_statement' };
  }
  async function healthContext(subjectId = null) {
    const observed = await activeSubjectId();
    if (subjectId && subjectId !== observed) throw new Error('subject_mismatch');
    const selectedSubject = subjectId || observed;
    const key = healthContextKey(selectedSubject), saved = await vault.get(key);
    const result = saved || { version: 0, updated_at: null, entries: [] };
    return { ...result, subject_id: selectedSubject, entries: (result.entries || []).map(item =>
      item.subject_id && item.confirmation_status ? item : legacyHealthEntry(item, selectedSubject)) };
  }
  function usableHealthEntry(item, subjectId) {
    return item.subject_id === subjectId && item.confirmation_status === 'confirmed'
      && item.source === 'user_confirmed' && item.temporal_status !== 'uncertain';
  }
  function healthEntryPayload(item) {
    const { legacy_entry, ...payload } = item;
    if (legacy_entry && payload.temporal_status == null) delete payload.temporal_status;
    return payload;
  }
  function normaliseHealthContext(body, previous) {
    const prior = new Map((previous?.entries || []).map(item => [`${item.category}\n${item.text}`, item]));
    const entries = [];
    for (const [category, values] of Object.entries(body?.fields || {})) {
      if (!HEALTH_CATEGORIES.has(category)) continue;
      const lines = (Array.isArray(values) ? values : String(values || '').split(/\n+/)).map(value => String(value || '').trim()).filter(Boolean);
      if (lines.length > 12) throw new Error('health_context_too_many');
      for (const text of lines) {
        if (text.length > 500) throw new Error('health_context_text_too_long');
        const old = prior.get(`${category}\n${text}`);
        entries.push(legacyHealthEntry({ context_id: old?.context_id || id('context'), category, text, source: 'user_confirmed',
          confirmed_at: old?.confirmed_at || now(), recorded_at: old?.recorded_at || now(), updated_at: now() }, previous.subject_id));
      }
    }
    if (entries.length > 30) throw new Error('health_context_too_many');
    return { version: (previous?.version || 0) + 1, subject_id: previous.subject_id, updated_at: now(), entries };
  }
  function memoryEntry(input, subjectId, previous = null) {
    const fields = ['category', 'text', 'temporal_status', 'confirmation_status', 'confirmed_by', 'occurred_on', 'remember', 'source_kind'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
      || !HEALTH_CATEGORIES.has(input.category) || typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 500
      || !['current', 'historical', 'uncertain'].includes(input.temporal_status)
      || !['confirmed', 'unconfirmed'].includes(input.confirmation_status) || !['self', 'family'].includes(input.confirmed_by)
      || !['self_statement', 'family_report', 'document'].includes(input.source_kind) || typeof input.remember !== 'boolean'
      || !(input.occurred_on === null || validLocalDate(input.occurred_on)
        && Number.isFinite(Date.parse(`${input.occurred_on}T00:00:00Z`))
        && new Date(`${input.occurred_on}T00:00:00Z`).toISOString().slice(0, 10) === input.occurred_on
        && input.occurred_on <= now().slice(0, 10))) {
      throw new Error('health_memory_invalid');
    }
    if (input.remember && (input.confirmation_status !== 'confirmed' || input.temporal_status === 'uncertain')) throw new Error('health_memory_remember_invalid');
    const time = now(), confirmed = input.confirmation_status === 'confirmed';
    const sameConfirmedSource = confirmed && previous?.confirmation_status === 'confirmed'
      && previous.source === 'user_confirmed' && previous.category === input.category
      && previous.text === input.text.trim() && previous.temporal_status === input.temporal_status
      && previous.confirmed_by === input.confirmed_by && previous.occurred_on === input.occurred_on
      && previous.source_kind === input.source_kind;
    return { context_id: previous?.context_id || id('context'), subject_id: subjectId, ...input, text: input.text.trim(),
      source: confirmed ? 'user_confirmed' : 'user_unconfirmed', recorded_at: previous?.recorded_at || time,
      confirmed_at: confirmed ? (sameConfirmedSource ? previous.confirmed_at || time : time) : null, updated_at: time };
  }
  async function saveHealthMemory(previous, saved, registry, legacyCompatibility = false) {
    if (await activeSubjectId() !== previous.subject_id) throw new Error('subject_mismatch');
    const key = healthContextKey(previous.subject_id), rawPrevious = await vault.get(key);
    if (Number(rawPrevious?.version || 0) !== previous.version) return false;
    const puts = [{ key, value: saved }], unchanged = [{ key, value: rawPrevious }, { key: HEALTH_SUBJECTS_KEY, value: registry }];
    const changed = new Set([...previous.entries, ...saved.entries].filter(item => {
      const old = previous.entries.find(value => value.context_id === item.context_id);
      const next = saved.entries.find(value => value.context_id === item.context_id);
      return JSON.stringify(old) !== JSON.stringify(next);
    }).map(item => item.context_id));
    for (const conversation of await vault.list('conversation:')) {
      if (!conversation?.conversation_id || subjectOf(conversation) !== previous.subject_id) continue;
      if (!(conversation.selected_context_ids || []).some(value => changed.has(value))
        && !(conversation.health_context || []).some(item => changed.has(item.context_id))) continue;
      const selected = (conversation.selected_context_ids || []).filter(value => !changed.has(value));
      const staleSources = invalidatedRespondingSources(conversation, changed);
      const clean = { ...conversation, subject_id: previous.subject_id, selected_context_ids: selected,
        stale_responding_to_turn_ids: staleSources,
        health_context: saved.entries.filter(item => selected.includes(item.context_id) && usableHealthEntry(item, previous.subject_id)),
        health_context_version: saved.version, relevant_health_context: [], completeness: null, analysis_sources: null,
        controller: invalidateContextController(conversation, changed, staleSources),
        version: legacyCompatibility ? conversation.version : conversation.version + 1, updated_at: now() };
      // Historical assistant nominations retain their immutable source receipt
      // on the old form's compatibility route. They are explicitly out of the
      // current scope; current background caches and clinical state are cleared.
      clean.report = conversation.report ? await buildCurrentConversationReport(clean,
        legacyCompatibility ? conversation.report : { ...conversation.report, question_coverage: null }, saved) : null;
      const history=reportHistoryIncluding(conversation.report_history,conversation.report,clean.report).map(report=>removeRevokedContextFromReport(report,changed));
      if(history.length)clean.report_history=history;
      puts.push({ key: conversationKey(conversation.conversation_id), value: clean });
      unchanged.push({ key: conversationKey(conversation.conversation_id), value: conversation });
    }
    try { await vault.mutate({ puts, unchanged }); return true; }
    catch (error) { if (error.message === 'document_changed') return false; throw error; }
  }
  async function healthMemoryRequest(path, options) {
    const method = options.method || 'GET', body = parseBody(options), registry = await healthSubjects();
    if (path === '/api/health-subjects') {
      if (method === 'GET') {
        if (observedSubjectId === null) observedSubjectId = registry.active_subject_id;
        return ok(200, { ok: true, ...registry, observed_subject_id: observedSubjectId });
      }
      if (method !== 'POST') return fail(404, 'not_found');
      await checkSubjectBinding(options, body);
      if (!Number.isInteger(body.expected_version) || body.expected_version !== registry.version) return fail(409, 'stale_health_subjects');
      if (typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 80 || !['self', 'family'].includes(body.relationship)
        || registry.subjects.length >= 12) return fail(400, 'health_subject_invalid');
      const updated = { ...registry, version: registry.version + 1, subjects: [...registry.subjects,
        { subject_id: id('subject'), label: body.label.trim(), relationship: body.relationship, created_at: now() }] };
      return await vault.putIfUnchanged(HEALTH_SUBJECTS_KEY, registry, updated)
        ? ok(201, { ok: true, ...updated, observed_subject_id: observedSubjectId }) : fail(409, 'stale_health_subjects');
    }
    if (path === '/api/health-subjects/active' && method === 'POST') {
      if (!Number.isInteger(body.expected_version) || body.expected_version !== registry.version) return fail(409, 'stale_health_subjects');
      if (!registry.subjects.some(item => item.subject_id === body.subject_id)) return fail(404, 'health_subject_not_found');
      if (pendingLocalOperations > 1) return fail(409, 'local_operations_busy');
      const updated = { ...registry, active_subject_id: body.subject_id, version: registry.version + 1 };
      if (!await vault.putIfUnchanged(HEALTH_SUBJECTS_KEY, registry, updated)) return fail(409, 'stale_health_subjects');
      observedSubjectId = updated.active_subject_id;
      return ok(200, { ok: true, ...updated, observed_subject_id: observedSubjectId });
    }
    if (body.subject_id && body.subject_id !== registry.active_subject_id) return fail(403, 'subject_mismatch');
    const current = await healthContext(registry.active_subject_id);
    if (method === 'GET' && path === '/api/health-memory') return ok(200, { ok: true, subject_id: current.subject_id, health_context: current });
    if (!Number.isInteger(body.expected_version) || body.expected_version !== current.version) return fail(409, 'stale_health_memory');
    const contextId = path.startsWith('/api/health-memory/') ? decodeURIComponent(path.slice('/api/health-memory/'.length)) : null;
    const previous = current.entries.find(item => item.context_id === contextId);
    if (contextId && !previous) return fail(404, 'health_memory_not_found');
    let entries;
    if (method === 'DELETE' && contextId) entries = current.entries.filter(item => item.context_id !== contextId);
    else if (method === 'POST' && path === '/api/health-memory' || method === 'PATCH' && contextId) {
      const entry = memoryEntry(body.entry, current.subject_id, previous);
      entries = previous ? current.entries.map(item => item.context_id === contextId ? entry : item) : [...current.entries, entry];
    } else return fail(404, 'not_found');
    if (entries.length > 30 || [...HEALTH_CATEGORIES].some(category => entries.filter(item => item.category === category).length > 12)) return fail(400, 'health_context_too_many');
    if (entries.filter(item => item.remember).length > 5) return fail(400, 'health_memory_remember_limit');
    const saved = { ...current, version: current.version + 1, updated_at: now(), entries };
    return await saveHealthMemory(current, saved, registry) ? ok(method === 'POST' ? 201 : 200, { ok: true, subject_id: current.subject_id, health_context: saved }) : fail(409, 'stale_health_memory');
  }
  function elderTurns(conversation) { return reportableConversationTurns(conversation).filter(turn => turn.role === 'elder' && !mockSource(turn)); }
  function latestEditableOwnTurn(conversation) {
    const latest = (conversation?.turns || []).filter(turn => turn.role === 'elder' && !turn.superseded
      && turn.audio_source_invalidated !== true && !mockSource(turn)).at(-1) || null;
    if (latest?.source_kind === 'audio_transcript' && latest.audio_source_reviewed !== true
      && !['machine_transcribed', 'user_edited'].includes(latest.audio_source_status)) return null;
    return latest;
  }
  function analysisSources(conversation, currentContext = null) {
    const selected = [...(conversation.selected_context_ids || [])].sort();
    const contexts = currentContext ? currentContext.entries.filter(item => selected.includes(item.context_id) && usableHealthEntry(item, subjectOf(conversation))) : conversation.health_context || [];
    return {
      turns: elderTurns(conversation).map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
      selected_context_ids: selected,
      context_version: selected.length ? currentContext?.version ?? conversation.health_context_version ?? null : 0,
      context: contexts.map(healthEntryPayload),
    };
  }
  function analysisSourcesCurrent(conversation, currentContext = null) {
    return Boolean(conversation.analysis_sources)
      && JSON.stringify(conversation.analysis_sources) === JSON.stringify(analysisSources(conversation, currentContext));
  }
  function invalidateChangedAnalysis(conversation, currentContext = null) {
    if (!conversation.completeness || analysisSourcesCurrent(conversation, currentContext)) return conversation;
    return { ...conversation, completeness: null, analysis_sources: null, relevant_health_context: [] };
  }
  function reportQuestionChunks(text) {
    return String(text || '').split(/(?<=[，,。；;！？!?])/u).filter(value => value.trim());
  }
  function reportQuestionStart(text) {
    const value = String(text || '');
    const explicitRequest = /(?:你(?:还)?记得|请(?:说说|讲讲|告诉|描述|解释|说明|帮我|问)|麻烦(?:你|帮我)|我想(?:知道|问)|想知道|能不能|可不可以)/u.exec(value);
    if (explicitRequest) return explicitRequest.index;
    // Bare imperatives are requests only at the clause opening (optionally
    // after a discourse particle); elsewhere they may describe who said what.
    const bareRequest = /^\s*(?:(?:也|再|还|然后|顺便|另外)\s*)?(?:告诉我|帮我|说说|讲讲|解释(?:一下)?|描述(?:一下)?)/u.exec(value);
    if (bareRequest) return bareRequest.index;
    const questionAddress = /(?:你(?:是否|会不会|要不要)|能不能|可不可以)/u.exec(value);
    if (questionAddress) return questionAddress.index;
    const ending = /(?:怎么办|什么时候|哪(?:天|年|月|次|个)|怎样|如何|什么(?:时候|原因|情况)|谁(?:提供|说)?|多久|多少|怎么)(?:的)?(?:[？?])?$/u.exec(value.trim());
    if (ending) return ending.index;
    const yesNo = /(?:吗|呢)\s*[？?]?$/u.exec(value.trim());
    if (yesNo) return yesNo.index;
    return /[？?]$/.test(value.trim()) ? 0 : -1;
  }
  function assertiveReportPrefix(text) {
    const value = String(text || '').trim();
    return Boolean(value) && !/^(?:嗯|啊|哦|好的|那个)[，,。；;\s]*$/u.test(value);
  }
  function questionOnlyReportSource(text) {
    const chunks = reportQuestionChunks(text), hasQuestion = chunks.some(chunk => reportQuestionStart(chunk) >= 0);
    if (!hasQuestion) return false;
    return !chunks.some(chunk => {
      const start = reportQuestionStart(chunk);
      if (/(?:吗|呢)\s*[？?]?$/u.test(chunk.trim())) return false;
      return assertiveReportPrefix(start < 0 ? chunk : chunk.slice(0, start));
    });
  }
  function reportQuestionText(text) {
    return reportQuestionChunks(text).some(chunk => reportQuestionStart(chunk) >= 0)
      || /(?:担心|害怕|会不会|要不要|怎么办|想知道)/.test(String(text || ''))
        && !REPORT_PATTERNS.main_complaint.test(String(text || ''));
  }
  function reportQuestionOverlaps(text, piece) {
    const value = String(text || ''), start = value.indexOf(piece);
    if (start < 0) return false;
    let offset = 0;
    for (const chunk of reportQuestionChunks(value)) {
      const chunkStart = offset, chunkEnd = offset + chunk.length;
      offset = chunkEnd;
      const cue = reportQuestionStart(chunk);
      if (cue < 0) continue;
      const requestStart = chunkStart + cue, end = start + piece.length;
      if (/(?:吗|呢)\s*[？?]?$/u.test(chunk.trim()) && start < chunkEnd && end > chunkStart) return true;
      if (start < chunkEnd && end > requestStart) return true;
      if (start >= chunkStart && start < requestStart
        && !assertiveReportPrefix(chunk.slice(0, cue))) return true;
    }
    return false;
  }
  function groundedReportSummary(item, conversation) {
    if (item?.status !== 'known' || typeof item.summary !== 'string' || !item.summary.trim()) return null;
    const turns = elderTurns(conversation), turnIds = item.evidence_turn_ids || [], contextIds = item.context_ids || [];
    if (!turnIds.length && !contextIds.length) return null;
    const sources = turnIds.map(value => turns.find(turn => turn.turn_id === value));
    const contexts = contextIds.map(value => (conversation.health_context || []).find(entry => entry.context_id === value));
    if ([...sources, ...contexts].some(value => !value)) return null;
    // Reuse only literal source pieces, preserving negation/uncertainty. The
    // backend owns category semantics; this is a second provenance check.
    const pieces = item.summary.split('；').map(value => value.trim()).filter(Boolean);
    const clauses = text => String(text).split(/[，。；！？,;!?\n]/).map(value => value.trim()).filter(Boolean);
    const qualified = /不是|没有|并非|否认|不记得|不清楚|不确定|无|未|没|不|可能|也许|好像|大概|如果|假如|担心|害怕|会不会|是否|要不要/;
    const correction = /^\s*(?:我(?:现在|目前)?|现在|目前)?(?:不是|并非|没有|否认|不再)(.+)$/;
    const allText = [...sources.map(turn => ({ text: turn.text, patientTurn: true })), ...contexts.map(entry => ({ text: entry.text, patientTurn: false }))];
    if (!pieces.length || pieces.some(piece => {
      const pieceClauses = clauses(piece);
      const literal = allText.some(({ text, patientTurn }) => {
        if (!String(text).includes(piece)) return false;
        if (patientTurn && reportQuestionOverlaps(text, piece)) return false;
        const sourceClauses = clauses(text);
        const start = String(text).indexOf(piece), before = String(text).slice(0, start).trimEnd(), after = String(text).slice(start + piece.length).trimStart();
        const sentenceBoundary = /[。；！？;!?\n]/;
        const wholeSentences = (!before || sentenceBoundary.test(before.at(-1)))
          && (!after || sentenceBoundary.test(piece.trimEnd().at(-1)) || sentenceBoundary.test(after[0]));
        // A continuous excerpt may span complete clauses. Exact clause
        // and sentence boundaries retain same-sentence qualifiers at either end.
        const completeExcerpt = wholeSentences && pieceClauses.length > 1 && sourceClauses.some((_, start) =>
          pieceClauses.every((clause, offset) => clause === sourceClauses[start + offset]));
        return completeExcerpt || !pieceClauses.length || sourceClauses.some(clause => clause.includes(piece.replace(/[，。；！？,;!?]+$/g, '')) &&
          [...clause.matchAll(new RegExp(qualified.source, 'g'))].every(match => piece.includes(match[0]))) || piece === String(text).trim();
      });
      if (!literal) return true;
      return sources.some(source => turns.slice(turns.indexOf(source) + 1).some(later => clauses(later.text).some(clause => {
        const rejected = clause.match(correction)?.[1]?.trim();
        return rejected && piece.includes(rejected);
      })));
    })) return null;
    const contextLabels = contexts.map(entry => `${entry.temporal_status === 'historical' ? '历史背景' : entry.temporal_status === 'current' ? '已确认背景' : '背景时间未核对'} · 发生日期 ${entry.occurred_on || '未提供'}`);
    const sourceLabel = sources.length ? `当前原话 ${sources.map(turn => turns.indexOf(turn) + 1).join('、')}` : '';
    const label = contexts.length ? (sources.length ? '原话与背景整理' : contextLabels.join('；')) : '当前整理';
    return { kind: 'summary', text: item.summary, tags: [`${label} · 待核对`],
      source_turn_ids: turnIds, source_context_ids: contextIds,
      source_versions: sources.map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
      source_label: [sourceLabel, ...contextLabels, '本人未核对'].filter(Boolean).join(' · ') };
  }
  function projectQuestionDerivedFacts(conversation) {
    const state = conversation?.completeness?.clinical_state;
    if (!state || typeof state !== 'object') return conversation;
    const turns = new Map(elderTurns(conversation).map(turn => [turn.turn_id, turn]));
    let changed = false;
    const clinical_state = { ...state };
    for (const [category, item] of Object.entries(state)) {
      if (item?.status !== 'known') continue;
      const sourceIds = Array.isArray(item.evidence_turn_ids) ? item.evidence_turn_ids : [];
      const requestIds = sourceIds.filter(turnId => {
        const turn = turns.get(turnId);
        return turn && (questionOnlyReportSource(turn.text) || reportQuestionOverlaps(turn.text, item.summary));
      });
      if (!requestIds.length) continue;
      changed = true;
      const candidate = { ...item, evidence_turn_ids: sourceIds.filter(turnId => !requestIds.includes(turnId)) };
      clinical_state[category] = groundedReportSummary(candidate, conversation) ? candidate : {
        ...item, status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [],
      };
    }
    return changed ? { ...conversation, completeness: { ...conversation.completeness, clinical_state } } : conversation;
  }
  function normalizeReportDisplay(report) {
    if (!report || !Array.isArray(report.sections)) return report;
    const sections = report.sections.map(section => ({ ...section, lines: (section.lines || []).map(line =>
      typeof line === 'string' ? line : { ...line, tags: [...(line.tags || [])] }) }));
    const list = value => Array.isArray(value) ? value : [];
    const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
    const addMetadata = (target, source) => {
      target.tags = unique([...list(target.tags), ...list(source.tags)]);
      target.clinical_categories = unique([...(target.clinical_categories || []), ...(source.clinical_categories || [])]);
      target.source_turn_ids = unique([...list(target.source_turn_ids), ...list(source.source_turn_ids)]);
      target.source_context_ids = unique([...list(target.source_context_ids), ...list(source.source_context_ids)]);
      target.source_versions = [...list(target.source_versions), ...list(source.source_versions)]
        .filter((item, index, all) => all.findIndex(other => other.turn_id === item.turn_id
          && other.version === item.version && other.quote === item.quote) === index);
      const labels = unique([target.source_label, source.source_label].filter(Boolean));
      if (labels.length) target.source_label = labels.join('；');
    };
    const contextStamp = (line, id) => {
      const source = line.source_context?.context_id === id ? line.source_context : null;
      const label = String(line.source_label || '');
      const date = source ? (source.occurred_on || '未提供') : label.match(/发生日期\s*([^·；]+)/)?.[1]?.trim();
      const status = source ? source.temporal_status : /历史背景/.test(label) ? 'historical'
        : /已确认背景/.test(label) ? 'current' : /背景时间未核对/.test(label) ? 'uncertain' : null;
      return date && status ? `${id}\n${date}\n${status}` : null;
    };
    // A confirmed health-context source and its report-only relevance summary
    // are different states, but the same source text should appear once.
    for (const contextSection of sections) for (const context of contextSection.lines.filter(line => line?.kind === 'context')) {
      if (!list(context.source_context_ids).length) continue;
      for (const summarySection of sections) for (let index = summarySection.lines.length - 1; index >= 0; index--) {
        const summary = summarySection.lines[index], ids = list(summary?.source_context_ids);
        const contextId = context.source_context_ids[0];
        const summaryStamp = contextStamp(summary, contextId), confirmedStamp = contextStamp(context, contextId);
        if (summary?.kind !== 'summary' || summary.text !== context.text || list(summary.source_turn_ids).length
          || ids.length !== 1 || ids[0] !== contextId || !summaryStamp || summaryStamp !== confirmedStamp) continue;
        const sourceLabel = context.source_label, reportLabel = summary.source_label;
        addMetadata(context, summary);
        context.source_label = [sourceLabel && `背景来源：${sourceLabel}`, reportLabel && `本报告关联尚待核对：${reportLabel}`].filter(Boolean).join('；');
        context.tags = unique([...list(context.tags), ...list(summary.tags).map(tag => tag.replace(/·\s*待核对$/, '· 本报告关联待核对'))]);
        summarySection.lines.splice(index, 1);
      }
    }
    const sourceKey = line => {
      const turns = list(line.source_turn_ids), contexts = list(line.source_context_ids);
      if (turns.length) {
        const versions = turns.map(id => (line.source_versions || []).filter(item => item.turn_id === id));
        if (versions.some(items => items.length !== 1 || !Number.isSafeInteger(items[0].version) || !items[0].quote)) return null;
        const contextStamps = contexts.map(id => contextStamp(line, id));
        if (contextStamps.some(stamp => !stamp)) return null;
        return JSON.stringify([versions.map(items => [items[0].turn_id, items[0].version, items[0].quote]).sort(),
          contextStamps.sort()]);
      }
      if (contexts.length && contexts.every(id => contextStamp(line, id))) return JSON.stringify([[], contexts.map(id => contextStamp(line, id)).sort()]);
      return null;
    };
    const splitPieces = text => String(text || '').match(/[^，,。；;！？!?\n]+[，,。；;！？!?]?|\n+/g) || [];
    const pieceKey = value => value.trim().replace(/[，,。；;！？!?]+$/g, '').trim();
    const sourcePieceCount = (line, key) => {
      const turnIds = list(line.source_turn_ids), contextIds = list(line.source_context_ids);
      const texts = list(line.source_versions).filter(item => turnIds.includes(item.turn_id) && typeof item.quote === 'string').map(item => item.quote);
      if (contextIds.includes(line.source_context?.context_id) && typeof line.source_context.text === 'string') texts.push(line.source_context.text);
      return texts.reduce((count, text) => count + splitPieces(text).filter(piece => pieceKey(piece) === key).length, 0);
    };
    const seen = new Map();
    for (const section of sections) {
      const keptLines = [];
      for (const line of section.lines) {
        if (!['summary', 'context'].includes(line?.kind) || typeof line.text !== 'string' || !sourceKey(line)) { keptLines.push(line); continue; }
        const source = sourceKey(line), kept = [];
        for (const piece of splitPieces(line.text)) {
          const key = pieceKey(piece);
          if (!key) { kept.push(piece); continue; }
          const identity = `${source}\n${key}`, prior = seen.get(identity);
          if (prior && sourcePieceCount(line, key) === 1) addMetadata(prior, line);
          else { if (!prior) seen.set(identity, line); kept.push(piece); }
        }
        if (kept.length) { line.text = kept.join(''); keptLines.push(line); }
      }
      section.lines = keptLines;
    }
    for (const section of sections) for (const line of section.lines) if (line.clinical_categories?.length > 1) {
      line.tags = unique([...list(line.tags), ...line.clinical_categories.map(category => REPORT_CATEGORY_LABELS[category])]);
    }
    return { ...report, sections };
  }
  function unclearAssociatedSymptoms(text) {
    const topic = '(?:别的|其他)(?:身体)?(?:变化|症状|表现)';
    const unknown = '(?:不清楚|不知道|不记得|不确定|记不清|说不清)';
    const withinClause = '[^，。；！？,;!?\\n]*';
    return new RegExp(`${topic}${withinClause}${unknown}|${unknown}${withinClause}${topic}`).test(text || '');
  }
  function reportTurnCategories(turn, state, conversation) {
    // Raw quotes can inherit a category only when that category's own current
    // summary passed the literal-source check. A rejected summary must not
    // keep its label alive through an evidence ID or a keyword fallback.
    return CLINICAL_CATEGORIES.filter(category => state?.[category]?.status === 'known'
      && state[category].evidence_turn_ids?.includes(turn.turn_id)
      && groundedReportSummary(state[category], conversation));
  }
  function reportSectionFor(categories, preferChief = false) {
    if (preferChief && categories.includes('main_complaint')) return 'chief_complaint';
    if (categories.includes('onset_course')) return 'onset_course';
    if (categories.some(category => ['relevant_history', 'prior_actions_results'].includes(category))) return 'background_actions';
    if (categories.some(category => ['symptom_character', 'aggravating_relieving', 'associated_symptoms', 'functional_impact'].includes(category))) return 'symptoms_impact';
    if (categories.includes('main_complaint')) return 'chief_complaint';
    return null;
  }
  const REPORT_MISSING_LABELS = {
    main_complaint: '最主要的不舒服和具体部位', onset_course: '开始时间及之后的变化',
    symptom_character: '具体感觉和严重程度', associated_symptoms: '是否同时出现其他身体变化',
    functional_impact: '对走路、睡眠、进食或自理的影响', relevant_history: '相关既往情况或相似经历',
    prior_actions_results: '已经采取的处理及结果',
  };
  function reportSourceQuotes(items, turns) {
    const byId = new Map(turns.filter(turn => !REPORT_META_MESSAGE.test(turn.text || '')).map(turn => [turn.turn_id, turn.text]));
    return [...new Set(items.flatMap(item => {
      const quotes = [...new Set((item.evidence_turn_ids || []).map(turnId => byId.get(turnId)).filter(Boolean))];
      return quotes.length >= 2 ? quotes : [];
    }))];
  }
  function explicitUnknownLines(conversation) {
    if (!analysisSourcesCurrent(conversation)) return [];
    const turns = elderTurns(conversation), contexts = conversation.health_context || [], lines = new Map();
    const uncertain = /不知道|不清楚|不记得|记不(?:太)?清|想不起来|不想说|不方便说|说不上来|不确定|不肯定|不敢肯定|拿不准|不太清楚|印象里|印象中/;
    for (const note of conversation.completeness?.unknowns || []) {
      const sources = [
        ...(note.evidence_turn_ids || []).map(id => ({ turn: turns.find(turn => turn.turn_id === id) })),
        ...(note.context_ids || []).map(id => ({ context: contexts.find(entry => entry.context_id === id) })),
      ];
      if (!sources.length || sources.some(source => !source.turn && !source.context)) continue;
      for (const { turn, context } of sources) {
        const source = turn || context;
        // Quote complete source sentences; never turn the model's note into a fact.
        for (const sentence of String(source.text || '').match(/[^。；！？.!?;\n]+[。；！？.!?;\n]?/g) || []) {
          const text = sentence.trim();
          if (!uncertain.test(text)) continue;
          const line = { kind: 'check', text, explicit_unknown: true, tags: ['原话中的不确定或未说明 · 待核实'],
            ...(turn ? { source_turn_ids: [turn.turn_id], source_versions: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
              source_label: `患者原话 ${turns.indexOf(turn) + 1} · 保留原话含义` }
              : { source_context_ids: [context.context_id], source_context: healthEntryPayload(context), source_label: '已确认背景原文 · 其中的不确定性仍保留' }) };
          lines.set(JSON.stringify([turn?.turn_id, context?.context_id, text]), line);
        }
      }
    }
    return [...lines.values()];
  }
  function safeReportQuestions(questions) {
    if (!Array.isArray(questions) || questions.length > 12) return [];
    return [...new Set(questions.filter(question => typeof question === 'string'
      && question.trim() && question.length <= 160
      && !/[<>\u0000-\u001f\u007f\u200b-\u200f\ufeff]/.test(question)
      && (question.match(/[?？]/g) || []).length === 1 && /[?？]$/.test(question.trim())
      && !unsafeAssistantText(question)).map(question => question.trim()))];
  }
  function questionText(text) {
    if (typeof text !== 'string' || (text.match(/[?？]/g) || []).length !== 1) return null;
    return safeReportQuestions([text.split(/[。！!\n]/).at(-1).trim()])[0] || null;
  }
  function answerQuestion(conversation, turn) {
    const index = conversation.turns.indexOf(turn), question = conversation.turns[index - 1];
    if (!question || question.role !== 'assistant' || question.ai_failed || mockSource(question)
      || !['ask', 'reply'].includes(question.action)
      || !Number.isSafeInteger(question.version) || question.version < 1
      || !Number.isSafeInteger(turn.version) || turn.version < 1
      || conversation.turns.filter(item => item.turn_id === turn.turn_id).length !== 1
      || conversation.turns.filter(item => item.turn_id === question.turn_id).length !== 1
      || turn.responding_to?.turn_id !== question.turn_id || turn.responding_to?.text !== question.text
      || (turn.responding_to_version ?? 1) !== question.version || unsafeAssistantText(question.text)) return null;
    const text = questionText(question.text);
    return text ? { question: text, current: !question.superseded && !(conversation.stale_responding_to_turn_ids || []).includes(question.turn_id),
      source: { turn_id: question.turn_id, version: question.version, quote: question.text } } : null;
  }
  function invalidatedRespondingSources(conversation, contextIds) {
    const invalidated = new Set(contextIds), stale = new Set(conversation.stale_responding_to_turn_ids || []);
    (conversation.turns || []).forEach((turn, index) => {
      if (turn.role !== 'assistant' || mockSource(turn)) return;
      const sources = Array.isArray(turn.model_context_ids) ? turn.model_context_ids : null;
      if (sources ? sources.some(id => invalidated.has(id)) : index > 0) stale.add(turn.turn_id);
    });
    return [...stale];
  }
  function invalidateContextController(conversation, contextIds, staleTurnIds = invalidatedRespondingSources(conversation, contextIds)) {
    const controller = conversation.controller;
    if (!controller || typeof controller !== 'object' || Array.isArray(controller)) return controller;
    const invalidated = new Set(contextIds), stale = new Set(staleTurnIds);
    const staleTurns = (conversation.turns || []).filter(turn => turn.role === 'assistant' && stale.has(turn.turn_id));
    const staleTexts = new Set(staleTurns.map(turn => turn.text).filter(value => typeof value === 'string'));
    const questionValue = item => typeof item === 'string' ? item
      : typeof item?.question === 'string' ? item.question : typeof item?.text === 'string' ? item.text : null;
    const questionLists = ['asked_questions', 'followup_questions', 'pending_followups'];
    const candidates = questionLists.flatMap(key => Array.isArray(controller[key]) ? controller[key].map(questionValue).filter(Boolean) : []);
    const staleQuestions = new Set(), currentQuestions = new Set();
    for (const turn of staleTurns) {
      const parsed = questionText(turn.text);
      if (parsed) staleQuestions.add(parsed);
      for (const question of candidates) if (turn.text.trim() === question.trim() || turn.text.trim().endsWith(question.trim())) staleQuestions.add(question);
    }
    for (const turn of (conversation.turns || []).filter(item => item.role === 'assistant' && !stale.has(item.turn_id) && !item.superseded)) {
      const parsed = questionText(turn.text);
      if (parsed) currentQuestions.add(parsed);
      for (const question of candidates) if (turn.text?.trim() === question.trim() || turn.text?.trim().endsWith(question.trim())) currentQuestions.add(question);
    }
    const contextLinked = (controller.linked_context_ids || []).some(id => invalidated.has(id));
    const filterQuestions = list => Array.isArray(list) ? list.filter(item => {
      const question = questionValue(item);
      return !question || currentQuestions.has(question) || !staleQuestions.has(question) && !contextLinked;
    }) : list;
    const grounded = Array.isArray(controller.grounded_answers) ? controller.grounded_answers.filter(answer => {
      const respondingTo = answer?.responding_to, correctionTo = answer?.correction?.responding_to;
      const sourceTurn = (conversation.turns || []).find(turn => turn.turn_id === answer?.turn_id);
      const contextIds = [...(answer?.context_ids || []), ...(respondingTo?.context_ids || []), ...(correctionTo?.context_ids || [])];
      return !stale.has(respondingTo?.turn_id) && !stale.has(correctionTo?.turn_id)
        && !stale.has(sourceTurn?.responding_to?.turn_id)
        && !staleTexts.has(respondingTo?.text) && !staleTexts.has(correctionTo?.text)
        && !contextIds.some(id => invalidated.has(id));
    }) : controller.grounded_answers;
    const latestAssistant = [...(conversation.turns || [])].reverse().find(turn => turn.role === 'assistant' && !turn.superseded);
    return {
      ...controller,
      ...(Array.isArray(controller.asked_questions) ? { asked_questions: filterQuestions(controller.asked_questions) } : {}),
      ...(Array.isArray(controller.followup_questions) ? { followup_questions: filterQuestions(controller.followup_questions) } : {}),
      ...(Array.isArray(controller.pending_followups) ? { pending_followups: filterQuestions(controller.pending_followups) } : {}),
      ...(Array.isArray(controller.grounded_answers) ? { grounded_answers: grounded } : {}),
      ...(Array.isArray(controller.linked_context_ids) ? { linked_context_ids: controller.linked_context_ids.filter(id => !invalidated.has(id)) } : {}),
      ...(latestAssistant && stale.has(latestAssistant.turn_id) ? { last_question_category: null } : {}),
    };
  }
  const SHORT_ANSWER = /^(?:(?:我)?(?:不知道|不清楚|不确定|不记得)|没有|没|无|不是|有|是|有的)[。.!！\s]*$/;
  function shortAnswerSummary(text) {
    const parts = typeof text === 'string' ? text.split('；').map(value => value.trim()).filter(Boolean) : [];
    return parts.length > 0 && parts.every(value => SHORT_ANSWER.test(value));
  }
  const ANSWER_UNCLEAR = /不知道|不清楚|不确定|不记得|记不清|说不清|可能|也许|好像|大概|如果|假如|假设|万一|担心|害怕|不想说|不愿说|不方便说|拒绝|不回答|没(?:有)?回答|未回答|还没说|没(?:有)?告诉|未告诉|没(?:有)?说清|没(?:有)?提到|没(?:有)?说过|为什么问|问我|您问|你问|刚才说错|更正|纠正|[?？]/;
  const ANSWER_OTHER = /(?:妈妈|爸爸|母亲|父亲|家人|孩子|女儿|儿子|朋友|邻居|他|她|别人)/;
  const ANSWER_PAST = /以前|之前|曾经|过去|去年|前年|昨天|前天|上次|当时|小时候/;
  function presenceTopic(question) {
    const markers = question.match(/有没有|有无|是否有/g) || [];
    if (markers.length !== 1) return null;
    const topic = question.split(/有没有|有无|是否有/)[1]?.replace(/[?？]$/, '').replace(/的情况$/, '').trim();
    return topic && !/[、，,；;或和及与]/.test(topic) ? topic : null;
  }
  function currentAnswerClauses(text) {
    let otherSubject = false, past = false;
    const current = [];
    const clauses = (text.match(/[^，。；！？,;!?\n]+[！？!?]?/g) || []).flatMap(value => value.split(/但是|可是|不过|但/));
    for (let clause of clauses) {
      clause = clause.trim().replace(/^纯虚构[:：]\s*/, '').replace(/[！!]+$/, '');
      if (!clause) continue;
      if (ANSWER_OTHER.test(clause)) otherSubject = true;
      if (ANSWER_PAST.test(clause)) past = true;
      if (/^(?:我(?:现在|目前|今天)|(?:现在|目前|今天)我)/.test(clause)
        && !ANSWER_OTHER.test(clause) && !ANSWER_PAST.test(clause)) { otherSubject = false; past = false; }
      if (!otherSubject && !past) current.push(clause);
    }
    return current;
  }
  function rawAddressesQuestion(conversation, turn, question) {
    if (typeof turn.text !== 'string' || !Number.isSafeInteger(turn.version) || turn.version < 1
      || conversation.turns.filter(item => item.turn_id === turn.turn_id).length !== 1) return null;
    const bound = answerQuestion(conversation, turn);
    if (/^(?:没有|没|无|不是|有|是|有的)[。.!！\s]*$/.test(turn.text)) {
      return bound?.current && bound.question === question ? 'actual_single_question_answer' : null;
    }
    const topic = presenceTopic(question);
    if (!topic) return null;
    // This is literal conversation coverage, not symptom interpretation. Topics
    // come from the saved question; no disease vocabulary or synonyms are used.
    for (const clause of currentAnswerClauses(turn.text)) {
      const selfCurrent = /^(?:我(?:现在|目前|今天)|(?:现在|目前|今天)我)/.test(clause);
      if (!clause.includes(topic) || ANSWER_UNCLEAR.test(clause)) continue;
      const before = clause.slice(0, clause.indexOf(topic)), after = clause.slice(clause.indexOf(topic) + topic.length);
      if (/^(?:(?:我(?:现在|目前|今天)?|(?:现在|目前|今天)(?:我)?)?(?:还|也|确实)?(?:没有|没|无|不是))$/.test(before)
        && /^(?:了|的情况)?$/.test(after)) return 'literal_current_answer';
      if (selfCurrent && /^(?:我(?:现在|目前|今天)|(?:现在|目前|今天)我)(?:还|也|确实)?$/.test(before)
        && /^(?:了|的情况)?$/.test(after)) return 'literal_current_answer';
    }
    return null;
  }
  function coverageSources(conversation, currentContext = null) {
    return { ...analysisSources(conversation, currentContext),
      turns: elderTurns(conversation).map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text,
        responding_to: turn.responding_to ? { turn_id: turn.responding_to.turn_id, text: turn.responding_to.text } : null,
        responding_to_version: turn.responding_to_version ?? null })),
      questions: conversation.turns.filter(turn => turn.role === 'assistant' && !mockSource(turn)).map(turn => ({
        turn_id: turn.turn_id, version: turn.version, quote: turn.text, action: turn.action,
        superseded: Boolean(turn.superseded), ai_failed: Boolean(turn.ai_failed) })),
      episode: conversation.active_episode_start_turn_id || null };
  }
  function safeQuestionNomination(origin) {
    const source = item => item && typeof item.turn_id === 'string' && item.turn_id.trim()
      && Number.isSafeInteger(item.version) && item.version > 0 && typeof item.quote === 'string'
      && item.quote.trim() && item.quote.length <= 10000;
    return Boolean(origin && typeof origin === 'object' && !Array.isArray(origin)
      && (origin.assistant_source === null || source(origin.assistant_source))
      && Array.isArray(origin.patient_sources) && origin.patient_sources.length > 0 && origin.patient_sources.length <= 40
      && origin.patient_sources.every(source)
      && new Set(origin.patient_sources.map(item => item.turn_id)).size === origin.patient_sources.length
      && Array.isArray(origin.selected_context_ids) && origin.selected_context_ids.length <= 5
      && origin.selected_context_ids.every(value => typeof value === 'string')
      && Array.isArray(origin.context) && origin.context.length <= 5
      && (origin.episode === null || typeof origin.episode === 'string')
      && typeof origin.origin_verified === 'boolean');
  }
  function questionCoverage(conversation, previous = null, currentContext = null) {
    const sources = coverageSources(conversation, currentContext), candidates = [];
    const prior = previous?.question_coverage;
    if (prior?.format_version === 1 && prior.conversation_id === conversation.conversation_id && Array.isArray(prior.candidates)
      && prior.candidates.length <= 12) for (const item of prior.candidates) {
      if (safeReportQuestions([item?.question]).length && safeQuestionNomination(item.nomination)
        && !candidates.some(candidate => candidate.question === item.question.trim())) {
        candidates.push({ question: item.question.trim(), nomination: item.nomination });
      }
    }
    const bound = Boolean(conversation.completeness && analysisSourcesCurrent(conversation, currentContext));
    const proposed = safeReportQuestions(conversation.controller?.followup_questions);
    if (bound) proposed.push(...safeReportQuestions(conversation.completeness?.pending_questions));
    const first = conversation.turns.find(turn => turn.role === 'assistant' && !turn.superseded && !turn.ai_failed && !mockSource(turn)
      && Number.isSafeInteger(turn.version) && turn.version > 0
      && conversation.turns.filter(item => item.turn_id === turn.turn_id).length === 1
      && ['ask', 'reply'].includes(turn.action) && proposed.includes(questionText(turn.text)));
    for (const question of [...new Set(proposed)]) {
      if (candidates.some(item => item.question === question) || candidates.length === 12) continue;
      const before = first ? conversation.turns.indexOf(first) : conversation.turns.length;
      candidates.push({ question, nomination: {
        assistant_source: first ? { turn_id: first.turn_id, version: first.version, quote: first.text } : null,
        patient_sources: elderTurns(conversation).filter(turn => conversation.turns.indexOf(turn) < before)
          .map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
        selected_context_ids: sources.selected_context_ids, context_version: sources.context_version, context: sources.context,
        episode: sources.episode, origin_verified: bound && Boolean(first),
      } });
    }
    const resolved = [], scopeChanged = [];
    for (const item of candidates) {
      const origin = item.nomination, assistant = conversation.turns.find(turn => turn.turn_id === origin.assistant_source?.turn_id);
      const current = origin.origin_verified === true && assistant?.role === 'assistant' && !mockSource(assistant)
        && !assistant.superseded && !assistant.ai_failed && ['ask', 'reply'].includes(assistant.action)
        && Number.isSafeInteger(assistant.version) && assistant.version > 0
        && conversation.turns.filter(turn => turn.turn_id === assistant.turn_id).length === 1
        && candidates.some(candidate => candidate.question === questionText(assistant.text))
        && safeQuestionNomination(origin)
        && assistant.version === origin.assistant_source.version && assistant.text === origin.assistant_source.quote
        && origin.patient_sources.every(source => elderTurns(conversation).some(turn => turn.turn_id === source.turn_id
          && turn.version === source.version && turn.text === source.quote
          && conversation.turns.filter(item => item.turn_id === turn.turn_id).length === 1
          && conversation.turns.indexOf(turn) < conversation.turns.indexOf(assistant)))
        && JSON.stringify([origin.selected_context_ids, origin.context_version, origin.context, origin.episode])
          === JSON.stringify([sources.selected_context_ids, sources.context_version, sources.context, sources.episode]);
      if (!current) { scopeChanged.push(item.question); continue; }
      // Later actual answers replace earlier coverage. An unknown/correction
      // mentioning this topic conservatively reopens it rather than reusing No.
      let evidence = null;
      const topic = presenceTopic(item.question);
      for (const turn of elderTurns(conversation)) {
        if (conversation.turns.indexOf(turn) <= conversation.turns.indexOf(assistant)) continue;
        const method = rawAddressesQuestion(conversation, turn, item.question);
        if (method) evidence = { question: item.question, method,
          answer_source: { turn_id: turn.turn_id, version: turn.version, quote: turn.text },
          question_source: method === 'actual_single_question_answer' ? answerQuestion(conversation, turn).source : null };
        else {
          const clauses = currentAnswerClauses(turn.text), question = answerQuestion(conversation, turn);
          if (clauses.some(clause => ANSWER_UNCLEAR.test(clause) && (topic && clause.includes(topic)
            || question?.current && question.question === item.question))) evidence = null;
        }
      }
      if (evidence) resolved.push(evidence);
    }
    // A current backend analysis owns normal (including complex) answer
    // semantics. This limited literal receipt proves engineering coverage only;
    // it derives the fallback list when that clinical analysis is unavailable.
    const pending = bound ? safeReportQuestions(conversation.completeness?.pending_questions)
      : candidates.filter(item => !resolved.some(answer => answer.question === item.question)).map(item => item.question);
    return { format_version: 1, kind: 'assistant_question_coverage_not_clinical_facts', conversation_id: conversation.conversation_id,
      sources, candidates, resolved_questions: resolved, historical_scope_questions: scopeChanged, pending_questions: pending };
  }
  function correctedPendingSourceLines(conversation) {
    return elderTurns(conversation).map((turn, index) => ({ kind: 'quote', text: turn.text, tags: ['当前原话 · 待整理'],
      source_turn_ids: [turn.turn_id], source_versions: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
      source_label: `患者原话 ${index + 1} · 当前版本 · 待整理` }));
  }
  function unclassifiedReportLines(conversation) {
    if ((conversation.manual_corrections || []).length) return [];
    return elderTurns(conversation).flatMap((turn, index) => SHORT_ANSWER.test(turn.text) || REPORT_META_MESSAGE.test(turn.text || '')
      || questionOnlyReportSource(turn.text) ? [] : [{ kind: 'quote', text: turn.text,
        tags: ['患者原话', '未分类 · 待整理'], source_turn_ids: [turn.turn_id],
        source_versions: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
        source_label: `患者原话 ${index + 1} · 保留原文 · 未作医学分类` }]);
  }
  function answerContextLines(conversation) {
    return elderTurns(conversation).filter(turn => SHORT_ANSWER.test(turn.text)).flatMap(turn => {
      const bound = answerQuestion(conversation, turn);
      if (!bound) return [];
      const label = bound.current ? '助手实际问题 · 非患者陈述' : '助手历史问题 · 已失效 · 非患者陈述';
      return [
        { kind: 'check', text: bound.source.quote, answer_context_question: true, tags: [label],
          question_source: bound.source, source_label: `助手问题 ${bound.source.turn_id} · 第 ${bound.source.version} 版` },
        { kind: 'quote', text: turn.text, answer_context_answer: true, tags: ['患者原答 · 对应上方问题'],
          source_turn_ids: [turn.turn_id], source_versions: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
          question_source: bound.source, question_binding_current: bound.current,
          source_label: `患者原话 ${turn.turn_id} · 对应助手问题“${bound.question}”` },
      ];
    });
  }
  function pendingQuestionLines(conversation, coverage = questionCoverage(conversation, conversation.report)) {
    return coverage.pending_questions.map(question => ({
      kind: 'check', text: question, candidate_question: true,
      tags: [coverage.historical_scope_questions.includes(question) ? '助手历史候选 · 范围需重新核实' : '助手候选 · 待核实'],
      source_label: coverage.historical_scope_questions.includes(question)
        ? '历史助手候选，来源范围已变或未确认；不是当前患者事实，也未确认与当前主诉相关'
        : '助手提出的待核实问题，不是患者陈述',
    }));
  }
  function nonHealthReportLines(conversation, turns) {
    const lines = [];
    turns.forEach((turn, index) => {
      const source = { turn_id: turn.turn_id, version: turn.version, quote: turn.text };
      lines.push({ kind: 'quote', text: turn.text, tags: ['非医疗原话', '未作为健康事实'],
        source_turn_ids: [turn.turn_id], source_versions: [source],
        ...(turn.record_id ? { source_record_ids: [turn.record_id] } : {}),
        source_label: `患者原话 ${index + 1} · 后端当前标记为非医疗内容` });
      const nextElder = turns[index + 1];
      const turnPosition = conversation.turns.indexOf(turn);
      const nextPosition = nextElder ? conversation.turns.indexOf(nextElder) : Infinity;
      const reply = liveConversationTurns(conversation).find(candidate => candidate.role === 'assistant'
        && candidate.action === 'reply' && candidate.stop_reason === 'non_health_input' && !candidate.ai_failed
        && conversation.turns.indexOf(candidate) > turnPosition && conversation.turns.indexOf(candidate) < nextPosition);
      if (reply) lines.push({ kind: 'quote', text: reply.text, tags: ['助手回复'],
        source_turn_ids: [turn.turn_id], source_versions: [source],
        source_assistant_turn_ids: [reply.turn_id], source_label: `助手对患者原话 ${index + 1} 的回复` });
    });
    return lines;
  }
  function buildConversationReport(conversation, previous = null, currentContext = null, nonHealthOnly = false) {
    const turns = elderTurns(conversation);
    if (!turns.length) return null;
    const correctionPending = conversation.manual_correction_analysis_pending === true;
    const transcript = turns.map((turn, index) => `${index + 1}. ${turn.text}`);
    const state = conversation.completeness?.clinical_state || {};
    const grouped = [
      { key: 'chief_complaint', title: '主要不适', lines: [] },
      { key: 'onset_course', title: '起病与变化', lines: [] },
      { key: 'symptoms_impact', title: '症状特点与生活影响', lines: [] },
      { key: 'background_actions', title: '相关背景与已做处理', lines: [] },
      { key: 'patient_questions', title: '患者关心的问题', lines: [] },
    ];
    const appliedCorrections = conversation.manual_corrections || [];
    if (appliedCorrections.length) grouped.push({ key: 'correction_history', title: '使用者确认的原话修订（不代表医学结论）', lines: appliedCorrections.map(item => ({
      kind: 'check', text: `原句（第 ${item.target_version_before} 版）：“${item.old_quote}”\n本次修订后的原句（第 ${item.target_version_after} 版）：“${item.new_quote}”\n更正原文（第 ${item.correction_version} 版，作为历史保留）：“${item.correction_text}”\n这只记录使用者确认的文字修订，不代表医学判断。`,
      tags: ['使用者确认原话修订', '非医学结论'],
      source_turn_ids: [item.target_turn_id, item.correction_turn_id],
      source_versions: [
        { turn_id: item.target_turn_id, version: item.target_version_before, quote: item.old_quote },
        { turn_id: item.target_turn_id, version: item.target_version_after, quote: item.target_text_after },
        { turn_id: item.correction_turn_id, version: item.correction_version, quote: item.correction_text },
      ],
      source_label: `本机使用者确认记录 · ${item.confirmed_at}`,
    })) });
    if (correctionPending) grouped.push({ key: 'correction_pending_sources', title: '当前原话（待整理）', lines: correctedPendingSourceLines(conversation) });
    if (nonHealthOnly && !correctionPending) grouped.push({ key: 'source_record', title: '原话记录', lines: [] });
    const boundAnalysis = !correctionPending && analysisSourcesCurrent(conversation);
    if (!boundAnalysis && !nonHealthOnly && !correctionPending && !appliedCorrections.length) grouped.push({
      key: 'source_record', title: '患者原话（未分类 · 待整理）', lines: [],
    });
    const bySection = new Map(grouped.map(section => [section.key, section]));
    const collectedCategories = new Set();
    let hasChiefComplaint = false;
    if (boundAnalysis) for (const category of CLINICAL_CATEGORIES) {
      const line = groundedReportSummary(state[category], conversation);
      if (!line) continue;
      const sectionKey = reportSectionFor([category], category === 'main_complaint');
      if (sectionKey) {
        collectedCategories.add(category);
        // Short replies keep their valid backend category, but their meaning
        // is displayed only with the actual question and patient original.
        if (!shortAnswerSummary(line.text)) bySection.get(sectionKey).lines.push({ ...line, clinical_categories: [category] });
      }
    }
    const hasCurrentSummary = grouped.some(section => section.lines.some(line => line.kind === 'summary'));
    const priorNonHealthRecord = (conversation.report?.sections || []).some(section =>
      section.key === 'source_record' && section.title === '原话记录');
    const boundUnclassifiedSources = boundAnalysis && !nonHealthOnly && !priorNonHealthRecord && !hasCurrentSummary
      ? unclassifiedReportLines(conversation).filter(line => {
        const turn = turns.find(item => item.turn_id === line.source_turn_ids[0]);
        return turn && !reportTurnCategories(turn, state, conversation).length;
      }) : [];
    if (boundUnclassifiedSources.length) {
      const section = { key: 'source_record', title: '患者原话（未分类 · 待整理）', lines: boundUnclassifiedSources };
      grouped.push(section);
      bySection.set(section.key, section);
    }
    if (!hasCurrentSummary) grouped.filter(section => !['patient_questions', 'source_record', 'correction_pending_sources', 'correction_history'].includes(section.key))
      .forEach(section => { section.title += '（原话历史 · 待核对）'; });
    turns.forEach((turn, index) => {
      if (nonHealthOnly) return;
      if (correctionPending) return;
      if (REPORT_META_MESSAGE.test(turn.text || '')) return;
      if (SHORT_ANSWER.test(turn.text)) return;
      if (reportQuestionText(turn.text)) {
        bySection.get('patient_questions').lines.push({ kind: 'quote', text: turn.text, tags: ['患者疑问'],
          source_turn_ids: [turn.turn_id], source_versions: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
          source_label: `患者原话 ${index + 1}` });
        if (questionOnlyReportSource(turn.text)) return;
      }
      if (hasCurrentSummary) return;
      if (!boundAnalysis) return;
      const categories = reportTurnCategories(turn, state, conversation);
      const sectionKey = reportSectionFor(categories, !hasChiefComplaint);
      if (!sectionKey) return;
      if (sectionKey === 'chief_complaint') hasChiefComplaint = true;
      const associatedUnclear = unclearAssociatedSymptoms(turn.text);
      categories.filter(category => category !== 'associated_symptoms' || !associatedUnclear)
        .forEach(category => collectedCategories.add(category));
      const redundantCategory = sectionKey === 'chief_complaint' ? 'main_complaint' : sectionKey === 'onset_course' ? 'onset_course' : null;
      bySection.get(sectionKey).lines.push({
        kind: 'quote', text: turn.text,
        tags: categories.filter(category => category !== redundantCategory).map(category => category === 'associated_symptoms' && associatedUnclear
          ? '其他身体变化未明确' : REPORT_CATEGORY_LABELS[category]).filter(Boolean).slice(0, 4),
        source_turn_ids: [turn.turn_id], source_versions: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
        source_label: `患者原话历史 ${index + 1} · 待核对`,
      });
    });
    if (nonHealthOnly && !correctionPending) {
      const sourceSection = bySection.get('source_record');
      sourceSection.lines.push(...nonHealthReportLines(conversation, turns));
    }
    if (!boundAnalysis && !nonHealthOnly && !correctionPending && !appliedCorrections.length) {
      bySection.get('source_record')?.lines.push(...unclassifiedReportLines(conversation));
    }
    for (const item of boundAnalysis ? conversation.relevant_health_context || [] : []) {
      bySection.get('background_actions').lines.push({
        kind: 'context', text: item.text, tags: ['用户已确认陈述', item.temporal_status === 'current' ? '当前' : item.temporal_status === 'historical' ? '历史' : '时间状态未核对'],
        source_context_ids: [item.context_id], source_context: healthEntryPayload(item),
        source_label: `${item.confirmed_by === 'family' ? '家属' : '本人'}确认 · ${item.source_kind === 'document' ? '资料陈述' : item.source_kind === 'family_report' ? '家属转述' : '本人陈述'} · 发生日期 ${item.occurred_on || '未提供'} · 记录 ${item.recorded_at || '日期未知'} · 非应用诊断`,
      });
      collectedCategories.add('relevant_history');
    }
    for (const category of CLINICAL_CATEGORIES) {
      if (boundAnalysis && state?.[category]?.status === 'declined') collectedCategories.add(category);
    }
    const urgentTurns = turns.filter(turn => turn.local_safety?.danger_detected);
    const reviewTurns = turns.filter(turn => turn.local_safety?.clinical_review_required);
    const missing = Object.entries(REPORT_MISSING_LABELS).filter(([category]) => !collectedCategories.has(category)).map(([, label]) => label);
    const riskLines = [];
    const reviewedRisks = liveConversationTurns(conversation).filter(turn => turn.role === 'assistant'
      && turn.reviewed_risk_validated === true && !turn.ai_failed
      && safety.reviewedRiskSourcesCurrent(turn.risk_assessment, turns)).map(turn => turn.risk_assessment);
    for (const assessment of reviewedRisks) riskLines.push({
      kind: 'alert', text: assessment.notice,
      tags: [assessment.level === 'urgent' ? '固定紧急提醒' : '固定尽快评估提醒'],
      source_turn_ids: [...new Set(assessment.sources.map(source => source.turn_id))],
      source_label: '版本化规则与当前原话已核对；临床能力未验收',
      risk_assessment: assessment,
    });
    if (urgentTurns.length) riskLines.push({
      kind: 'alert', text: '对应原话触发了本机紧急提醒，请优先核对。', tags: ['需优先查看'],
      source_turn_ids: urgentTurns.map(turn => turn.turn_id), source_label: '本机安全规则',
    });
    if (reviewTurns.length) riskLines.push({
      kind: 'check', text: '对应原话含有需要专业人员核对的线索。', tags: ['待专业核对'],
      source_turn_ids: reviewTurns.map(turn => turn.turn_id), source_label: '本机安全规则',
    });
    const contradictionNotes = boundAnalysis ? conversation.completeness?.contradictions || [] : [];
    if (conversation.manual_correction_analysis_pending === true) riskLines.push({
      kind: 'check', text: '使用者确认的原话修订已保存在本机。已有自动整理已失效；这里展示当前原话与修订历史，尚未重新整理。',
      tags: ['自动整理待更新'], source_label: '本次确认未调用模型',
    });
    for (const note of contradictionNotes.filter(item => item.text === UNRESOLVED_CORRECTION_NOTE)) {
      const sources = [...new Set(note.evidence_turn_ids || [])]
        .map(turnId => turns.find(turn => turn.turn_id === turnId))
        .filter(turn => turn && !REPORT_META_MESSAGE.test(turn.text || ''));
      if (sources.length) riskLines.push({
        kind: 'check',
        text: `${UNRESOLVED_CORRECTION_NOTE} ${sources.map(turn => `“${turn.text}”`).join('；')}`,
        tags: ['更正待核实'], source_turn_ids: sources.map(turn => turn.turn_id),
        source_label: '无法唯一对应旧原话；更正原文仍保留',
      });
    }
    const contradictionQuotes = reportSourceQuotes(
      contradictionNotes.filter(item => item.text !== UNRESOLVED_CORRECTION_NOTE), turns);
    if (contradictionQuotes.length) riskLines.push({
      kind: 'check', text: `这些原话可能有出入：${contradictionQuotes.map(text => `“${text}”`).join('；')}`,
      tags: ['原话有出入'], source_turn_ids: (conversation.completeness?.contradictions || []).flatMap(item => item.evidence_turn_ids || []),
      source_label: '请结合原话确认',
    });
    if (!nonHealthOnly) riskLines.push(...explicitUnknownLines(conversation));
    if (missing.length && !nonHealthOnly && !correctionPending) riskLines.push({
      kind: 'check', text: `尚未问清：${missing.join('、')}。`, tags: ['信息未完整'], source_label: '继续对话后会自动补充',
    });
    const coverage = questionCoverage(conversation, previous, currentContext);
    const answerLines = answerContextLines(conversation);
    if (answerLines.length) grouped.push({ key: 'answer_context', title: '原话与对应问题', lines: answerLines });
    const pendingLines = pendingQuestionLines(conversation, coverage);
    riskLines.push(...pendingLines);
    grouped.push({ key: 'verification', title: '尚待医生核实', lines: riskLines });
    const usefulSections = grouped.filter(section => section.lines.length);
    const displaySections = normalizeReportDisplay({ sections: usefulSections }).sections;
    const bodyParts = displaySections.map(section => `${section.title}\n${section.lines.map(line => `- ${line.tags?.length ? `${line.tags.join('、')}：` : ''}${line.text}`).join('\n')}`);
    bodyParts.push(`老人原话历史（按说话顺序完整保留）\n${transcript.join('\n')}`);
    return {
      report_id: previous?.report_id || id('report'),
      format_version: 5,
      title: '就诊沟通记录',
      status: 'auto_unreviewed',
      status_label: conversation.manual_correction_analysis_pending === true ? '原话已修订 · 自动整理待更新' : '自动整理 · 本人未核对',
      version: (previous?.version || 0) + 1,
      generated_at: now(),
      source_turn_ids: turns.map(turn => turn.turn_id),
      source_versions: turns.map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
      source_context_ids: correctionPending ? [] : conversation.completeness?.relevant_context_ids || [],
      pending_questions: pendingLines.map(line => line.text),
      question_coverage: coverage,
      manual_correction_analysis_pending: correctionPending,
      reviewed_risk_assessments: reviewedRisks,
      legacy_clinical_review_status: 'active_unvalidated',
      clinical_validation_status: 'not_verified_by_this_application',
      sections: usefulSections,
      transcript: reportableConversationTurns(conversation).filter(turn => !mockSource(turn)).map(turn => ({
        turn_id: turn.turn_id,
        role: turn.role,
        text: turn.text,
        source_kind: turn.source_kind || (turn.role === 'assistant' ? 'system' : 'elder'),
        ...(turn.source_kind === 'audio_transcript' ? { source_status: turn.audio_source_reviewed === true ? 'original_comparison' : turn.audio_source_status || 'legacy_unclassified',
          source_record_id: turn.record_id || null, source_record_version: turn.audio_source_version ?? null,
          source_media_id: turn.media_id || null, source_media_version: turn.audio_source_media_version ?? null,
          source_verified_by_user: turn.audio_source_reviewed === true } : {}),
        created_at: turn.created_at,
        version: turn.version,
      })),
      body: bodyParts.join('\n\n'),
      disclaimer: '用于和医生沟通，不是诊断，也不包含用药或治疗建议。',
    };
  }
  async function conversationWithCurrentReport(conversation, currentContext = null, events = null, mediaItems = null) {
    conversation = reconcileConversationAudioReview(conversation, events, mediaItems);
    conversation = excludeMockFacts(conversation);
    if (!conversation || !elderTurns(conversation).length) return conversation;
    currentContext = currentContext || await healthContext(subjectOf(conversation));
    const nonHealthOnly = await verifiedNonHealthOnlyReport(conversation, currentContext);
    const missingBinding = conversation.completeness && !conversation.analysis_sources;
    // Legacy data without a binding may retain only full historical quotes.
    let reportInput = missingBinding ? conversation : invalidateChangedAnalysis(conversation, currentContext);
    conversation = projectQuestionDerivedFacts(invalidateChangedAnalysis(conversation, currentContext));
    reportInput = missingBinding ? projectQuestionDerivedFacts(reportInput) : conversation;
    const correctionPending = conversation.manual_correction_analysis_pending === true;
    const staleRisk = (conversation.report?.reviewed_risk_assessments || [])
      .some(assessment => !safety.reviewedRiskSourcesCurrent(assessment, elderTurns(conversation)));
    const staleSources = JSON.stringify(conversation.report?.source_versions) !== JSON.stringify(analysisSources(conversation).turns);
    const currentTurns = elderTurns(conversation);
    const staleQuoteSources = conversation.report?.sections?.some(section => section.key !== 'source_record' && section.lines?.some(line => {
      if (line.kind !== 'quote') return false;
      if (!Array.isArray(line.source_turn_ids) || !line.source_turn_ids.length) return true;
      const sources = line.source_turn_ids.map(turnId => currentTurns.find(turn => turn.turn_id === turnId));
      if (sources.some(turn => !turn)) return true;
      return JSON.stringify(line.source_versions) !== JSON.stringify(sources.map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })))
        || sources.length === 1 && line.text !== sources[0].text
        || sources.some(turn => unclearAssociatedSymptoms(turn.text)) && line.tags?.includes(REPORT_CATEGORY_LABELS.associated_symptoms);
    }));
    const unboundSummary = !analysisSourcesCurrent(conversation, currentContext)
      && conversation.report?.sections?.some(section => section.lines?.some(line => line.kind === 'summary'));
    // Recheck the locally derived summary receipt, so a v5 cache produced by an
    // older literal guard cannot silently omit a currently grounded category.
    const expectedSummaries = !correctionPending && analysisSourcesCurrent(conversation, currentContext) ? CLINICAL_CATEGORIES.flatMap(category => {
      const line = groundedReportSummary(conversation.completeness?.clinical_state?.[category], conversation);
      const section = reportSectionFor([category], category === 'main_complaint');
      return line && section && !shortAnswerSummary(line.text) ? [JSON.stringify([section, { ...line, clinical_categories: [category] }])] : [];
    }).sort() : [];
    const priorNonHealthRecord = (conversation.report?.sections || []).some(section =>
      section.key === 'source_record' && section.title === '原话记录');
    const boundUnclassifiedSources = !nonHealthOnly && !priorNonHealthRecord && !correctionPending && analysisSourcesCurrent(conversation, currentContext)
      && !expectedSummaries.length ? unclassifiedReportLines(conversation).filter(line => {
        const turn = elderTurns(conversation).find(item => item.turn_id === line.source_turn_ids[0]);
        const state = conversation.completeness?.clinical_state || {};
        return turn && !reportTurnCategories(turn, state, conversation).length;
      }) : [];
    const cachedSummaryLines = (conversation.report?.sections || []).flatMap(section => (section.lines || [])
      .filter(line => line.kind === 'summary').map(line => [section.key, line]));
    const hasCachedCategories = cachedSummaryLines.length > 0 && cachedSummaryLines.every(([, line]) => Array.isArray(line.clinical_categories));
    const summarySnapshot = rows => rows.map(([key, line]) => {
      if (hasCachedCategories) return [key, line];
      const { clinical_categories, ...legacyLine } = line;
      return [key, legacyLine];
    }).map(row => JSON.stringify(row)).sort();
    const staleSummaries = JSON.stringify(summarySnapshot(expectedSummaries.map(JSON.parse)))
      !== JSON.stringify(summarySnapshot(cachedSummaryLines));
    const expectedCoverage = questionCoverage(conversation, conversation.report, currentContext);
    const expectedPending = pendingQuestionLines(conversation, expectedCoverage);
    const cachedPending = (conversation.report?.sections || []).flatMap(section => (section.lines || [])
      .filter(line => line.candidate_question === true).map(line => ({ section: section.key, line })));
    const stalePending = JSON.stringify(expectedPending.map(line => ({ section: 'verification', line }))) !== JSON.stringify(cachedPending)
      || JSON.stringify(conversation.report?.pending_questions || []) !== JSON.stringify(expectedPending.map(line => line.text));
    const staleCoverage = JSON.stringify(conversation.report?.question_coverage) !== JSON.stringify(expectedCoverage);
    const cachedAnswers = (conversation.report?.sections || []).flatMap(section => (section.lines || [])
      .filter(line => line.answer_context_question || line.answer_context_answer).map(line => ({ section: section.key, line })));
    const staleAnswers = JSON.stringify(answerContextLines(conversation).map(line => ({ section: 'answer_context', line }))) !== JSON.stringify(cachedAnswers);
    const cachedUnknowns = (conversation.report?.sections || []).flatMap(section => (section.lines || []).filter(line => line.explicit_unknown));
    const staleUnknowns = JSON.stringify(nonHealthOnly ? [] : explicitUnknownLines(conversation)) !== JSON.stringify(cachedUnknowns);
    const sourceRecord = conversation.report?.sections?.find(section => section.key === 'source_record');
    const pendingSourceSection = conversation.report?.sections?.find(section => section.key === 'correction_pending_sources');
    const staleCorrectionPending = correctionPending
      ? conversation.report?.manual_correction_analysis_pending !== true
        || pendingSourceSection?.title !== '当前原话（待整理）'
        || JSON.stringify(pendingSourceSection?.lines) !== JSON.stringify(correctedPendingSourceLines(conversation))
        || conversation.report?.sections?.some(section => ['chief_complaint', 'onset_course', 'symptoms_impact',
          'background_actions', 'patient_questions', 'source_record'].includes(section.key) && section.lines?.length)
        || conversation.report?.sections?.some(section => section.key === 'verification'
          && section.lines?.some(line => line.text?.startsWith('尚未问清：')))
      : conversation.report?.manual_correction_analysis_pending === true;
    const hasClinicalUnknowns = conversation.report?.sections?.some(section => section.key === 'verification'
      && section.lines?.some(line => line.text?.startsWith('尚未问清：')));
    const unboundChecklistText = !nonHealthOnly && !correctionPending && !(conversation.manual_corrections || []).length
      && !analysisSourcesCurrent(conversation, currentContext)
      ? `尚未问清：${Object.values(REPORT_MISSING_LABELS).join('、')}。` : null;
    const cachedChecklist = (conversation.report?.sections || []).flatMap(section => (section.lines || [])
      .filter(line => line.text?.startsWith('尚未问清：')).map(line => line.text));
    const staleUnboundChecklist = unboundChecklistText !== null
      && (cachedChecklist.length !== 1 || cachedChecklist[0] !== unboundChecklistText);
    const unclassifiedSources = unclassifiedReportLines(conversation);
    const boundUnclassifiedIds = new Set(boundUnclassifiedSources.flatMap(line => line.source_turn_ids || []));
    const staleBoundClassifiedQuotes = boundUnclassifiedIds.size > 0 && (conversation.report?.sections || []).some(section =>
      ['chief_complaint', 'onset_course', 'symptoms_impact', 'background_actions'].includes(section.key)
      && (section.lines || []).some(line => line.kind === 'quote'
        && (line.source_turn_ids || []).some(turnId => boundUnclassifiedIds.has(turnId))));
    const sourceRecordCurrent = correctionPending ? !sourceRecord : nonHealthOnly
      ? Boolean(sourceRecord && sourceRecord.title === '原话记录' && !hasClinicalUnknowns
        && sameAudioData(sourceRecord.lines || [], nonHealthReportLines(conversation, currentTurns)))
      : analysisSourcesCurrent(conversation, currentContext) && boundUnclassifiedSources.length
        ? Boolean(sourceRecord && sourceRecord.title === '患者原话（未分类 · 待整理）'
          && sameAudioData(sourceRecord.lines || [], boundUnclassifiedSources) && !staleBoundClassifiedQuotes)
      : !analysisSourcesCurrent(conversation, currentContext) && unclassifiedSources.length
        ? Boolean(sourceRecord && sourceRecord.title === '患者原话（未分类 · 待整理）'
          && sameAudioData(sourceRecord.lines || [], unclassifiedSources))
        : !sourceRecord;
    const staleUnboundClinicalFacts = !analysisSourcesCurrent(conversation, currentContext) && !nonHealthOnly && !correctionPending
      && !(conversation.manual_corrections || []).length
      && conversation.report?.sections?.some(section => ['chief_complaint', 'onset_course', 'symptoms_impact', 'background_actions'].includes(section.key)
        && section.lines?.some(line => ['quote', 'summary', 'context'].includes(line.kind)));
    if (conversation.report?.format_version === 5 && sourceRecordCurrent && !staleRisk && !staleSources && !staleQuoteSources && !unboundSummary && !staleSummaries && !staleUnboundClinicalFacts && !stalePending && !staleCoverage && !staleAnswers && !staleUnknowns && !staleUnboundChecklist && !staleCorrectionPending) return conversation;
    return { ...conversation, report: buildConversationReport(reportInput, conversation.report, currentContext, nonHealthOnly) };
  }
  function legacyReorganizationOutputCandidate(conversation) {
    const operation=conversation?.manual_correction_reorganization,turns=conversation?.turns||[];
    if(operation?.state!=='completed'||operation.operation_kind||operation.result_provenance||operation.legacy_reply_review
      ||!/^([a-f0-9]{64})$/.test(operation.scope_id||'')||!/^([a-f0-9]{64})$/.test(operation.body_sha256||'')
      ||(operation?.risk_assessment&&operation.risk_assessment.level!=='none')
      ||operation?.reviewed_risk_validated===true
      ||(conversation.report?.reviewed_risk_assessments||[]).length
      ||turns.some(turn=>turn.risk_assessment||turn.reviewed_risk_validated===true
        ||turn.local_safety?.danger_detected===true||turn.local_safety?.clinical_review_required===true
        ||['urgent','soon_evaluation'].includes(turn.local_safety?.risk_level||turn.local_safety?.escalation_level)))return null;
    const corrections=conversation.manual_corrections||[],latest=corrections.at(-1);
    if(!latest?.correction_turn_id)return null;
    const correctionIndex=turns.findIndex(turn=>turn.turn_id===latest.correction_turn_id&&turn.role==='elder');
    const confirmedAt=Date.parse(latest.confirmed_at||'');
    const target=turns.find(turn=>turn.turn_id===latest.target_turn_id&&turn.role==='elder'&&!turn.superseded);
    if(correctionIndex<0||!Number.isFinite(confirmedAt)||!target
      ||target.version!==latest.target_version_after||target.text!==latest.target_text_after
      ||turns.some(turn=>turn.role==='elder'&&!turn.superseded
        &&[turn.created_at,turn.edited_at].some(value=>{
          if(!value)return false;
          const time=Date.parse(value);
          return !Number.isFinite(time)||time>confirmedAt;
        })))return null;
    const candidates=turns.map((turn,index)=>({turn,index})).filter(item=>item.index>correctionIndex
      &&item.turn.role==='assistant'&&!item.turn.superseded&&!item.turn.ai_failed&&!mockSource(item.turn)
      &&typeof item.turn.text==='string'&&item.turn.text.trim()&&item.turn.text.length<=1000
      &&Number.isSafeInteger(item.turn.version)&&item.turn.version>0
      &&!item.turn.risk_assessment&&item.turn.reviewed_risk_validated!==true
      &&!['urgent','soon_evaluation'].includes(item.turn.risk_level||item.turn.action));
    if(candidates.length!==1)return null;
    const turn=candidates[0].turn,traceId=operation.trace_id||conversation.last_ai_metadata?.trace_id;
    const provider=operation.provider||conversation.last_ai_metadata?.provider;
    const createdAt=Date.parse(turn.created_at||'');
    if(!Number.isFinite(createdAt)||createdAt<=confirmedAt
      ||typeof traceId!=='string'||!traceId.trim()||typeof provider!=='string'||!provider.trim())return null;
    return {turn,trace_id:traceId,provider,scope_id:operation.scope_id,body_sha256:operation.body_sha256};
  }
  function projectLegacyReorganizationCandidate(candidate) {
    return candidate?{turn:{turn_id:candidate.turn.turn_id,version:candidate.turn.version,text:candidate.turn.text,created_at:candidate.turn.created_at},
      trace_id:candidate.trace_id,provider:candidate.provider,scope_id:candidate.scope_id,body_sha256:candidate.body_sha256}:null;
  }
  async function conversationArchiveView(conversation) {
    const legacyCandidate=legacyReorganizationOutputCandidate(conversation);
    const current = await conversationWithCurrentReport(conversation);
    const operation=current.manual_correction_reorganization;
    return {
      conversation_id: current.conversation_id,
      subject_id: subjectOf(current),
      local_date: current.local_date,
      last_local_date: current.last_local_date,
      created_at: current.created_at,
      updated_at: current.updated_at,
      status: current.status,
      version: current.version,
      new_text_trial: current.new_text_trial || null,
      report: current.report,
      report_history: Array.isArray(current.report_history)?current.report_history:[],
      manual_corrections:(current.manual_corrections||[]).map(item=>({correction_turn_id:item.correction_turn_id,target_turn_id:item.target_turn_id,
        target_version_after:item.target_version_after,target_text_after:item.target_text_after,confirmed_at:item.confirmed_at})),
      ...(operation?{manual_correction_reorganization:{state:operation.state||null,scope_id:operation.scope_id||null,body_sha256:operation.body_sha256||null,
        ...(CONVERSATION_FAILURE_CODES.has(operation.failure_code)?{failure_code:operation.failure_code}:{}),
        ...(storedProviderHttpStatus(operation.provider_http_status,operation.failure_code)?{provider_http_status:operation.provider_http_status}:{}),
        operation_kind:operation.operation_kind||null,result_provenance:operation.result_provenance||null,
        trace_id:operation.trace_id||null,provider:operation.provider||null,model_id:operation.model_id||null,
        source_binding:operation.source_binding?structuredClone(operation.source_binding):null,
        legacy_reply_review:operation.legacy_reply_review||null}}:{}),
      legacy_reorganization_candidate:projectLegacyReorganizationCandidate(legacyCandidate),
      last_ai_metadata:current.last_ai_metadata?{trace_id:current.last_ai_metadata.trace_id||null,provider:current.last_ai_metadata.provider||null,
        model_id:current.last_ai_metadata.model_id||null,prompt_version:current.last_ai_metadata.prompt_version||null}:null,
      legacy_reorganization_history:(current.turns||[]).filter(turn=>turn.legacy_reorganization_history?.kind==='legacy_corrected_reorganization_reply')
        .map(turn=>({turn_id:turn.turn_id,version:turn.version,text:turn.text,created_at:turn.created_at,
          trace_id:turn.legacy_reorganization_history.trace_id,provider:turn.legacy_reorganization_history.provider,
          confirmed_at:turn.legacy_reorganization_history.confirmed_at})),
      turns: liveConversationTurns(current).map(turn => {
        const errorCode = CONVERSATION_FAILURE_CODES.has(turn.error_code) ? turn.error_code : null;
        const providerStatus = storedProviderHttpStatus(turn.provider_http_status, errorCode);
        return ({
        turn_id: turn.turn_id,
        role: turn.role,
        text: turn.text,
        source_kind: turn.source_kind || (turn.role === 'assistant' ? 'system' : 'elder'),
        record_id: turn.record_id || null,
        media_id: turn.media_id || null,
        created_at: turn.created_at,
        edited_at: turn.edited_at || null,
        version: turn.version,
        versions: turn.versions || [],
        action: turn.action || null,
        ai_failed: turn.ai_failed === true,
        ...(errorCode ? { error_code: errorCode } : {}),
        ...(providerStatus ? { provider_http_status: providerStatus } : {}),
        is_mock: mockSource(turn),
        audio_source_reviewed: turn.audio_source_reviewed === true,
        audio_source_status: turn.audio_source_status || null,
        audio_source_invalidated: turn.audio_source_invalidated === true,
        audio_source_version: turn.audio_source_version || null,
        audio_source_media_version: turn.audio_source_media_version || null,
        audio_source_conversation_id: turn.audio_source_conversation_id || null,
        audio_source_conversation_version: turn.audio_source_conversation_version || null,
        audio_duration_seconds: Number.isInteger(turn.audio_duration_seconds) ? turn.audio_duration_seconds : null,
        local_safety: turn.local_safety || null,
      });
      }),
    };
  }
  async function conversationCurrentView(conversation, events = null, mediaItems = null) {
    const current = await conversationWithCurrentReport({ ...conversation, subject_id: subjectOf(conversation) },
      await healthContext(subjectOf(conversation)), events, mediaItems);
    const candidate = legacyReorganizationOutputCandidate(conversation);
    const history = (current.turns || []).filter(turn => turn.legacy_reorganization_history?.kind === 'legacy_corrected_reorganization_reply')
      .map(turn => ({ turn_id: turn.turn_id, version: turn.version, text: turn.text, created_at: turn.created_at,
        trace_id: turn.legacy_reorganization_history.trace_id, provider: turn.legacy_reorganization_history.provider,
        confirmed_at: turn.legacy_reorganization_history.confirmed_at }));
    const safeTurns=(current.turns||[]).map(turn=>{
      const errorCode=CONVERSATION_FAILURE_CODES.has(turn.error_code)?turn.error_code:null;
      const providerStatus=storedProviderHttpStatus(turn.provider_http_status,errorCode);
      return Object.fromEntries(Object.entries(turn).flatMap(([key,value])=>key==='error_code'
        ?(errorCode?[[key,errorCode]]:[]):key==='provider_http_status'?(providerStatus?[[key,providerStatus]]:[]):[[key,value]]));
    });
    const operation=current.manual_correction_reorganization;
    const safeOperation=operation?(()=>{
      const failureCode=CONVERSATION_FAILURE_CODES.has(operation.failure_code)?operation.failure_code:null;
      const providerStatus=storedProviderHttpStatus(operation.provider_http_status,failureCode);
      return Object.fromEntries(Object.entries(operation).flatMap(([key,value])=>key==='failure_code'
        ?(failureCode?[[key,failureCode]]:[]):key==='provider_http_status'?(providerStatus?[[key,providerStatus]]:[]):[[key,value]]));
    })():null;
    const projectedTurns=await Promise.all(safeTurns.map(async turn=>turn.quote_context?{...turn,
      quote_context_valid:await quoteContextCurrent(current,turn.quote_context)}:turn));
    return withSavedOnlyTextFirstSendState({ ...current, turns:projectedTurns,
      ...(safeOperation?{manual_correction_reorganization:safeOperation}:{}),
      ...(candidate ? { legacy_reorganization_candidate: projectLegacyReorganizationCandidate(candidate) } : {}),
      ...(history.length ? { legacy_reorganization_history: history } : {}) });
  }
  function unsafeAssistantText(text) {
    const value = String(text || '').normalize('NFKC').replace(/[\s\u200b-\u200f\ufeff]/g, '')
      .replace(/(?:我|小零)(?:不能|无法)(?:替您|为您)?(?:提供|作出|做出)?(?:诊断、用药或治疗建议|诊断|治疗建议|用药建议)/g, '能力边界')
      .replace(/(?:这份|这些)?(?:报告|记录)(?:不是|不代表)诊断/g, '记录用途')
      .replace(/(?:没|没有|尚未|还没|已经|曾经|以前|有没有|是否)(?:吃|服|用)(?:过)?药/g, '已核对既往用药')
      .replace(/(?:没|没有|尚未|还没|已经|曾经|以前|有没有|是否)做(?:过)?(?:任何)?(?:核磁|CT|彩超|B超|化验|检查)/gi, '已核对既往资料');
    const directInstruction = /(?:服用|口服|注射|吃|用)[^，。！？;；!?]{0,12}[0-9一二三四五六七八九十百两半]+(?:毫克|微克|克|毫升|片|粒|滴|单位|mg|mcg|ml)|(?:增加|减少|增至|减至|调整到|改为)[^，。！？;；!?]{0,8}[0-9一二三四五六七八九十百两半]+(?:毫克|微克|克|毫升|片|粒|滴|单位|mg|mcg|ml)|(?:建议|应该|应当|最好|可以|需要|请|先|直接|去)[^，。！？;；!?]{0,8}(?:血常规|血生化|心电图|脑电图|胃镜|肠镜|胸片|X光|MRI|CT|核磁|彩超|B超)|(?:您|你|情况|身体|目前|现在)[^，。！？;；!?]{0,8}(?:很安全|没有问题|没事)|没有.{0,3}(?:危险|风险)|(?:不用|无需|不需要|不必).{0,6}(?:就医|去医院|急救|120|看医生)/i;
    const diagnosis = /(?:您|你)(?:已经)?得了|(?:这是|就是|属于|判断为|表现为)[^，。！？;；!?]{0,16}(?:病|炎|症|癌|感染|梗|卒中|结石)(?=[，。！？;；!?]|$)/;
    return directInstruction.test(value) || diagnosis.test(value) || /诊断|确诊|患有|可能是|考虑为|怀疑是|建议|应该|应当|最好|就医|去医院|看医生|做检查|治疗|处方|剂量|药量|加药|减药|停药|换药|加量|减量|服药|吃药|改药|拨打120/.test(value);
  }
  function sourceSupportedVisitPhrase(sourceText) {
    const clean = value => String(value || '').normalize('NFKC').replace(/[\s\u200b-\u200f\ufeff]/g, '');
    const source = clean(sourceText);
    if (!source || /[?？“”‘’「」『』"']|如果|假如|要是|万一|倘若|假设/.test(source)
      || /(?:请你|请您|麻烦你|麻烦您|帮我|替我|回答我|告诉我|复述|说我).{0,18}还没/.test(source)
      || /(?:后来|之后|已经去|已经看|去过了|看过了)|(?:以前|曾经|过去|之前)[^，,。；;！!？?\n]{0,18}(?:看过|看医生|就医)|(?:看过医生|就医过)/.test(source)) return null;
    const clauses = source.split(/[，,、。；;！!？?\n]+/).filter(Boolean);
    return clauses.find(clause => /^我(?:目前)?(?:还没(?:有)?|尚未|暂时没有|目前没有)(?:去)?(?:看医生|就医)$/.test(clause)) || null;
  }
  function maskSourceSupportedVisitPhrase(text, sourceText) {
    const sourcePhrase = sourceSupportedVisitPhrase(sourceText);
    if (!sourcePhrase) return null;
    const clean = String(text || '').normalize('NFKC').replace(/[\s\u200b-\u200f\ufeff]/g, '');
    if (!clean || /[“”‘’「」『』"']|如果|假如|要是|万一|倘若|假设/.test(clean)) return null;
    const sourceClauses = String(sourceText || '').normalize('NFKC').replace(/[\s\u200b-\u200f\ufeff]/g, '')
      .split(/[，,、。；;！!？?\n]+/).filter(Boolean);
    const sourceVisitIndex = sourceClauses.indexOf(sourcePhrase);
    const nextSourceClause = sourceClauses[sourceVisitIndex + 1] || '';
    const noTreatmentSupported = /^(?:(?:我)(?:也)?|也)?(?:还没(?:有)?|没(?:有)?|尚未|暂时没有|目前没有)(?:做(?:过)?(?:别的|其他|任何)?处理|处理)$/.test(nextSourceClause);
    const visit = '(?:(?:您|你)(?:目前)?|目前(?:您|你)?)?(?:还没(?:有)?|尚未|暂时没有|目前没有)(?:去)?(?:看医生|就医)';
    const treatment = '也没(?:有)?(?:做(?:别的|其他|任何)?处理|处理)';
    const acknowledgement = '(?:我记下了|我记下来了|我听到了|我理解了)';
    const clausePattern = new RegExp(`^(?:${acknowledgement})?(?<visit>${visit})(?<treatment>${treatment})?(?:${acknowledgement})?$`);
    for (const match of clean.matchAll(/[^，,、。；;！!？?\n]+/g)) {
      const supported = clausePattern.exec(match[0]);
      if (!supported || supported.groups.treatment && !noTreatmentSupported) continue;
      const index = match.index + supported[0].indexOf(supported.groups.visit);
      return clean.slice(0, index) + '来源核对片段' + clean.slice(index + supported.groups.visit.length);
    }
    return null;
  }
  function safeConversationFailureCode(result) {
    for (const code of [result?.j?.failure_code, result?.j?.error]) {
      if (typeof code === 'string' && CONVERSATION_FAILURE_CODES.has(code)) return code;
    }
    const status = result?.r?.status;
    return Number.isInteger(status) && CONVERSATION_HTTP_FAILURE_STATUSES.has(status) ? `http_${status}` : 'ai_conversation_failed';
  }
  function safeProviderHttpStatus(result, errorCode = result?.j?.failure_code || result?.j?.error) {
    const status = result?.j?.provider_http_status;
    return ['model_http_error', 'model_account_binding_required'].includes(errorCode)
      && Number.isSafeInteger(status) && PROVIDER_HTTP_FAILURE_STATUSES.has(status) ? status : null;
  }
  function storedProviderHttpStatus(status, errorCode) {
    return ['model_http_error', 'model_account_binding_required'].includes(errorCode)
      && Number.isSafeInteger(status) && PROVIDER_HTTP_FAILURE_STATUSES.has(status) ? status : null;
  }
  async function saveConversation(conversation, unchanged = []) {
    let report=conversation.report;
    if(report&&conversation.manual_correction_reorganization?.legacy_reply_review?.state==='confirmed'){
      const coverage=questionCoverage(conversation,report,await healthContext(subjectOf(conversation)));
      if(JSON.stringify(report.question_coverage)!==JSON.stringify(coverage))report={...report,question_coverage:coverage,
        version:(Number.isSafeInteger(report.version)?report.version:0)+1,generated_at:now()};
    }
    const previous=await vault.get(conversationKey(conversation.conversation_id));
    const reportHistory=reportHistoryIncluding(conversation.report_history||previous?.report_history,previous?.report,report);
    const saved = { ...conversation,...(report!==conversation.report?{report}:{}),
      ...(reportHistory.length?{report_history:reportHistory}:{}), version: (conversation.version || 0) + 1, updated_at: now() };
    await ownedMutation({ puts: [{ key: conversationKey(saved.conversation_id), value: saved }], unchanged });
    return saved;
  }
  async function cleanupTemporaryAudio(mediaId) {
    if (!mediaId) return false;
    return withMediaLock(mediaId, async () => {
      const media = await vault.get(mediaKey(mediaId));
      if (!media || media.trial_control || media.kind !== 'audio' || media.temporary !== true || media.recognition_status !== 'succeeded' || media.recognition?.is_mock || mockSource(media.recognition)) return false;
      const event = safety.currentAudioSource(media, await listEvents());
      if (event && safety.audioNeedsReview(event)) return false;
      const conversations = await vault.list('conversation:');
      if (conversations.some(conversation => (conversation?.turns || []).some(turn => turn.media_id === mediaId))) return false;
      try {
        await ownedMutation({ deletes: [mediaBinaryKey(mediaId), mediaKey(mediaId)],
          unchanged: [...conversations.map(conversation => ({ key: conversationKey(conversation.conversation_id), value: conversation })),
            { key: mediaKey(mediaId), value: media }] });
        return true;
      } catch (error) {
        if (['document_changed', 'subject_changed', 'stale_health_subjects'].includes(error?.message)) return false;
        throw error;
      }
    });
  }

  function injectGate() {
    if (document.getElementById('localVaultGate')) return;
    const gate = document.createElement('section');
    gate.id = 'localVaultGate'; gate.className = 'secure-gate'; gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true'); gate.setAttribute('aria-labelledby', 'vaultTitle');
    gate.innerHTML = `<div class="secure-card"><div class="secure-brand"><img src="assets/brand-mascot.png" alt=""><div><strong>NoReset·内测版</strong><span>陪你把每次不舒服记下来</span></div></div><p class="secure-kicker" id="vaultKicker">本机资料已加密</p><h1 id="vaultTitle">解锁本机健康资料</h1><p id="vaultExplain">健康记录加密保存在当前浏览器。恢复口令不会上传；忘记后无法由服务器找回。</p><form id="vaultForm"><label for="vaultPassphrase">恢复口令（至少 10 个字或字符）</label><input id="vaultPassphrase" type="password" minlength="10" autocomplete="current-password" required><label id="vaultConfirmLabel" for="vaultPassphraseConfirm" class="hidden">再输入一次</label><input id="vaultPassphraseConfirm" class="hidden" type="password" minlength="10" autocomplete="new-password"><button class="primary" id="vaultSubmit" type="submit">解锁</button><p id="vaultStatus" class="status" role="status"></p><button class="outline hidden" id="vaultRetryRead" type="button">重新读取</button></form><details id="vaultRestore"><summary>已有加密备份？从备份恢复</summary><p>换设备或清理过浏览器时，选择以前下载的备份，并输入那份备份的恢复口令。</p><form id="vaultRestoreForm"><label for="vaultRestoreFile">加密备份文件</label><input id="vaultRestoreFile" type="file" accept=".bingli,application/json" required><label for="vaultRestorePassphrase">备份的恢复口令</label><input id="vaultRestorePassphrase" type="password" autocomplete="current-password" required><button class="outline" id="vaultRestoreSubmit" type="submit">检查并恢复备份</button><p id="vaultRestoreStatus" class="status" role="status"></p></form></details><p class="secure-foot">请妥善记住口令，并定期在设置中下载加密备份。</p></div>`;
    document.body.append(gate);
  }

  async function unlockUi() {
    injectGate();
    const gate = document.getElementById('localVaultGate');
    const appShell = document.querySelector('.app-shell');
    const submitButton = document.getElementById('vaultSubmit');
    const restoreButton = document.getElementById('vaultRestoreSubmit');
    const statusMessage = document.getElementById('vaultStatus');
    const retryButton = document.getElementById('vaultRetryRead');
    gate.classList.remove('hidden');
    if (appShell) appShell.inert = true;
    submitButton.disabled = true;
    restoreButton.disabled = true;
    statusMessage.textContent = '正在读取本机资料…';
    let status;
    try { status = await vault.status(); }
    catch {
      statusMessage.textContent = '读取本机资料失败。资料未修改，请重新读取。';
      retryButton.textContent = '重新读取';
      retryButton.classList.remove('hidden');
      retryButton.onclick = () => location.reload();
      retryButton.focus();
      throw new Error('local_store_status_unavailable');
    }
    const isSetup = !status.configured;
    document.getElementById('vaultKicker').textContent = isSetup ? '第一次使用 · 只需设置一次' : '本机资料已加密';
    document.getElementById('vaultTitle').textContent = isSetup ? '保护这台设备上的健康记录' : '解锁本机健康资料';
    document.getElementById('vaultExplain').textContent = isSetup
      ? '请设置一个自己记得住的口令。记录只保存在当前浏览器，口令不会上传；忘记后无法找回。'
      : '健康记录加密保存在当前浏览器。恢复口令不会上传；忘记后无法由服务器找回。';
    document.getElementById('vaultSubmit').textContent = isSetup ? '建立并进入' : '解锁';
    statusMessage.textContent = consumeVaultInvalidationNotice() ? '资料库已在其他页面恢复，请重新解锁。' : '';
    retryButton.classList.add('hidden');
    document.getElementById('vaultRestore').classList.toggle('hidden', !isSetup);
    document.getElementById('vaultPassphrase').autocomplete = isSetup ? 'new-password' : 'current-password';
    document.getElementById('vaultConfirmLabel').classList.toggle('hidden', !isSetup);
    document.getElementById('vaultPassphraseConfirm').classList.toggle('hidden', !isSetup);
    document.getElementById('vaultPassphrase').focus();
    return new Promise(resolve => {
      const complete = async () => {
        for (const name of ['vaultPassphrase', 'vaultPassphraseConfirm', 'vaultRestorePassphrase']) document.getElementById(name).value = '';
        active = true; gate.classList.add('hidden');
        if (appShell) appShell.inert = false;
        try { await navigator.storage?.persist?.(); } catch {}
        notifyVaultState('unlocked');
        resolve(true);
      };
      document.getElementById('vaultRestoreForm').onsubmit = async event => {
        event.preventDefault();
        const message = document.getElementById('vaultRestoreStatus');
        const button = document.getElementById('vaultRestoreSubmit');
        const file = document.getElementById('vaultRestoreFile').files?.[0];
        const passphrase = document.getElementById('vaultRestorePassphrase').value;
        if (!isSetup || !file) return;
        button.disabled = true; message.textContent = '正在检查备份和口令…';
        try {
          if (file.size > 100 * 1024 * 1024) throw new Error('backup_too_large');
          const archive = JSON.parse(await file.text());
          const preview = await vault.previewArchive(archive, passphrase);
          if (await vault.status().then(value => value.configured)) throw new Error('vault_already_configured');
          // This entry is available only for an empty vault; the submit action
          // already requests restore and cannot replace existing health records.
          message.textContent = `正在恢复 ${preview.eventCount} 条记录和 ${preview.mediaCount} 份原件…`;
          await vault.restoreArchive(archive, passphrase);
          announceVaultRestore();
          await complete();
        } catch { message.textContent = '未能恢复。请检查备份文件和对应的口令；超过 100 MB 的备份暂不支持。'; }
        finally { button.disabled = false; }
      };
      document.getElementById('vaultForm').onsubmit = async event => {
        event.preventDefault();
        const message = document.getElementById('vaultStatus');
        const button = document.getElementById('vaultSubmit');
        const passphrase = document.getElementById('vaultPassphrase').value;
        const confirmation = document.getElementById('vaultPassphraseConfirm').value;
        if (passphrase.length < 10) { message.textContent = '请使用至少 10 个字符的恢复口令。'; return; }
        if (isSetup && passphrase !== confirmation) { message.textContent = '两次输入不一致。'; return; }
        button.disabled = true; message.textContent = isSetup ? '正在建立加密仓库…' : '正在解锁…';
        try {
          if (isSetup) await vault.setup(passphrase); else await vault.unlock(passphrase);
          await complete();
        } catch {
          message.textContent = isSetup ? '建立失败，请确认浏览器允许本地存储。' : '口令不正确或本地数据已损坏。';
          button.disabled = false;
        }
      };
      submitButton.disabled = false;
      restoreButton.disabled = !isSetup;
    });
  }

  async function initialise() {
    if (!initialisePromise) initialisePromise = unlockUi();
    return await initialisePromise;
  }

  async function cloudFetch(path, options = {}, timeoutMs = 90000) {
    const headers = { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(apiUrl(path), { ...options, credentials: 'include', headers, signal: controller.signal });
      let body = {}; try { body = await response.json(); } catch {}
      return { r: response, j: body };
    } catch { return fail(0, controller.signal.aborted ? 'provider_timeout' : 'network_unavailable'); }
    finally { clearTimeout(timeout); }
  }

  async function onlineSession() {
    const result = await cloudFetch('/api/app/session', {}, 8000);
    return result.r.ok && result.j.authenticated && result.j.csrf_token ? result.j.csrf_token : null;
  }

  async function onlineStatus() {
    const [config, csrf] = await Promise.all([cloudFetch('/api/app/config', {}, 8000), onlineSession()]);
    const status = { provider: config.j.provider || '' };
    for (const name of ['text_ai', 'audio_recognition', 'image_recognition']) {
      const capability = config.j.capabilities?.[name];
      const reason = !config.r.ok ? 'network_unavailable' : !capability?.available
        ? capability?.reason || 'configuration_missing' : !csrf ? 'session_unavailable' : '';
      status[name] = { available: !reason, reason: reason || capability?.reason || '' };
    }
    return status;
  }

  function sameAudioData(a, b) {
    const stable = value => value && typeof value === 'object'
      ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  }
  function canonicalJson(value) {
    const stable = item => item && typeof item === 'object'
      ? Array.isArray(item) ? item.map(stable) : Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
    return JSON.stringify(stable(value));
  }
  async function audioPayloadHash(text) {
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function currentTextTrial(currentCsrf = null) {
    const csrf = currentCsrf || await onlineSession();
    if (!csrf) return { csrf: null, grant: null };
    const result = await cloudFetch('/api/app/config', { cache: 'no-store', headers: { 'X-CSRF-Token': csrf } }, 8000);
    return { csrf, grant: result.r.ok ? result.j.text_trial ?? null : null,
      textTrialRequired: !result.r.ok || result.j.text_trial_required !== false };
  }
  function validTextTrial(grant) {
    return grant && grant.kind === 'llm' && grant.remaining_requests === 1 && grant.retries === 0
      && typeof grant.grant_id === 'string' && grant.grant_id.length > 0 && grant.grant_id.length <= 200
      && typeof grant.receipt_id === 'string' && grant.receipt_id.length > 0
      && /^[a-f0-9]{64}$/.test(grant.receipt_sha256 || '')
      && /^[a-f0-9]{64}$/.test(grant.http_payload_sha256 || '')
      && Number.isFinite(Date.parse(grant.expires_at)) && Date.parse(grant.expires_at) > Date.now();
  }
  function unrelatedTextTrialStop(trial, conversationId) {
    return Boolean(trial && trial.state !== 'completed' && trial.conversation_id !== conversationId);
  }
  function plainTextTrialConversation(conversation) {
    return liveConversationTurns(conversation).every(turn => turn.role !== 'elder'
      || turn.source_kind === 'elder' && !turn.media_id && !turn.audio_source_conversation_id && !turn.audio_source_media_version);
  }
  function mayUseFreshTextTrial(trial, conversation) {
    return Boolean(conversation && unrelatedTextTrialStop(trial, conversation.conversation_id)
      && ['review_required', 'stopped'].includes(trial.state) && plainTextTrialConversation(conversation));
  }
  async function newTextTrialScopeCurrent(owner, wire) {
    try {
      if (!owner || await audioPayloadHash(wire) !== owner.body_sha256) return false;
      const registry = await healthSubjects(), subjectId = await activeSubjectId(registry);
      if (subjectId !== owner.subject_id || observedSubjectId !== owner.subject_id
        || !sameAudioData(registry, owner.registry)) return false;
      const trial = await trialVoiceState();
      if (!sameAudioData(trial, owner.previous_trial)) return false;
      const conversation = await vault.get(conversationKey(owner.conversation_id));
      const marker = conversation?.new_text_trial;
      if (!conversation || subjectOf(conversation) !== owner.subject_id || conversation.version !== owner.conversation_version
        || conversation.trial_control || marker?.state !== 'sending' || marker.turn_id !== owner.turn_id
        || marker.scope_id !== owner.scope_id || marker.grant_id !== owner.grant.grant_id
        || marker.body_sha256 !== owner.body_sha256 || !mayUseFreshTextTrial(trial, conversation)) return false;
      const latest = liveConversationTurns(conversation).at(-1);
      if (latest?.role !== 'elder' || latest.turn_id !== owner.turn_id || latest.version !== owner.turn_version
        || latest.source_kind !== 'elder' || latest.record_id !== owner.record_id || latest.media_id
        || latest.text !== owner.text || latest.original_text !== owner.text) return false;
      const event = await vault.get(eventKey(owner.record_id));
      if (!event || subjectOf(event) !== owner.subject_id || event.record_id !== owner.record_id
        || event.source_kind !== 'elder' || event.raw_text !== owner.text || event.state === 'superseded') return false;
      const rawContext = await vault.get(healthContextKey(owner.subject_id));
      if (!sameAudioData(rawContext, owner.context_snapshot)) return false;
      const mediaItems = await mediaList();
      if (mediaItems.some(item => subjectOf(item) === owner.subject_id && item.kind === 'audio' && item.recognition_status === 'processing')) return false;
      const grantClaim = await vault.get(owner.grant_claim_key), scopeClaim = await vault.get(owner.scope_claim_key);
      return grantClaim?.state === 'sending' && grantClaim.scope_id === owner.scope_id
        && grantClaim.body_sha256 === owner.body_sha256 && grantClaim.conversation_id === owner.conversation_id
        && scopeClaim?.state === 'sending' && scopeClaim.grant_id === owner.grant.grant_id
        && scopeClaim.body_sha256 === owner.body_sha256 && scopeClaim.conversation_id === owner.conversation_id;
    } catch { return false; }
  }
  async function newTextTrialDispatchAllowed(owner, wire, grant = null) {
    return validTextTrial(owner?.grant) && Date.parse(owner.grant.expires_at) > Date.now()
      && await audioPayloadHash(wire) === owner.body_sha256
      && (!grant || validTextTrial(grant) && sameAudioData(grant, owner.grant))
      && await newTextTrialScopeCurrent(owner, wire);
  }
  async function correctionReorganizationCurrent(owner, wire, grant = undefined, textTrialRequired = null) {
    try {
      if (!owner || await audioPayloadHash(wire) !== owner.body_sha256) return false;
      if (owner.mode === 'text_trial') {
        if (!validTextTrial(owner.grant) || grant !== undefined && (!validTextTrial(grant) || !sameAudioData(grant, owner.grant))
          || textTrialRequired !== null && textTrialRequired !== true) return false;
      } else if (owner.mode === 'ordinary') {
        if (owner.grant !== null || grant !== undefined && grant !== null || textTrialRequired !== null && textTrialRequired !== false) return false;
      } else return false;
      const registry = await healthSubjects(), subjectId = await activeSubjectId(registry);
      const conversation = await vault.get(conversationKey(owner.conversation_id));
      const context = await vault.get(healthContextKey(owner.subject_id));
      const trial = await trialVoiceState();
      return subjectId === owner.subject_id && sameAudioData(registry, owner.registry)
        && sameAudioData(context, owner.context_snapshot) && sameAudioData(trial, owner.previous_trial)
        && conversation?.version === owner.conversation_version && subjectOf(conversation) === owner.subject_id
        && conversation.manual_correction_analysis_pending === true
        && !conversation.trial_control
        && sameAudioData(conversation.new_text_trial || null, owner.old_new_text_trial || null)
        && (owner.mode === 'text_trial' ? !['saved_only','sending'].includes(conversation.new_text_trial?.state) : !conversation.new_text_trial)
        && conversation.manual_correction_reorganization?.state === 'sending'
        && conversation.manual_correction_reorganization?.scope_id === owner.scope_id
        && conversation.manual_correction_reorganization?.grant_id === (owner.grant?.grant_id || null)
        && conversation.manual_correction_reorganization?.body_sha256 === owner.body_sha256
        && await audioPayloadHash(JSON.stringify(await conversationModelPayload(conversation))) === owner.body_sha256
        && await correctionSourceEventsCurrent(owner)
        && (await vault.get(owner.grant_claim_key))?.state === 'sending'
        && (await vault.get(owner.scope_claim_key))?.state === 'sending';
    } catch { return false; }
  }
  async function correctionSourceEventsCurrent(owner) {
    const conversation = await vault.get(conversationKey(owner.conversation_id));
    if (!conversation || subjectOf(conversation) !== owner.subject_id) return false;
    const events = await listEvents(), eventIndex = new Map(events.map(item => [item.record_id, item]));
    for (const source of owner.source_events || []) {
      const current = await readEvent(source.record_id);
      const turn = conversation.turns.find(item => item.turn_id === source.turn.turn_id);
      if (!current || !sameAudioData(current, source.event) || current.state === 'superseded'
        || subjectOf(current) !== owner.subject_id || current.raw_text !== source.text
        || !turn || turn.superseded || turn.version !== source.turn.version || turn.text !== source.text
        || turn.record_id !== source.record_id) return false;
      if (current.source_kind === 'audio_transcript') {
        const media = await vault.get(mediaKey(source.media?.media_id));
        const mediaIndex = new Map(media ? [[media.media_id, media]] : []);
        if (!media || !sameAudioData(media, source.media) || subjectOf(media) !== owner.subject_id
          || media.kind !== 'audio' || media.recognition_status !== 'succeeded' || mockSource(media.recognition)
          || !audioConversationSourceCurrent(turn, eventIndex, mediaIndex, conversation.conversation_id, owner.subject_id)
          || !(await vault.get(mediaBinaryKey(media.media_id)))?.bytes) return false;
      } else if (current.source_kind !== 'elder') return false;
    }
    return true;
  }
  async function runCorrectionReorganization(current) {
    const localOnly = reason => ({ dispatched: false, reason, conversation: current });
    if (!current || current.manual_correction_analysis_pending !== true) return localOnly('not_pending');
    if (current.trial_control) return localOnly('trial_review_required');
    if (current.manual_correction_reorganization?.state === 'sending') return localOnly('already_sending');
    if (liveConversationTurns(current).some(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript' && turn.audio_source_invalidated === true)) return localOnly('audio_source_review_required');
    const registry = await healthSubjects(), subjectId = await activeSubjectId(registry);
    if (subjectId !== subjectOf(current)) return localOnly('subject_mismatch');
    const sourceEvents=[];
    const currentEvents = await listEvents(), eventIndex = new Map(currentEvents.map(item => [item.record_id, item]));
    const mediaItems = await mediaList(), mediaIndex = new Map(mediaItems.map(item => [item.media_id, item]));
    for (const turn of liveConversationTurns(current).filter(item=>item.role==='elder'&&item.record_id)) {
      const event=await readEvent(turn.record_id);
      if (!event || event.state==='superseded' || subjectOf(event)!==subjectId || event.raw_text!==turn.text)
        return localOnly('source_event_changed');
      if (event.source_kind === 'audio_transcript') {
        const media = mediaIndex.get(turn.media_id);
        if (!media || media.kind !== 'audio' || media.recognition_status !== 'succeeded' || mockSource(media.recognition)
          || !audioConversationSourceCurrent(turn, eventIndex, mediaIndex, current.conversation_id, subjectId)
          || safety.currentAudioSource(media, currentEvents)?.record_id !== event.record_id
          || !(await vault.get(mediaBinaryKey(media.media_id)))?.bytes) return localOnly('audio_source_review_required');
        if (!sourceEvents.some(item=>item.record_id===event.record_id)) sourceEvents.push({record_id:event.record_id,event,text:turn.text,turn,media});
      } else if (event.source_kind === 'elder') {
        if (!sourceEvents.some(item=>item.record_id===event.record_id)) sourceEvents.push({record_id:event.record_id,event,text:turn.text,turn});
      } else return localOnly('source_event_changed');
    }
    const contextSnapshot = await vault.get(healthContextKey(subjectId));
    const before = await trialVoiceState();
    const beforeRaw = await vault.get(TRIAL_VOICE_KEY);
    const context = await healthContext(subjectId), selected = new Set(current.selected_context_ids || []);
    const sendingContext = context.entries.filter(item => selected.has(item.context_id) && usableHealthEntry(item, subjectId)).slice(0, 5);
    const requestConversation = { ...current, health_context: sendingContext, health_context_version: context.version };
    const payload = await conversationModelPayload(requestConversation), wire = JSON.stringify(payload), bodyHash = await audioPayloadHash(wire);
    const credential = await currentTextTrial(), grant = credential.grant;
    const activeOldTrial=before&&before.state!=='completed';
    let mode='text_trial';
    if (credential.textTrialRequired === false) {
      if (current.new_text_trial || current.trial_control || activeOldTrial) return localOnly('trial_gate_active');
      if (grant) return localOnly('ambiguous_trial_configuration');
      mode='ordinary';
    } else if (!validTextTrial(grant) || grant.http_payload_sha256 !== bodyHash) return localOnly('grant_unavailable_or_mismatch');
    const fresh = await currentTextTrial(credential.csrf);
    if (!fresh.csrf || fresh.textTrialRequired !== credential.textTrialRequired
      || mode==='text_trial'&&(!validTextTrial(fresh.grant)||!sameAudioData(fresh.grant,grant))
      || mode==='ordinary'&&fresh.grant!==null) return localOnly('grant_changed');
    if (!sameAudioData(await vault.get(conversationKey(current.conversation_id)), current)) return localOnly('conversation_changed');
    if (!sameAudioData(await healthSubjects(), registry)) return localOnly('subject_changed');
    if (!sameAudioData(await vault.get(healthContextKey(subjectId)), contextSnapshot)) return localOnly('context_changed');
    if (!sameAudioData(await trialVoiceState(), before)) return localOnly('trial_changed');
    const scopeId = await audioPayloadHash(JSON.stringify({ kind:'corrected-reorganization-v1', subject_id:subjectId,
      conversation_id:current.conversation_id, conversation_version:current.version,
      source_versions:liveConversationTurns(current).filter(turn=>turn.role==='elder').map(turn=>[turn.turn_id,turn.version]),
      context_version:context.version, selected_context_ids:[...(current.selected_context_ids||[])],
      source_event_versions:sourceEvents.map(item=>[item.record_id,item.event.version,item.media?.media_id||null,item.media?.version||null]), body_sha256:bodyHash }));
    const grantHash = mode==='text_trial'?await audioPayloadHash(grant.grant_id):scopeId;
    const grantClaimKey = `correction-reorganization-grant:${grantHash}`;
    const scopeClaimKey = `correction-reorganization-scope:${scopeId}`;
    if (await vault.get(grantClaimKey) || await vault.get(scopeClaimKey)
      || mode==='text_trial'&&await vault.get(`new-text-trial-grant:${grantHash}`)) return localOnly('already_used');
    const claim={grant_id:grant?.grant_id||null,receipt_id:grant?.receipt_id||null,receipt_sha256:grant?.receipt_sha256||null,
      subject_id:subjectId,conversation_id:current.conversation_id,scope_id:scopeId,body_sha256:bodyHash,state:'sending'};
    const sending={...requestConversation,manual_correction_reorganization:{state:'sending',mode,scope_id:scopeId,grant_id:grant?.grant_id||null,body_sha256:bodyHash},
      version:current.version+1,updated_at:now()};
    const owner={mode,grant,grant_claim_key:grantClaimKey,scope_claim_key:scopeClaimKey,conversation_id:current.conversation_id,
      conversation_version:sending.version,subject_id:subjectId,registry,context_snapshot:contextSnapshot,previous_trial:before,
      old_new_text_trial:current.new_text_trial||null,source_events:sourceEvents,scope_id:scopeId,body_sha256:bodyHash};
    try { await ownedMutation({puts:[{key:conversationKey(current.conversation_id),value:sending},{key:grantClaimKey,value:claim},{key:scopeClaimKey,value:claim}],unchanged:[
      {key:conversationKey(current.conversation_id),value:current},{key:TRIAL_VOICE_KEY,value:beforeRaw},{key:HEALTH_SUBJECTS_KEY,value:registry},
      {key:healthContextKey(subjectId),value:contextSnapshot},...sourceEvents.flatMap(item=>[
        {key:eventKey(item.record_id),value:item.event},...(item.media?[{key:mediaKey(item.media.media_id),value:item.media}]:[])]),
      {key:grantClaimKey,value:undefined},{key:scopeClaimKey,value:undefined}]}); }
    catch { return { ...localOnly('claim_conflict'),conversation:await vault.get(conversationKey(current.conversation_id)) }; }
    if (!await correctionReorganizationCurrent(owner,wire)) return { ...localOnly('preflight_rejected'),conversation:await vault.get(conversationKey(current.conversation_id)) };
    let result;
    try { result=await conversationReply(sending,false,null,null,owner); } catch { result=fail(0,'network_unavailable'); }
    const guards=[{key:TRIAL_VOICE_KEY,value:beforeRaw},{key:HEALTH_SUBJECTS_KEY,value:registry},{key:healthContextKey(subjectId),value:contextSnapshot},
      ...sourceEvents.flatMap(item=>[
        {key:eventKey(item.record_id),value:item.event},...(item.media?[{key:mediaKey(item.media.media_id),value:item.media}]:[])]),
      {key:grantClaimKey,value:claim},{key:scopeClaimKey,value:claim}];
    let latest=await vault.get(conversationKey(current.conversation_id)),applied=false,commitReason='source_changed';
    if (!result.r.ok && ['correction_reorganization_not_authorized','correction_reorganization_source_changed'].includes(result.j?.error)) {
      const failedClaim={...claim,state:'failed'},failed={...sending,manual_correction_reorganization:{...sending.manual_correction_reorganization,state:'failed'},version:sending.version+1,updated_at:now()};
      try { await ownedMutation({puts:[{key:conversationKey(failed.conversation_id),value:failed},{key:grantClaimKey,value:failedClaim},{key:scopeClaimKey,value:failedClaim}],
        unchanged:[{key:conversationKey(sending.conversation_id),value:sending},...guards]});latest=failed; }
      catch { latest=await vault.get(conversationKey(current.conversation_id)); }
      return {dispatched:false,reason:'grant_changed',conversation:latest};
    }
    if(await correctionReorganizationCurrent(owner,wire)){
      const committed=await commitCorrectionReorganizationAnalysis(sending,result,guards,owner,wire);
      latest=committed.conversation;applied=committed.applied;commitReason=committed.reason;
    }
    return {dispatched:true,reason:applied?'completed':commitReason==='needs_review'?'needs_review':commitReason==='failed'?'failed':'discarded',conversation:latest};
  }
  async function runFreshTextTrial(conversation, previousTrial, registrySnapshot, contextSnapshot, event, turn) {
    const localOnly = (reason, current = null) => ({ dispatched: false, ai_failed: true, reason,
      conversation: current || conversation });
    if (!mayUseFreshTextTrial(previousTrial, conversation)) return localOnly('existing_trial_in_progress');
    if ((await mediaList()).some(item => subjectOf(item) === subjectOf(conversation) && item.kind === 'audio' && item.recognition_status === 'processing')) {
      return localOnly('audio_processing');
    }
    const credential = await currentTextTrial(), grant = credential.grant;
    if (!validTextTrial(grant)) return localOnly('grant_unavailable');
    const subjectId = subjectOf(conversation), context = await healthContext(subjectId);
    const selected = new Set(conversation.selected_context_ids || []);
    const sendingContext = context.entries.filter(item => selected.has(item.context_id) && usableHealthEntry(item, subjectId)).slice(0, 5);
    const current = await vault.get(conversationKey(conversation.conversation_id));
    if (!current || current.version !== conversation.version || current.new_text_trial?.turn_id !== turn.turn_id
      || current.new_text_trial?.state !== 'saved_only' || current.trial_control
      || !sameAudioData(await trialVoiceState(), previousTrial) || !mayUseFreshTextTrial(previousTrial, current)
      || !sameAudioData(await healthSubjects(), registrySnapshot)
      || !sameAudioData(await vault.get(healthContextKey(subjectId)), contextSnapshot)
      || subjectId !== await activeSubjectId(registrySnapshot)) return localOnly('source_changed', current);
    const latestTurn = liveConversationTurns(current).at(-1), latestEvent = await vault.get(eventKey(event.record_id));
    if (latestTurn?.turn_id !== turn.turn_id || latestTurn.version !== turn.version || latestTurn.text !== turn.text
      || latestTurn.source_kind !== 'elder' || latestTurn.record_id !== event.record_id || latestTurn.media_id
      || !latestEvent || !sameAudioData(latestEvent, event)) return localOnly('source_changed', current);
    const mediaItems = await mediaList();
    if (mediaItems.some(item => subjectOf(item) === subjectId && item.kind === 'audio' && item.recognition_status === 'processing')) {
      return localOnly('audio_processing', current);
    }
    const requestConversation = { ...current, health_context: sendingContext, health_context_version: context.version };
    const payload = await conversationModelPayload(requestConversation), wire = JSON.stringify(payload), bodyHash = await audioPayloadHash(wire);
    if (!validTextTrial(grant) || await audioPayloadHash(wire) !== grant.http_payload_sha256) return localOnly('grant_scope_mismatch', current);
    const fresh = await currentTextTrial();
    if (!fresh.csrf || !validTextTrial(fresh.grant) || !sameAudioData(fresh.grant, grant)) return localOnly('grant_changed', current);
    if (!sameAudioData(await trialVoiceState(), previousTrial)
      || !sameAudioData(await healthSubjects(), registrySnapshot)
      || !sameAudioData(await vault.get(healthContextKey(subjectId)), contextSnapshot)
      || subjectId !== await activeSubjectId(registrySnapshot)
      || !sameAudioData(await vault.get(conversationKey(conversation.conversation_id)), current)
      || !sameAudioData(await vault.get(eventKey(event.record_id)), event)) return localOnly('source_changed');
    const scopeId = await audioPayloadHash(JSON.stringify({ subject_id: subjectId, conversation_id: conversation.conversation_id,
      turn_id: turn.turn_id, turn_version: turn.version, context_version: context.version,
      selected_context_ids: [...(current.selected_context_ids || [])], body_sha256: bodyHash }));
    const grantClaimKey = `new-text-trial-grant:${await audioPayloadHash(grant.grant_id)}`;
    const scopeClaimKey = `new-text-trial-scope:${scopeId}`;
    if (await vault.get(grantClaimKey) || await vault.get(scopeClaimKey)) return localOnly('already_used', current);
    const claim = { grant_id: grant.grant_id, receipt_id: grant.receipt_id, receipt_sha256: grant.receipt_sha256,
      subject_id: subjectId, conversation_id: conversation.conversation_id, turn_id: turn.turn_id,
      scope_id: scopeId, body_sha256: bodyHash, state: 'sending' };
    const sending = { ...requestConversation, new_text_trial: { turn_id: turn.turn_id, state: 'sending',
      grant_id: grant.grant_id, receipt_id: grant.receipt_id, receipt_sha256: grant.receipt_sha256,
      body_sha256: bodyHash, scope_id: scopeId }, version: current.version + 1, updated_at: now() };
    const owner = { grant, grant_claim_key: grantClaimKey, scope_claim_key: scopeClaimKey,
      conversation_id: sending.conversation_id, conversation_version: sending.version, turn_id: turn.turn_id,
      turn_version: turn.version, text: turn.text, record_id: event.record_id, subject_id: subjectId,
      registry: registrySnapshot, previous_trial: previousTrial, context_snapshot: contextSnapshot,
      body_sha256: bodyHash, scope_id: scopeId };
    const scopeClaim = { ...claim };
    try {
      await ownedMutation({ puts: [{ key: conversationKey(sending.conversation_id), value: sending },
        { key: grantClaimKey, value: claim }, { key: scopeClaimKey, value: scopeClaim }], unchanged: [
        { key: conversationKey(sending.conversation_id), value: current }, { key: TRIAL_VOICE_KEY, value: previousTrial },
        { key: HEALTH_SUBJECTS_KEY, value: registrySnapshot }, { key: healthContextKey(subjectId), value: contextSnapshot },
        { key: eventKey(event.record_id), value: event }, { key: grantClaimKey, value: undefined }, { key: scopeClaimKey, value: undefined },
      ] });
    } catch { return localOnly('source_changed', await vault.get(conversationKey(conversation.conversation_id))); }
    if (!await newTextTrialDispatchAllowed(owner, wire)) return localOnly('source_changed', await vault.get(conversationKey(conversation.conversation_id)));
    let result;
    try { result = await conversationReply(sending, false, null, owner); }
    catch { result = fail(0, 'network_unavailable'); }
    const finalGuards = [{ key: TRIAL_VOICE_KEY, value: previousTrial }, { key: HEALTH_SUBJECTS_KEY, value: registrySnapshot },
      { key: healthContextKey(subjectId), value: contextSnapshot }, { key: eventKey(event.record_id), value: event },
      { key: grantClaimKey, value: claim }, { key: scopeClaimKey, value: scopeClaim }];
    let latest = await vault.get(conversationKey(conversation.conversation_id)), applied = false;
    if (await newTextTrialScopeCurrent(owner, wire)) {
      const appended = await appendAssistantResult(sending, result, finalGuards);
      latest = appended.conversation; applied = appended.applied;
    }
    const state = applied ? latest.last_ai_metadata?.ai_failed ? 'failed' : 'completed' : 'discarded';
    const finalClaim = { ...claim, state };
    if (applied && latest) {
      const marker = latest.new_text_trial;
      const saved = { ...latest, new_text_trial: { ...marker, state }, version: latest.version + 1, updated_at: now() };
      try {
        await ownedMutation({ puts: [{ key: conversationKey(saved.conversation_id), value: saved },
          { key: grantClaimKey, value: finalClaim }, { key: scopeClaimKey, value: finalClaim }], unchanged: [
          { key: conversationKey(saved.conversation_id), value: latest }, ...finalGuards,
        ] });
        latest = saved;
      } catch { /* The persisted sending claim still prevents any retry. */ }
    } else {
      try { await ownedMutation({ puts: [{ key: grantClaimKey, value: finalClaim }, { key: scopeClaimKey, value: finalClaim }], unchanged: finalGuards }); }
      catch { /* A pending claim remains consumed if the subject or source changed. */ }
    }
    return { dispatched: true, ai_failed: !applied || latest?.last_ai_metadata?.ai_failed === true,
      reason: state, conversation: latest || await vault.get(conversationKey(conversation.conversation_id)) };
  }
  async function savedOnlyTextFirstSendAvailable(conversation) {
    const marker = conversation?.new_text_trial, turns = liveConversationTurns(conversation), latest = turns.at(-1);
    if (marker?.state !== 'saved_only' || !marker.turn_id || conversation.trial_control || latest?.role !== 'elder'
      || latest.turn_id !== marker.turn_id || latest.source_kind !== 'elder' || latest.media_id
      || !latest.text?.trim() || latest.text.length > 10000 || latest.original_text !== latest.text || mockSource(latest)
      || liveConversationTurns(conversation).some(turn => turn.role === 'elder' && (turn.source_kind !== 'elder' || turn.media_id))) return false;
    const [registry, trial, event, grantClaims, scopeClaims, mediaItems] = await Promise.all([
      healthSubjects(), trialVoiceState(), vault.get(eventKey(latest.record_id)),
      vault.list('new-text-trial-grant:'), vault.list('new-text-trial-scope:'), mediaList(),
    ]);
    const subjectId = await activeSubjectId(registry);
    if (subjectId !== subjectOf(conversation) || !mayUseFreshTextTrial(trial, conversation) || !event
      || subjectOf(event) !== subjectId || event.record_id !== latest.record_id || event.source_kind !== 'elder'
      || event.raw_text !== latest.text || event.state === 'superseded' || mockSource(event)
      || mediaItems.some(item => subjectOf(item) === subjectId && item.kind === 'audio' && item.recognition_status === 'processing')) return false;
    return ![...grantClaims, ...scopeClaims].some(claim => claim?.conversation_id === conversation.conversation_id
      && claim?.turn_id === latest.turn_id);
  }
  async function withSavedOnlyTextFirstSendState(conversation) {
    if (!conversation?.new_text_trial) return conversation;
    const available = conversation.new_text_trial.state === 'saved_only'
      && await savedOnlyTextFirstSendAvailable(conversation);
    return { ...conversation, new_text_trial: { ...conversation.new_text_trial,
      first_send_available: available } };
  }
  const REVIEWED_ASR_SAVED_AUDIO_SCHEMA = 'noreset-reviewed-asr-saved-audio-llm-v1';
  async function savedAudioGrant() {
    const csrf = await onlineSession();
    if (!csrf) return null;
    const result = await cloudFetch('/api/app/saved-audio-trial', { headers: { 'X-CSRF-Token': csrf } }, 8000);
    const grant = result.r.ok ? result.j.grant : null;
    return ['noreset-n03-saved-audio-llm-v1', 'noreset-n01-saved-audio-llm-v1', 'noreset-n01-saved-audio-llm-reviewed-v2', 'noreset-n03-cough-reviewed-saved-audio-llm-v1', REVIEWED_ASR_SAVED_AUDIO_SCHEMA].includes(grant?.schema_version)
      && /^[a-f0-9]{32}$/.test(grant.grant_id) && /^[a-f0-9]{64}$/.test(grant.receipt_sha256)
      && grant.requests === 1 && grant.retries === 0 && Date.parse(grant.expires_at) > Date.now() ? grant : null;
  }
  async function currentAsrTrial() {
    const csrf = await onlineSession();
    if (!csrf) return { available: false, grant: null };
    const result = await cloudFetch('/api/app/config', { cache: 'no-store', headers: { 'X-CSRF-Token': csrf } }, 8000);
    if (!result.r.ok) return { available: false, grant: null };
    return { available: true, grant: result.j.asr_trial ?? null };
  }
  function validAsrTrial(grant) {
    return grant && grant.kind === 'asr' && grant.remaining_requests === 1
      && typeof grant.receipt_id === 'string' && grant.receipt_id.length > 0
      && /^[a-f0-9]{64}$/.test(grant.receipt_sha256 || '')
      && Date.parse(grant.expires_at) > Date.now()
      && Array.isArray(grant.source_sha256) && grant.source_sha256.length > 0
      && grant.source_sha256.every(hash => /^[a-f0-9]{64}$/.test(hash));
  }
  async function trialBlocksAudio(trial, media, sourceHash = '') {
    if (!trial || trial.state === 'completed') return false;
    if (trial.state === 'continuing' || trial.state === 'processing') return true;
    if (trial.media_id === media.media_id || trial.conversation_id && trial.conversation_id === media.conversation_id) return true;
    if (!trial.media_id || !sourceHash) return false;
    const oldMedia = await vault.get(mediaKey(trial.media_id));
    if (oldMedia?.sha256 === sourceHash) return true;
    const oldOriginal = await vault.get(mediaBinaryKey(trial.media_id));
    return Boolean(oldOriginal?.bytes && await audioPayloadHash(oldOriginal.bytes) === sourceHash);
  }
  async function asrTrialOwner(media, processingVersion, priorTrial) {
    const registry = await healthSubjects(), subjectId = await activeSubjectId(registry);
    if (subjectOf(media) !== subjectId) return { error: 'subject_mismatch' };
    const original = await vault.get(mediaBinaryKey(media.media_id));
    if (!original?.bytes) return { error: 'original_unavailable' };
    const sourceHash = await audioPayloadHash(original.bytes);
    if (media.sha256 && media.sha256 !== sourceHash) return { error: 'integrity_mismatch' };
    if (await trialBlocksAudio(priorTrial, media, sourceHash)) return { error: priorTrial.state === 'stopped' ? 'trial_stopped' : 'trial_review_required' };
    const current = await currentAsrTrial();
    if (!current.available) return priorTrial && priorTrial.state !== 'completed' ? { error: 'trial_authorization_required' } : { owner: null };
    if (current.grant === null) return priorTrial && priorTrial.state !== 'completed' ? { error: 'trial_authorization_required' } : { owner: null };
    if (!validAsrTrial(current.grant) || !current.grant.source_sha256.includes(sourceHash)) return { error: 'trial_authorization_required' };
    const latestRegistry = await healthSubjects(), latestMedia = await vault.get(mediaKey(media.media_id)), latestOriginal = await vault.get(mediaBinaryKey(media.media_id));
    const latestTrial = await trialVoiceState();
    if (latestRegistry.version !== registry.version || latestRegistry.active_subject_id !== subjectId || observedSubjectId !== subjectId
      || !latestMedia || latestMedia.version !== media.version || subjectOf(latestMedia) !== subjectId
      || !latestOriginal?.bytes || await audioPayloadHash(latestOriginal.bytes) !== sourceHash
      || await trialBlocksAudio(latestTrial, latestMedia, sourceHash)) return { error: 'trial_authorization_required' };
    return { owner: { grant: current.grant, media_id: media.media_id, media_version: processingVersion,
      subject_id: subjectId, subject_version: registry.version, source_sha256: sourceHash } };
  }
  async function asrTrialOwnerStillCurrent(owner) {
    try {
      const registry = await healthSubjects();
      if (registry.version !== owner.subject_version || registry.active_subject_id !== owner.subject_id || observedSubjectId !== owner.subject_id) return false;
      const media = await vault.get(mediaKey(owner.media_id));
      if (!media || subjectOf(media) !== owner.subject_id || media.version !== owner.media_version || media.recognition_status !== 'processing') return false;
      const original = await vault.get(mediaBinaryKey(owner.media_id));
      if (!original?.bytes || await audioPayloadHash(original.bytes) !== owner.source_sha256 || media.sha256 && media.sha256 !== owner.source_sha256) return false;
      return !await trialBlocksAudio(await trialVoiceState(), media, owner.source_sha256);
    } catch { return false; }
  }
  async function asrTrialDispatchAllowed(owner) {
    if (!owner || owner.media_id === undefined) return false;
    const media = await vault.get(mediaKey(owner.media_id));
    const subjectId = await activeSubjectId();
    if (!media || subjectOf(media) !== subjectId || owner.subject_id !== subjectId
      || media.version !== owner.media_version || media.recognition_status !== 'processing') return false;
    const original = await vault.get(mediaBinaryKey(media.media_id));
    if (!original?.bytes || await audioPayloadHash(original.bytes) !== owner.source_sha256 || media.sha256 && media.sha256 !== owner.source_sha256) return false;
    const previous = await trialVoiceState();
    if (await trialBlocksAudio(previous, media, owner.source_sha256)) return false;
    const current = await currentAsrTrial();
    return current.available && validAsrTrial(current.grant) && sameAudioData(current.grant, owner.grant)
      && current.grant.source_sha256.includes(owner.source_sha256) && await asrTrialOwnerStillCurrent(owner);
  }
  function asrMediaControl(owner, marker, state = 'stopped') {
    return { ...(marker || { review_required: true }), review_required: true, state,
      asr_trial_receipt_id: owner.grant.receipt_id, asr_trial_receipt_sha256: owner.grant.receipt_sha256 };
  }
  function savedAudioPriorControlAllowed(grant, media, event, previous) {
    if (grant.schema_version === REVIEWED_ASR_SAVED_AUDIO_SCHEMA) {
      const priorMedia = grant.prior_media_control;
      const priorMediaAllowed = priorMedia?.review_required === true && ['review_required', 'stopped'].includes(priorMedia.state)
        && typeof priorMedia.asr_trial_receipt_id === 'string' && priorMedia.asr_trial_receipt_id.trim().length > 0
        && /^[a-f0-9]{64}$/.test(priorMedia.asr_trial_receipt_sha256 || '');
      if (previous === null) return grant.prior_global_control === null && priorMediaAllowed;
      return previous?.review_required === true && ['review_required', 'stopped'].includes(previous.state)
        && previous.conversation_id === null && /^media_[a-f0-9]{32}$/.test(previous.media_id || '')
        && previous.media_id !== media.media_id && priorMediaAllowed;
    }
    if (['review_required', 'stopped'].includes(previous?.state) && previous.conversation_id === null
      && previous.media_id === media.media_id) return true;
    // Only the already-saved synthetic N01 closure can use this completed state.
    // Its old controls remain byte-for-byte guards, with no reset or resumption.
    return grant.schema_version === 'noreset-n01-saved-audio-llm-reviewed-v2'
      && media.media_id === 'media_858a368d6c1b4246aa91be47fdb7cf1a' && media.version === 4
      && event.record_id === 'rec_731878cfff954398993ee79f0f1c5716'
      && sameAudioData(media.trial_control, {"review_required": true, "state": "completed", "conversation_id": "conversation_3001b2e17e6a4b3686948dc6d83f6659", "turn_id": "turn_995fb60fedaf4506b85425e186272ce2", "turn_version": 1, "media_id": "media_858a368d6c1b4246aa91be47fdb7cf1a"})
      && sameAudioData(previous, {"review_required": true, "state": "completed", "source_kind": "elder", "conversation_id": "conversation_3001b2e17e6a4b3686948dc6d83f6659", "turn_id": "turn_902dbb0381754982a955cb2ce07eda32", "turn_version": 1, "media_id": null});
  }
  function matchesSavedAudioGrant(grant, media, event, previous) {
    const source = grant?.source;
    const expectedSourceVersion = grant?.schema_version === 'noreset-n01-saved-audio-llm-v1' ? 1
      : grant?.schema_version === REVIEWED_ASR_SAVED_AUDIO_SCHEMA ? event?.version : 2;
    const sourceVersionValid = grant?.schema_version !== REVIEWED_ASR_SAVED_AUDIO_SCHEMA
      || Number.isSafeInteger(source?.source_version) && source.source_version > 0
        && Number.isSafeInteger(event?.version) && event.version > 0;
    return source && media.kind === 'audio' && media.recognition_status === 'succeeded'
      && !media.recognition?.is_mock && !mockSource(media.recognition) && !mockSource(event)
      && event.source_kind === 'audio_transcript' && event.state !== 'superseded'
      && source.subject_id === subjectOf(event) && source.subject_id === subjectOf(media)
      && source.media_id === media.media_id && source.media_version === media.version
      && source.record_id === event.record_id && source.source_version === event.version
      && sourceVersionValid
      && source.source_version === expectedSourceVersion
      && !safety.audioNeedsReview(event)
      && source.confirmed_at === event.source_review.confirmed_at
      && sameAudioData(grant.prior_media_control, media.trial_control)
      && sameAudioData(grant.prior_global_control, previous)
      && savedAudioPriorControlAllowed(grant, media, event, previous);
  }
  async function savedAudioTrialAvailable(mediaId) {
    try {
      const media = await vault.get(mediaKey(mediaId));
      const event = media && safety.currentAudioSource(media, await listEvents());
      const previous = await trialVoiceState(), grant = await savedAudioGrant();
      const original = media && await vault.get(mediaBinaryKey(mediaId));
      return Boolean(event && grant && original?.bytes
        && subjectOf(event) === await activeSubjectId()
        && matchesSavedAudioGrant(grant, media, event, previous)
        && !await vault.get('saved-audio-trial:' + grant.grant_id)
        && await audioPayloadHash(event.raw_text) === grant.source.text_sha256
        && await audioPayloadHash(original.bytes) === grant.source.audio_sha256);
    } catch (_) { return false; }
  }
  async function savedAudioDispatchAllowed(owner, wire) {
    const conversation = await vault.get(conversationKey(owner.conversation_id));
    const claim = await vault.get('saved-audio-trial:' + owner.grant.grant_id);
    const event = await readEvent(owner.grant.source.record_id);
    const media = await vault.get(mediaKey(owner.grant.source.media_id));
    const previousSnapshot = await vault.get(TRIAL_VOICE_KEY), previous = previousSnapshot ?? null;
    const original = media && await vault.get(mediaBinaryKey(media.media_id));
    return original?.bytes && await audioPayloadHash(original.bytes) === owner.grant.source.audio_sha256 && conversation?.version === owner.conversation_version && conversation.saved_audio_trial?.state === 'sending'
      && claim?.state === 'sending' && claim.conversation_id === owner.conversation_id
      && claim.receipt_sha256 === owner.grant.receipt_sha256 && subjectOf(conversation) === await activeSubjectId()
      && sameAudioData(previousSnapshot, owner.previous_global_control_snapshot)
      && event && media && matchesSavedAudioGrant(owner.grant, media, event, previous)
      && safety.currentAudioSource(media, await listEvents())?.record_id === event.record_id
      && Date.parse(owner.grant.expires_at) > Date.now()
      && await audioPayloadHash(event.raw_text) === owner.grant.source.text_sha256
      && await audioPayloadHash(wire) === owner.grant.http_payload_sha256;
  }
  async function startSavedAudioTrial(body) {
    const media = await vault.get(mediaKey(body.media_id)), event = await readEvent(body.record_id);
    const previousSnapshot = await vault.get(TRIAL_VOICE_KEY), previous = previousSnapshot ?? null;
    if (!media || !event || subjectOf(media) !== await activeSubjectId() || subjectOf(event) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
    if (media.version !== body.media_version || event.version !== body.source_version || safety.audioNeedsReview(event)
      || safety.currentAudioSource(media, await listEvents())?.record_id !== event.record_id) return fail(409, 'audio_source_changed');
    const original = await vault.get(mediaBinaryKey(media.media_id));
    if (!original?.bytes) return fail(409, 'audio_original_unavailable');
    const indexKey = `saved-audio-trial-source:${media.media_id}:${event.record_id}:${event.version}`;
    const replay = async () => {
      const index = await vault.get(indexKey), saved = index && await vault.get(conversationKey(index.conversation_id));
      return saved ? ok(200, { ok: true, created: false, conversation: await conversationWithCurrentReport(saved), ai_failed: saved.saved_audio_trial?.state !== 'completed' }) : null;
    };
    const existing = await replay(); if (existing) return existing;
    const grant = await savedAudioGrant();
    if (!grant || !matchesSavedAudioGrant(grant, media, event, previous)
      || await audioPayloadHash(event.raw_text) !== grant.source.text_sha256
      || await audioPayloadHash(original.bytes) !== grant.source.audio_sha256) return fail(409, 'saved_audio_trial_not_authorized');
    const conversationId = 'conversation_saved_audio_' + grant.grant_id, claimKey = 'saved-audio-trial:' + grant.grant_id;
    if (await vault.get(claimKey) || await vault.get(conversationKey(conversationId))) return fail(409, 'saved_audio_trial_used');
    const contextBefore = await vault.get(healthContextKey(subjectOf(event)));
    const created = await createConversation(body.local_date, { save: false, conversationId });
    if (!created.r.ok) return created;
    created.j.conversation.turns[0].turn_id = 'turn_saved_audio_opening_' + grant.grant_id;
    const turn = { turn_id: 'turn_saved_audio_' + grant.grant_id, role: 'elder', original_text: event.raw_text,
      text: event.raw_text, source_kind: 'audio_transcript', record_id: event.record_id, media_id: media.media_id,
      local_safety: event.local_safety, created_at: now(), version: 1, versions: [], audio_source_reviewed: true,
      audio_source_version: event.version, audio_source_media_version: media.version,
      audio_source_conversation_id: conversationId, audio_source_conversation_version: 1 };
    let conversation = { ...created.j.conversation, turns: [...created.j.conversation.turns, turn], version: 2,
      saved_audio_trial: { grant_id: grant.grant_id, state: 'sending', source_version: event.version, record_id: event.record_id, media_id: media.media_id } };
    conversation.report = await buildCurrentConversationReport(conversation);
    const payload = await conversationModelPayload(conversation), wire = JSON.stringify(payload);
    if (await audioPayloadHash(wire) !== grant.http_payload_sha256) return fail(409, 'saved_audio_trial_input_changed');
    const claim = { grant_id: grant.grant_id, conversation_id: conversationId, receipt_sha256: grant.receipt_sha256, state: 'sending' };
    try {
      await ownedMutation({ puts: [{ key: conversationKey(conversationId), value: conversation }, { key: claimKey, value: claim },
        { key: indexKey, value: { conversation_id: conversationId, grant_id: grant.grant_id } }], unchanged: [
        { key: eventKey(event.record_id), value: event }, { key: mediaKey(media.media_id), value: media },
        { key: TRIAL_VOICE_KEY, value: previousSnapshot }, { key: claimKey, value: undefined }, { key: indexKey, value: undefined },
        { key: conversationKey(conversationId), value: undefined }, { key: healthContextKey(subjectOf(event)), value: contextBefore }] });
    } catch (error) {
      if (error.message === 'document_changed') return await replay() || fail(409, 'audio_source_changed');
      throw error;
    }
    // The old global/media trial marker is only a guard above, never a write.
    let result;
    try { result = await conversationReply(conversation, false,
      { grant, conversation_id: conversationId, conversation_version: conversation.version,
        previous_global_control_snapshot: previousSnapshot }); }
    catch { result = fail(0, 'network_unavailable'); }
    const appended = await appendAssistantResult(conversation, result);
    conversation = appended.conversation;
    const state = appended.applied && result.r.ok && !conversation.last_ai_metadata?.ai_failed ? 'completed' : 'stopped';
    conversation = await saveConversation({ ...conversation, saved_audio_trial: { ...conversation.saved_audio_trial, state } });
    await ownedPut(claimKey, { ...claim, state });
    return ok(state === 'completed' ? 201 : 202, { ok: true, created: true, ai_failed: state !== 'completed', conversation });
  }

  async function cloudRequest(path, options = {}) {
    const subjectAllowed = async () => !options.healthSubjectId || options.healthSubjectId === await activeSubjectId();
    if (!await subjectAllowed()) return fail(403, 'subject_mismatch');
    const voice = path === '/api/ai/conversation-turn' || (path === '/api/ai/media/recognize' && options.body?.get?.('kind') === 'audio');
    const blockedVoice = async () => {
      if (!voice) return null;
      if (options.newTextTrial) return await newTextTrialDispatchAllowed(options.newTextTrial, options.body) ? null : fail(409, 'new_text_trial_source_changed');
      if (options.correctionReorganization) return await correctionReorganizationCurrent(options.correctionReorganization, options.body) ? null : fail(409, 'correction_reorganization_source_changed');
      const trial = await trialVoiceState(), owner = options.trialVoiceContinue, audioOwner = options.savedAudioTrial, asrOwner = options.asrTrial;
      if (options.audioMediaId && !asrOwner && trial && trial.state !== 'completed') return fail(409, trial.state === 'stopped' ? 'trial_stopped' : 'trial_authorization_required');
      if (asrOwner) return await asrTrialDispatchAllowed(asrOwner) ? null : fail(409, 'trial_authorization_required');
      if (audioOwner) {
        return await savedAudioDispatchAllowed(audioOwner, options.body) ? null : fail(409, 'saved_audio_trial_source_changed');
      }
      if (owner) {
        const conversation = await vault.get(conversationKey(owner.conversation_id));
        const control = conversation?.trial_control;
        const sameOwner = value => value?.state === 'continuing' && value.conversation_id === owner.conversation_id
          && value.turn_id === owner.turn_id && value.turn_version === owner.turn_version && value.media_id === owner.media_id;
        if (!sameOwner(trial) || !sameOwner(control) || conversation.version !== owner.conversation_version) return fail(409, trial?.state === 'stopped' ? 'trial_stopped' : 'trial_review_required');
      } else if (trial && trial.state !== 'completed' && !options.audioMediaId) return fail(409, trial.state === 'stopped' ? 'trial_stopped' : 'trial_review_required');
      return null;
    };
    const blocked = await blockedVoice(); if (blocked) return blocked;
    const { trialVoiceContinue, savedAudioTrial, asrTrial, audioMediaId, healthSubjectId, newTextTrial, correctionReorganization, ...transportOptions } = options;
    // Read the current HttpOnly session before each operation; never retain a token
    // in a backup, browser storage or a second UI password flow.
    const csrf = await onlineSession();
    if (!csrf) return fail(401, 'session_unavailable', { retryable: true });
    if (!await subjectAllowed()) return fail(403, 'subject_mismatch');
    const lateBlocked = await blockedVoice(); if (lateBlocked) return lateBlocked;
    if (newTextTrial) {
      const current = await currentTextTrial(csrf);
      if (!await newTextTrialDispatchAllowed(newTextTrial, options.body, current.grant)) return fail(409, 'new_text_trial_not_authorized');
    }
    if (correctionReorganization) {
      const fresh = await currentTextTrial(csrf);
      if (!await correctionReorganizationCurrent(correctionReorganization, options.body, fresh.grant, fresh.textTrialRequired)) return fail(409, 'correction_reorganization_not_authorized');
    }
    if (savedAudioTrial) {
      const fresh = await savedAudioGrant();
      if (!fresh || !sameAudioData(fresh, savedAudioTrial.grant)) return fail(409, 'saved_audio_trial_not_authorized');
      const finalBlocked = await blockedVoice(); if (finalBlocked) return finalBlocked;
    }
    if (newTextTrial) {
      const current = await currentTextTrial(csrf);
      if (!await newTextTrialDispatchAllowed(newTextTrial, options.body, current.grant)) return fail(409, 'new_text_trial_not_authorized');
    }
    if (correctionReorganization) {
      const fresh = await currentTextTrial(csrf);
      if (!await correctionReorganizationCurrent(correctionReorganization, options.body, fresh.grant, fresh.textTrialRequired)) return fail(409, 'correction_reorganization_not_authorized');
    }
    return cloudFetch(path, { ...transportOptions, headers: { ...options.headers, 'X-CSRF-Token': csrf } });
  }

  async function readEvent(recordId) {
    const event = await vault.get(eventKey(recordId));
    if (event && subjectOf(event) !== await activeSubjectId()) return null;
    if (!event || event.source_kind === 'document') return event;
    const seen = new Set([recordId]); let previous = event.supersedes_id;
    while (previous && !seen.has(previous)) {
      seen.add(previous); const ancestor = await vault.get(eventKey(previous));
      if (ancestor?.source_kind === 'document') return { ...event, source_kind: 'document' };
      previous = ancestor?.supersedes_id;
    }
    return event;
  }
  async function listEvents() {
    const values = await Promise.all((await vault.list('event:')).map(event => readEvent(event.record_id)));
    return values.filter(Boolean).map(event => mockSource(event) ? { ...event, is_mock: true } : event).sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));
  }
  function historyDocument(event, action, note = null) {
    const key = `history:${event.record_id}:${Date.now()}:${crypto.randomUUID()}`;
    return { key, value: { action, at: now(), version: event.version, note, snapshot: event } };
  }
  async function saveHistory(event, action, note = null) {
    const history = historyDocument(event, action, note);
    await ownedPut(history.key, history.value);
  }
  async function eventRevisionGraph() {
    const events = await vault.list('event:');
    const byId = new Map(events.filter(item => item?.record_id).map(item => [item.record_id, item]));
    const children = new Map();
    for (const event of byId.values()) {
      if (!event.supersedes_id) continue;
      const values = children.get(event.supersedes_id) || [];
      values.push(event.record_id);
      children.set(event.supersedes_id, values);
    }
    return { byId, children };
  }
  async function eventRevisionComponent(recordIds, graph = null) {
    const current = graph || await eventRevisionGraph();
    const ids = new Set();
    const queue = [...recordIds];
    while (queue.length) {
      const recordId = queue.pop();
      if (ids.has(recordId) || !current.byId.has(recordId)) continue;
      ids.add(recordId);
      const event = current.byId.get(recordId);
      if (event.supersedes_id && current.byId.has(event.supersedes_id)) queue.push(event.supersedes_id);
      queue.push(...(current.children.get(recordId) || []));
    }
    return { graph: current, recordIds: [...ids] };
  }
  async function collectDeletionPlan(recordIds, conversationId = null, explicitMediaIds = []) {
    const recordSet = new Set(recordIds);
    const ownMedia = await mediaList(), ownMediaIds = new Set(ownMedia.map(item => item.media_id));
    explicitMediaIds = new Set(explicitMediaIds.filter(id => ownMediaIds.has(id)));
    const linkedMedia = ownMedia.filter(item => recordSet.has(item.event_link?.record_id)
      || recordSet.has(item.record_id) || (conversationId && item.conversation_id === conversationId)
      || explicitMediaIds.has(item.media_id));
    const mediaIds = new Set(linkedMedia.map(item => item.media_id));
    const uploads = await vault.list('upload:');
    const uploadIds = new Set(uploads.filter(item => mediaIds.has(item.media_id)
      || (conversationId && item.conversation_id === conversationId)).map(item => item.upload_id));
    const deletes = new Set(recordIds.map(eventKey));
    if (conversationId) deletes.add(conversationKey(conversationId));
    const documents = await driver.listDocs();
    for (const document of documents) {
      const key = document.key;
      if (recordIds.some(id => key.startsWith(`history:${id}:`))) deletes.add(key);
      if (key.startsWith('media:') && mediaIds.has(key.slice('media:'.length))) deletes.add(key);
      if (key.startsWith('media-binary:') && mediaIds.has(key.slice('media-binary:'.length))) deletes.add(key);
      if ([...uploadIds].some(id => key === `upload:${id}` || key.startsWith(`upload-part:${id}:`))) deletes.add(key);
      if (key.startsWith('operation:')) {
        const operation = await vault.get(key);
        if (recordSet.has(operation?.record_id) || mediaIds.has(operation?.media_id)
          || uploadIds.has(operation?.upload_id) || (conversationId && operation?.conversation_id === conversationId)) deletes.add(key);
      }
    }
    return { recordIds, mediaIds: [...mediaIds], uploadIds: [...uploadIds], deletes: [...deletes] };
  }
  async function eventDeletionPlan(recordId) {
    const graph = await eventRevisionGraph();
    if (!graph.byId.has(recordId)) return { error: 'event_not_found' };
    const recordIds = [recordId];
    const visited = new Set(recordIds);
    let parentId = graph.byId.get(recordId)?.supersedes_id;
    while (parentId && graph.byId.has(parentId)) {
      if (visited.has(parentId)) return { error: 'revision_chain_invalid' };
      visited.add(parentId); recordIds.push(parentId);
      parentId = graph.byId.get(parentId)?.supersedes_id;
    }
    if ((graph.children.get(recordId) || []).length) return { error: 'record_has_successor' };
    for (let index = 1; index < recordIds.length; index += 1) {
      const expected = recordIds[index - 1];
      const children = graph.children.get(recordIds[index]) || [];
      if (children.length !== 1 || children[0] !== expected) return { error: 'revision_chain_conflict' };
    }
    if ((await conversationsUsingRecords(recordIds)).length) return { error: 'conversation_source_changed' };
    return collectDeletionPlan(recordIds);
  }
  async function createEvent(body, idempotencyKey) {
    const subjectId = await activeSubjectId();
    if (body.subject_id && body.subject_id !== subjectId) return fail(403, 'subject_mismatch');
    if (mockSource(body)) return fail(409, 'media_mock_unavailable');
    if (!body.raw_text?.trim()) return fail(400, 'raw_text_required');
    if (body.raw_text.length > 10000) return fail(400, 'raw_text_too_long');
    if (!SOURCE_KINDS.has(body.source_kind)) return fail(400, 'invalid_source_kind');
    if (idempotencyKey) {
      const replay = await vault.get(`operation:event:${idempotencyKey}`);
      if (replay) { const event = await readEvent(replay.record_id); return event ? ok(200, { ok: true, created: false, event }) : fail(403, 'subject_mismatch'); }
    }
    const requestedRelatedIds = Array.isArray(body.related_record_ids) ? [...new Set(body.related_record_ids.filter(value => typeof value === 'string' && value.startsWith('rec_')))].slice(-10) : [];
    const relatedRecordIds = [];
    for (const value of requestedRelatedIds) if (await readEvent(value)) relatedRecordIds.push(value);
    const event = { record_id: id('rec'), subject_id: subjectId, raw_text: body.raw_text, source_kind: body.source_kind, actor_name: body.actor_name || '本地用户', occurred_time: body.occurred_time || null, recorded_at: now(), updated_at: now(), state: 'inbox', version: 1, local_safety: safety.scanDanger(body.raw_text), draft: null, related_record_ids: relatedRecordIds,
      ...(body.source_conversation_id ? { source_conversation_id: body.source_conversation_id } : {}) };
    const puts = [{ key: eventKey(event.record_id), value: event }, historyDocument(event, 'created')];
    if (idempotencyKey) puts.push({ key: `operation:event:${idempotencyKey}`, value: { record_id: event.record_id } });
    await ownedMutation({ puts });
    return ok(201, { ok: true, created: true, event });
  }
  async function updateEvent(event, action, changes, note = null, unchanged = []) {
    const updated = { ...event, ...changes, version: event.version + 1, updated_at: now() };
    await ownedMutation({ puts: [historyDocument(event, action, note), { key: eventKey(event.record_id), value: updated }], unchanged }); return updated;
  }

  async function eventRequest(path, options, locked = false) {
    const method = options?.method || 'GET'; const parts = path.split('/').filter(Boolean);
    if (!locked && method === 'POST' && parts[3] === 'source-review') {
      const recordId = decodeURIComponent(parts[2]);
      const linked = await conversationsUsingRecords([recordId]);
      const source = await readEvent(recordId);
      const events = await listEvents();
      const mediaIds = source?.source_kind === 'audio_transcript'
        ? (await mediaList()).filter(media => safety.currentAudioSource(media, events)?.record_id === recordId).map(media => media.media_id)
        : [];
      return withConversationLocks(linked.map(item => item.conversation_id), () =>
        withEventLock(recordId, async () => {
          return withMediaLocks(mediaIds, async () => {
            const latest = await conversationsUsingRecords([recordId]);
            if (latest.some(item => !linked.some(before => before.conversation_id === item.conversation_id))) return linkedSourceConflict();
            const latestEvents = await listEvents();
            const latestMediaIds = source?.source_kind === 'audio_transcript'
              ? (await mediaList()).filter(media => safety.currentAudioSource(media, latestEvents)?.record_id === recordId).map(media => media.media_id)
              : [];
            if (latestMediaIds.length !== mediaIds.length || latestMediaIds.some(mediaId => !mediaIds.includes(mediaId))) return fail(409, 'stale_media_links');
            return eventRequest(path, options, true);
          });
        }));
    }
    if (!locked && method === 'POST' && parts[3] === 'revise') {
      // Corrections take the same conversation -> event lock order as chat
      // edits. Never wait for a conversation while already holding its event.
      const recordId = decodeURIComponent(parts[2]);
      const linked = await conversationsUsingRecords([recordId]);
      return withConversationLocks(linked.map(item => item.conversation_id), () =>
        withEventLock(recordId, async () => {
          const latest = await conversationsUsingRecords([recordId]);
          if (latest.some(item => !linked.some(before => before.conversation_id === item.conversation_id))) return linkedSourceConflict();
          return eventRequest(path, options, true);
        }));
    }
    if (!locked && method !== 'GET' && parts[0] === 'api' && parts[1] === 'events' && parts[2] && parts[3] !== 'organize') {
      const recordId = decodeURIComponent(parts[2]);
      return withEventLock(recordId, () => eventRequest(path, options, true));
    }
    const body = parseBody(options);
    if (path === '/api/events' && method === 'GET') return ok(200, { ok: true, events: await listEvents() });
    if (path === '/api/events' && method === 'POST') return createEvent(body, options?.headers?.['Idempotency-Key']);
    const recordId = decodeURIComponent(parts[2] || '');
    const rawEvent = await vault.get(eventKey(recordId));
    if (rawEvent && subjectOf(rawEvent) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
    const event = await readEvent(recordId);
    if (!event) return fail(404, 'event_not_found');
    if (parts.length === 3 && method === 'DELETE') {
      if (body.delete_scope_confirmed !== true) return fail(400, 'delete_confirmation_required');
      if (Object.prototype.hasOwnProperty.call(body, 'expected_version') && Number(body.expected_version) !== event.version) return fail(409, 'stale_version');
      const plan = await eventDeletionPlan(recordId);
      if (plan.error === 'conversation_source_changed') return linkedSourceConflict();
      if (plan.error) return fail(plan.error === 'event_not_found' ? 404 : 409, plan.error);
      return withMediaLocks(plan.mediaIds, async () => {
        const latest = await eventDeletionPlan(recordId);
        if (latest.error === 'conversation_source_changed') return linkedSourceConflict();
        if (latest.error) return fail(latest.error === 'event_not_found' ? 404 : 409, latest.error);
        if (latest.mediaIds.some(mediaId => !plan.mediaIds.includes(mediaId))) return fail(409, 'stale_media_links');
        await ownedMutation({ deletes: latest.deletes });
        return ok(200, { ok: true, deleted: { record_id: recordId, record_count: latest.recordIds.length, local_media_count: latest.mediaIds.length,
          media_ids: latest.mediaIds, encrypted_backups_unchanged: true } });
      });
    }
    if (parts.length === 3 && method === 'GET') return ok(200, { ok: true, event: mockSource(event) ? { ...event, is_mock: true } : event });
    if (parts[3] === 'history' && method === 'GET') return ok(200, { ok: true, history: await vault.list(`history:${recordId}:`), audit: [] });
    if (method !== 'POST') return fail(404, 'not_found');
    if (Number(body.expected_version) !== event.version) return fail(409, 'stale_version');
    if (parts[3] === 'source-review') {
      if (!['document', 'audio_transcript'].includes(event.source_kind) || event.state === 'superseded' || mockSource(event)) return fail(409, 'source_review_not_available');
      if (body.compared_with_original !== true) return fail(400, 'source_review_confirmation_required');
      if (event.source_kind === 'audio_transcript') {
        const events = await listEvents();
        const originals = (await mediaList()).filter(media => !mockSource(media.recognition) && !media.recognition?.is_mock
          && safety.currentAudioSource(media, events)?.record_id === event.record_id);
        if (!(await Promise.all(originals.map(media => vault.get(mediaBinaryKey(media.media_id))))).some(Boolean)) return fail(409, 'audio_original_unavailable');
        if (!safety.audioNeedsReview(event)) return ok(200, { ok: true, event });
        const updated = { ...event, source_review: { method: 'original_comparison', record_id: event.record_id, text: event.raw_text, confirmed_at: now() }, state: 'inbox', draft: null, ai_metadata: null, confirmation_scope: null, version: event.version + 1, updated_at: now() };
        const puts = [historyDocument(event, 'source_reviewed', '使用者声明已对照原录音核对当前文字；仅确认文字，不代表医学确认'), { key: eventKey(recordId), value: updated }];
        const unchanged = [{ key: eventKey(recordId), value: rawEvent }];
        for (const linkedConversation of await conversationsUsingRecords([recordId])) {
          const latest = await vault.get(conversationKey(linkedConversation.conversation_id));
          if (!latest || latest.conversation_id !== linkedConversation.conversation_id
            || subjectOf(latest) !== subjectOf(event) || subjectOf(linkedConversation) !== subjectOf(latest)
            || !Array.isArray(latest.turns)) return linkedSourceConflict();
          let changed = false;
          const turns = latest.turns.map(turn => {
            if (turn.role !== 'elder' || turn.superseded || turn.record_id !== recordId || turn.text !== updated.raw_text) return turn;
            const sourceMedia = originals.find(item => item.media_id === turn.media_id);
            changed = true;
            return { ...turn, audio_source_reviewed: true, audio_source_status: 'original_comparison', audio_source_invalidated: false, audio_source_version: updated.version,
              audio_source_media_version: sourceMedia ? sourceMedia.version + 1 : turn.audio_source_media_version,
              audio_source_conversation_id: latest.conversation_id, audio_source_conversation_version: latest.version + 1 };
          });
          if (!changed) continue;
          const reviewed = { ...latest, turns, version: latest.version + 1, updated_at: now() };
          reviewed.report = await buildCurrentConversationReport(reviewed, latest.report);
          reviewed.report_history=reportHistoryIncluding(latest.report_history,latest.report,reviewed.report);
          puts.push({ key: conversationKey(latest.conversation_id), value: reviewed });
          unchanged.push({ key: conversationKey(latest.conversation_id), value: latest });
        }
        for (const media of originals) {
          const latest = await vault.get(mediaKey(media.media_id));
          if (!latest || latest.version !== media.version) return fail(409, 'stale_media_links');
          puts.push({ key: mediaKey(media.media_id), value: { ...latest, link_pending_reason: 'audio_source_reviewed', version: latest.version + 1, updated_at: now() } });
          unchanged.push({ key: mediaKey(media.media_id), value: latest });
        }
        await ownedMutation({ puts, unchanged });
        return ok(200, { ok: true, event: updated });
      }
      const updated = await updateEvent(event, 'source_reviewed', { source_review: { method: 'original_comparison', record_id: event.record_id, text: event.raw_text, confirmed_at: now() }, state: 'inbox', draft: null, ai_metadata: null, confirmation_scope: null }, event.source_kind === 'audio_transcript' ? '使用者声明已对照原录音核对当前文字；仅确认文字，不代表医学确认' : '使用者声明已对照原件逐行核对；看不清的内容保留为未知', event.source_kind === 'audio_transcript' ? [{ key: eventKey(recordId), value: rawEvent }] : []);
      return ok(200, { ok: true, event: updated });
    }
    if (['organize', 'review', 'summary'].includes(parts[3]) && safety.documentNeedsReview(event)) return fail(409, 'document_source_review_required', { event });
    if (['organize', 'review', 'summary'].includes(parts[3]) && safety.audioNeedsReview(event)) return fail(409, 'audio_source_review_required', { event });
    if (parts[3] === 'organize') {
      if (mockSource(event)) return fail(409, 'media_mock_unavailable', { event: { ...event, is_mock: true } });
      const related = (event.related_record_ids || []).map(readEvent);
      const history = (await Promise.all(related)).filter(item => item && !safety.documentNeedsReview(item) && item.state !== 'superseded' && !mockSource(item)).map(item => ({ record_id: item.record_id, raw_text: item.raw_text, source_kind: item.source_kind, source_review: item.source_review, recorded_at: item.recorded_at, occurred_time: item.occurred_time }));
      const result = await cloudRequest('/api/ai/organize', { healthSubjectId: subjectOf(event), method: 'POST', body: JSON.stringify({ record_id: event.record_id, raw_text: event.raw_text, source_kind: event.source_kind, source_review: event.source_review, recorded_at: event.recorded_at, occurred_time: event.occurred_time, history }) });
      return withEventLock(recordId, async () => {
        const latest = await readEvent(recordId);
        if (!latest || latest.version !== event.version) return fail(409, 'stale_version', { event: latest });
        if (!result.r.ok) return ok(result.r.status || 422, { ...result.j, event, local_safety: event.local_safety });
        const updated = await updateEvent(event, 'organized', { state: 'draft', draft: result.j.output, local_safety: event.local_safety, ai_metadata: { provider: result.j.provider, model_id: result.j.model_id, prompt_version: result.j.prompt_version, trace_id: result.j.trace_id } });
        return ok(200, { ok: true, event: updated, ...result.j });
      });
    }
    if (parts[3] === 'summary') {
      const summary = String(body.summary || '').trim();
      if (!event.draft || typeof event.draft !== 'object') return fail(409, 'draft_not_available');
      if (!summary || summary.length > 4000) return fail(400, 'summary_invalid');
      const updated = await updateEvent(event, 'summary_corrected', { state: 'draft', draft: { ...event.draft, summary, summary_edited_by: 'user' } }, '使用者直接修改整理结果');
      return ok(200, { ok: true, event: updated });
    }
    if (parts[3] === 'review') {
      if (mockSource(event)) return fail(409, 'media_mock_unavailable');
      if (!['confirm', 'return', 'reject'].includes(body.action)) return fail(400, 'invalid_review_action');
      if (body.action === 'confirm' && (event.state !== 'draft' || !event.draft)) return fail(409, 'confirm_state_invalid');
      const state = body.action !== 'confirm' ? 'needs_review' : 'recorded';
      const updated = await updateEvent(event, 'reviewed', { state, confirmation_scope: state === 'recorded' ? 'record_accuracy' : null }, body.note || null);
      return ok(200, { ok: true, event: updated });
    }
    if (parts[3] === 'revise') {
      if (!body.raw_text?.trim() || !body.reason?.trim()) return fail(400, 'revision_fields_required');
      if (body.raw_text.length > 10000) return fail(400, 'raw_text_too_long');
      if (event.state === 'superseded') return fail(409, 'already_superseded');
      const superseded = { ...event, state: 'superseded', version: event.version + 1, updated_at: now() };
      const replacement = { ...superseded, record_id: id('rec'), raw_text: body.raw_text, source_kind: ['document', 'audio_transcript'].includes(event.source_kind) ? event.source_kind : body.source_kind || event.source_kind, actor_name: body.actor_name || event.actor_name, recorded_at: now(), updated_at: now(), occurred_time: event.occurred_time, state: 'inbox', version: 1, supersedes_id: event.record_id, local_safety: safety.scanDanger(body.raw_text), draft: null, ai_metadata: null, source_review: null, confirmation_scope: null };
      const supersededHistory = historyDocument(event, 'superseded', body.reason);
      const replacementHistory = historyDocument(replacement, 'created_from_revision', body.reason);
      const puts = [
        { key: eventKey(superseded.record_id), value: superseded },
        { key: eventKey(replacement.record_id), value: replacement },
        supersededHistory,
        replacementHistory,
      ];
      const unchangedConversations = [];
      for (const listedConversation of await conversationsUsingRecords([recordId])) {
        const conversation = await vault.get(conversationKey(listedConversation.conversation_id));
        if (!conversation || conversation.conversation_id !== listedConversation.conversation_id
          || subjectOf(conversation) !== subjectOf(event) || subjectOf(listedConversation) !== subjectOf(conversation)
          || !Array.isArray(conversation.turns)) return linkedSourceConflict();
        const liveSourceTurns = conversation.turns.filter(turn => turn.role === 'elder' && !turn.superseded && turn.record_id === recordId);
        if (liveSourceTurns.some(turn => turn.source_kind !== event.source_kind || turn.text !== event.raw_text)) return linkedSourceConflict();
        const latestOwnTurn = latestEditableOwnTurn(conversation);
        if (liveSourceTurns.some(turn => latestOwnTurn?.turn_id !== turn.turn_id)) return fail(409, 'conversation_turn_not_latest');
        const firstIndex = conversation.turns.findIndex(turn => turn.role === 'elder' && !turn.superseded && turn.record_id === recordId);
        if (firstIndex < 0) {
          if (event.source_kind !== 'audio_transcript') return linkedSourceConflict();
          continue; // Keep legacy/superseded history; never infer a current turn from it.
        }
        const editedAt = now();
        const audioRevision = event.source_kind === 'audio_transcript';
        const invalidatedAssistantIds = [];
        const turns = conversation.turns.map((turn, index) => {
          if (audioRevision && index >= firstIndex && turn.role === 'elder' && !turn.superseded && turn.record_id === recordId) return {
            ...turn, text: replacement.raw_text, record_id: replacement.record_id, source_kind: 'audio_transcript',
            is_mock: false, local_safety: replacement.local_safety, version: turn.version + 1, edited_at: editedAt,
            original_text: turn.original_text ?? turn.text,
            versions: [...(turn.versions || []), { version: turn.version, text: turn.text,
              record_id: turn.record_id, replaced_at: editedAt }],
            audio_source_reviewed: false, audio_source_version: null, audio_source_media_version: null,
            audio_source_conversation_id: conversation.conversation_id,
            audio_source_conversation_version: conversation.version + 1,
          };
          if (audioRevision && index > firstIndex && turn.role === 'assistant' && !turn.superseded) {
            invalidatedAssistantIds.push(turn.turn_id);
            return { ...turn, superseded: true };
          }
          if (turn.role === 'elder' && !turn.superseded && turn.record_id === recordId) return { ...turn,
            text: replacement.raw_text, record_id: replacement.record_id, source_kind: replacement.source_kind,
            is_mock: false, local_safety: replacement.local_safety, version: turn.version + 1, edited_at: editedAt,
            versions: [...(turn.versions || []), { version: turn.version, text: turn.text,
              record_id: turn.record_id, replaced_at: editedAt }],
          };
          if (!audioRevision && index > firstIndex && turn.role === 'assistant' && !turn.superseded) {
            invalidatedAssistantIds.push(turn.turn_id);
            return { ...turn, superseded: true };
          }
          return turn;
        });
        const updated = { ...conversation, turns, version: conversation.version + 1, updated_at: editedAt,
          controller: editedConversationController(conversation.controller), completeness: null, analysis_sources: null,
          relevant_health_context: [], stale_responding_to_turn_ids: [...new Set([...(conversation.stale_responding_to_turn_ids || []), ...invalidatedAssistantIds])],
          active_episode_start_turn_id: null, last_ai_metadata: null,
          ...(audioRevision ? { manual_correction_analysis_pending: true,
            manual_correction_reorganization: conversation.manual_correction_reorganization
              ? { ...conversation.manual_correction_reorganization, state: 'stale', invalidated_at: editedAt }
              : null } : {}) };
        updated.report = await buildCurrentConversationReport(updated, conversation.report);
        updated.report_history=reportHistoryIncluding(conversation.report_history,conversation.report,updated.report);
        puts.push({ key: conversationKey(conversation.conversation_id), value: updated });
        unchangedConversations.push({ key: conversationKey(conversation.conversation_id), value: conversation });
      }
      await ownedMutation({ puts, unchanged: [{ key: eventKey(recordId), value: rawEvent }, ...unchangedConversations] });
      return ok(201, { ok: true, event: replacement });
    }
    return fail(404, 'not_found');
  }

  async function createConversation(localDate, { save = true, conversationId } = {}) {
    if (!validLocalDate(localDate)) return fail(400, 'local_date_invalid');
    const registry = await healthSubjects(), subjectId = await activeSubjectId(registry), context = await healthContext(subjectId);
    const remembered = context.entries.filter(item => item.remember && usableHealthEntry(item, registry.active_subject_id)).slice(0, 5);
    const createdAt = now();
    const conversation = {
      conversation_id: conversationId || id('conversation'),
      subject_id: registry.active_subject_id,
      local_date: localDate,
      last_local_date: localDate,
      created_at: createdAt,
      updated_at: createdAt,
      status: 'active',
      version: 1,
      turns: [{
        turn_id: id('turn'), role: 'assistant',
        text: CONVERSATION_OPENING_TEXT,
        action: 'ask', question_category: 'main_complaint', created_at: createdAt, version: 1,
      }],
      controller: openingConversationController(),
      active_episode_start_turn_id: null,
      completeness: null,
      report: null, health_context: remembered, selected_context_ids: remembered.map(item => item.context_id), health_context_version: context.version,
    };
    if (save) await ownedMutation({ puts: [{ key: conversationKey(conversation.conversation_id), value: conversation }], unchanged: [{ key: HEALTH_SUBJECTS_KEY, value: registry }] });
    return ok(201, { ok: true, conversation });
  }

  async function conversationModelPayload(conversation) {
    const [events, mediaItems] = await Promise.all([listEvents(), mediaList()]);
    conversation = reconcileConversationAudioReview(conversation, events, mediaItems);
    const eventIndex = new Map(events.map(event => [event.record_id, event])), mediaIndex = new Map(mediaItems.map(item => [item.media_id, item]));
    const allElderTurns = elderTurns(conversation).filter(turn => {
      if (turn.source_kind !== 'audio_transcript') return true;
      return audioConversationSourceCurrent(turn, eventIndex, mediaIndex, conversation.conversation_id, subjectOf(conversation));
    }).slice(-40);
    if (subjectOf(conversation) !== await activeSubjectId()) throw new Error('subject_mismatch');
    const currentContext = await healthContext(subjectOf(conversation));
    const selected = new Set(conversation.selected_context_ids || []);
    const context = currentContext.entries.filter(item => selected.has(item.context_id) && usableHealthEntry(item, subjectOf(conversation))).slice(0, 5);
    conversation.health_context = context;
    conversation.health_context_version = currentContext.version;
    const activeContextIds = new Set(context.map(item => item.context_id));
    const scopedContextIds = new Set([...(conversation.selected_context_ids || []), ...(conversation.controller?.linked_context_ids || []),
      ...(conversation.turns || []).flatMap(turn => Array.isArray(turn.model_context_ids) ? turn.model_context_ids : [])]);
    const invalidatedContextIds = [...scopedContextIds].filter(id => !activeContextIds.has(id));
    const requestStaleSources = invalidatedRespondingSources(conversation, invalidatedContextIds);
    const staleSources = new Set(requestStaleSources);
    const requestController = invalidateContextController(conversation, invalidatedContextIds, requestStaleSources);
    const latestElder=liveConversationTurns(conversation).filter(turn=>turn.role==='elder').at(-1);
    const quoteContext=latestElder?.quote_context||null;
    if(quoteContext&&!await quoteContextCurrent(conversation,quoteContext))throw new Error('quote_context_stale');
    return {
      subject_id: subjectOf(conversation),
      ...(quoteContext?{quote_context:structuredClone(quoteContext)}:{}),
      turns: allElderTurns.map(turn => {
        const index = conversation.turns.findIndex(item => item.turn_id === turn.turn_id);
        const previous = conversation.turns[index - 1];
        const explicitSource = turn.responding_to;
        const question = explicitSource
          ? conversation.turns.find(item => item.role === 'assistant' && item.turn_id === explicitSource.turn_id)
          : previous?.role === 'assistant' ? previous : null;
        const questionIndex = question ? conversation.turns.indexOf(question) : -1;
        const text = question && !staleSources.has(question.turn_id)
          && question.role === 'assistant' && !question.ai_failed && !question.superseded
          && conversation.turns.filter(item => item.turn_id === question.turn_id).length === 1
          && ['ask', 'reply'].includes(question.action) && !mockSource(question)
          && (!explicitSource || explicitSource.text === question.text
            && (turn.responding_to_version ?? 1) === (question.version ?? 1))
          && (!Array.isArray(question.model_context_ids) || question.model_context_ids.every(id => activeContextIds.has(id)))
          ? questionIndex === 0 ? question.text : questionText(question.text) || question.text : null;
        return { turn_id: turn.turn_id, text: turn.text, version: turn.version,
          ...(turn.source_kind === 'audio_transcript' ? { source: {
            kind: 'audio_transcript', status: turn.audio_source_reviewed ? 'original_comparison' : turn.audio_source_status,
            record_id: turn.record_id, record_version: turn.audio_source_version, media_id: turn.media_id,
            media_version: turn.audio_source_media_version,
          } } : {}),
          responding_to: text ? { turn_id: question.turn_id, text } : null };
      }),
      controller: requestController,
      health_context: context.map(healthEntryPayload),
    };
  }

  async function verifiedNonHealthOnlyReport(conversation, currentContext = null) {
    const turns = elderTurns(conversation), controller = conversation?.controller;
    const markers = controller?.non_health_sources;
    if (!turns.length || !Array.isArray(markers) || markers.length !== turns.length
      || subjectOf(conversation) !== await activeSubjectId()) return false;
    const selected = conversation.selected_context_ids || [];
    const context = currentContext || await healthContext(subjectOf(conversation));
    const state = conversation.completeness?.clinical_state;
    if (!Array.isArray(selected) || selected.length || (conversation.health_context || []).length
      || (conversation.relevant_health_context || []).length
      || (conversation.completeness?.relevant_context_ids || []).length
      || (conversation.completeness?.contradictions || []).length
      || (conversation.report?.reviewed_risk_assessments || []).length
      || context.entries.some(entry => selected.includes(entry.context_id))
      || state && Object.values(state).some(item => item?.status !== 'missing')
      || state && Object.keys(state).some(category => !CLINICAL_CATEGORIES.includes(category))) return false;
    if (conversation.completeness && !analysisSourcesCurrent(conversation, context)) return false;
    const currentTurns = liveConversationTurns(conversation);
    if (currentTurns.some(turn => turn.local_safety?.danger_detected || turn.local_safety?.clinical_review_required
      || turn.reviewed_risk_validated === true || turn.risk_assessment)) return false;

    const payload = await conversationModelPayload({ ...conversation });
    const currentController = payload.controller;
    if (!sameAudioData(currentController?.non_health_sources, markers)) return false;
    const sessionId = currentController.session_id, anchor = currentController.session_anchor_turn_id;
    const sessionTurnIds = currentController.session_turn_ids;
    if (typeof anchor !== 'string' || typeof sessionId !== 'string' || !Array.isArray(sessionTurnIds)
      || sessionTurnIds.length > 40 || new Set(sessionTurnIds).size !== sessionTurnIds.length
      || turns.length > 40 || turns.some(turn => !sessionTurnIds.includes(turn.turn_id))
      || await audioPayloadHash(`conversation-source-v1\0${subjectOf(conversation) || ''}\0${anchor}`) !== sessionId
      || payload.turns.length !== turns.length) return false;

    const markerFields = ['turn_id', 'version', 'text_sha256', 'responding_to_sha256', 'session_id'];
    const seen = new Set();
    for (const marker of markers) {
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)
        || Object.keys(marker).sort().join(',') !== [...markerFields].sort().join(',')
        || seen.has(marker.turn_id)) return false;
      const turn = turns.find(item => item.turn_id === marker.turn_id);
      const payloadTurn = payload.turns.find(item => item.turn_id === marker.turn_id);
      if (!turn || !payloadTurn || !Number.isInteger(marker.version) || marker.version !== turn.version
        || marker.session_id !== sessionId || !/^[a-f0-9]{64}$/.test(marker.text_sha256 || '')
        || !/^[a-f0-9]{64}$/.test(marker.responding_to_sha256 || '')
        || await audioPayloadHash(turn.text) !== marker.text_sha256
        || await audioPayloadHash(canonicalJson(payloadTurn.responding_to)) !== marker.responding_to_sha256) return false;
      seen.add(marker.turn_id);
    }
    return turns.every(turn => seen.has(turn.turn_id));
  }
  async function buildCurrentConversationReport(conversation, previous = null, currentContext = null) {
    const nonHealthOnly = await verifiedNonHealthOnlyReport(conversation, currentContext);
    return buildConversationReport(conversation, previous, currentContext, nonHealthOnly);
  }

  async function refreshConversationReport(conversationId, body) {
    const key = conversationKey(conversationId), stored = await vault.get(key);
    if (!stored) return fail(404, 'conversation_not_found');
    const registry = await healthSubjects(), subjectId = await activeSubjectId(registry);
    const subjectVersion = registry.version, context = await healthContext(subjectId);
    if (body.expected_conversation_version !== stored.version || body.expected_subject_id !== subjectId
      || body.expected_subject_version !== subjectVersion || body.expected_context_version !== context.version
      || subjectOf(stored) !== subjectId) return fail(409, 'report_source_changed');
    if (stored.manual_correction_analysis_pending === true) return fail(409, 'report_correction_pending');
    const [events, mediaItems] = await Promise.all([listEvents(), mediaList()]);
    const current = reconcileConversationAudioReview(excludeMockFacts(stored), events, mediaItems);
    const audioEventIndex = new Map(events.map(item => [item.record_id, item]));
    const audioMediaIndex = new Map(mediaItems.map(item => [item.media_id, item]));
    if (!analysisSourcesCurrent(current, context) || !audioConversationSourcesCurrent(current, audioEventIndex, audioMediaIndex)) {
      return fail(409, 'report_sources_not_current');
    }
    const contextKey = healthContextKey(subjectId), contextRaw = await vault.get(contextKey);
    if (Number(contextRaw?.version || 0) !== context.version || (contextRaw?.subject_id || SELF_SUBJECT_ID) !== subjectId) return fail(409, 'report_source_changed');
    const normalizedRawContext = { ...(contextRaw || { version: 0, updated_at: null, entries: [] }), subject_id: subjectId,
      entries: (contextRaw?.entries || []).map(item => item.subject_id && item.confirmation_status ? item : legacyHealthEntry(item, subjectId)) };
    if (canonicalJson(normalizedRawContext) !== canonicalJson(context)) return fail(409, 'report_source_changed');
    const unchanged = [{ key, value: stored }, { key: HEALTH_SUBJECTS_KEY, value: registry }, { key: contextKey, value: contextRaw }];
    for (const recordId of [...new Set(elderTurns(stored).map(turn => turn.record_id).filter(Boolean))]) {
      const event = await vault.get(eventKey(recordId));
      const listed = events.find(item => item.record_id === recordId);
      if (!event || !listed || subjectOf(event) !== subjectId || canonicalJson(event) !== canonicalJson(listed)) return fail(409, 'report_source_changed');
      unchanged.push({ key: eventKey(recordId), value: event });
    }
    for (const mediaId of [...new Set(elderTurns(stored).map(turn => turn.media_id).filter(Boolean))]) {
      const media = await vault.get(mediaKey(mediaId));
      const listed = mediaItems.find(item => item.media_id === mediaId);
      if (!media || !listed || subjectOf(media) !== subjectId || canonicalJson(media) !== canonicalJson(listed)) return fail(409, 'report_source_changed');
      unchanged.push({ key: mediaKey(mediaId), value: media });
    }
    const payload = await conversationModelPayload(current);
    payload.completeness = current.completeness;
    let response;
    try {
      response = await cloudRequest('/api/reports/reground', { healthSubjectId: subjectId, method: 'POST', body: JSON.stringify(payload) });
    } catch { return fail(503, 'report_update_unavailable', { conversation: await conversationArchiveView(stored) }); }
    const result = response?.j;
    if (!response?.r?.ok) {
      const status = response?.r?.status;
      if (status === 422) return fail(422, 'report_update_rejected');
      if (status === 409) return fail(409, 'report_source_changed');
      return fail([401, 502, 503, 504].includes(status) ? 503 : 502, 'report_update_unavailable', { retryable: true });
    }
    if (result?.ok !== true || result?.source_only !== true
      || result?.algorithm_version !== 'literal-report-v129' || !result.clinical_state
      || typeof result.clinical_state !== 'object' || Array.isArray(result.clinical_state)
      || Object.keys(result.clinical_state).sort().join(',') !== [...CLINICAL_CATEGORIES].sort().join(',')) {
      return fail(422, 'report_update_rejected');
    }
    const nextState = {};
    for (const category of CLINICAL_CATEGORIES) {
      const original = current.completeness?.clinical_state?.[category], proposed = result.clinical_state[category];
      const withoutSummary = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const { summary, ...rest } = value; return canonicalJson(rest); };
      if (!original || !proposed || typeof proposed.summary !== 'string'
        || (original.status !== 'known' && canonicalJson(original) !== canonicalJson(proposed))
        || (original.status === 'known' && withoutSummary(original) !== withoutSummary(proposed))) return fail(422, 'report_update_rejected');
      const item = { ...original, summary: proposed.summary };
      if (item.status === 'known' && !groundedReportSummary(item, current)) return fail(422, 'report_update_rejected');
      nextState[category] = item;
    }
    const nextCompleteness = { ...current.completeness, clinical_state: nextState };
    const candidateInput = { ...current, completeness: nextCompleteness };
    const oldSummary = (stored.report?.sections || []).flatMap(section => (section.lines || []).filter(line => line.kind === 'summary'));
    const candidateReport = await buildCurrentConversationReport({ ...candidateInput, report: stored.report }, stored.report, context);
    const newSummary = (candidateReport?.sections || []).flatMap(section => (section.lines || []).filter(line => line.kind === 'summary'));
    const nonSummary = report => (report?.sections || []).map(section => [section.key, (section.lines || []).filter(line => line.kind !== 'summary')]);
    if (JSON.stringify(nonSummary(stored.report)) !== JSON.stringify(nonSummary(candidateReport))) {
      return fail(422, 'report_update_rejected', { conversation: await conversationArchiveView(stored) });
    }
    const summaryChanged = JSON.stringify(oldSummary) !== JSON.stringify(newSummary);
    const sourceSnapshotCurrent = async () => {
      try {
        for (const guard of unchanged) if (JSON.stringify(await vault.get(guard.key)) !== JSON.stringify(guard.value)) return false;
        const freshRegistry = await healthSubjects(), freshContext = await healthContext(subjectId), freshConversation = await vault.get(key);
        return freshRegistry.active_subject_id === subjectId && freshRegistry.version === subjectVersion
          && freshContext.version === context.version && freshConversation?.version === stored.version
          && analysisSourcesCurrent(freshConversation, freshContext);
      } catch { return false; }
    };
    if (!await sourceSnapshotCurrent()) return fail(409, 'report_source_changed');
    if (!summaryChanged && JSON.stringify(stored.completeness?.clinical_state) === JSON.stringify(nextState)) {
      return ok(200, { ok: true, changed: false, conversation: await conversationCurrentView(stored, events, mediaItems) });
    }
    const timestamp = now(), history = reportHistoryIncluding(stored.report_history,stored.report,
      { ...candidateReport, version: (Number.isSafeInteger(stored.report?.version) ? stored.report.version : 0) + 1, generated_at: timestamp });
    const report = { ...candidateReport, version: (Number.isSafeInteger(stored.report?.version) ? stored.report.version : 0) + 1, generated_at: timestamp };
    const saved = { ...stored, completeness: nextCompleteness, report, report_history: history,
      version: stored.version + 1, updated_at: timestamp };
    try { await ownedMutation({ puts: [{ key, value: saved }], unchanged }); }
    catch { return fail(409, 'report_source_changed', { conversation: await conversationArchiveView(await vault.get(key) || stored) }); }
    return ok(200, { ok: true, changed: true, conversation: await conversationCurrentView(saved, events, mediaItems) });
  }

  async function commitCorrectionReorganizationAnalysis(conversation, result, extraGuards, owner, wire) {
    const key=conversationKey(conversation.conversation_id),sendingVersion=conversation.version;
    const sendingSources=JSON.stringify(analysisSources(conversation));
    const stored=await vault.get(key),currentContext=await healthContext(subjectOf(conversation));
    if(!stored)throw new Error('conversation_not_found');
    if(stored.version!==sendingVersion||JSON.stringify(analysisSources(stored,currentContext))!==sendingSources
      ||!await correctionReorganizationCurrent(owner,wire))return {conversation:stored,applied:false,reason:'source_changed'};
    const response=result?.j||{},completeness=response.completeness||{};
    const riskAssessment=response.risk_assessment;
    const routineRisk=['routine','none',null,undefined].includes(response.risk_level)
      &&(!riskAssessment||riskAssessment.level==='none')
      &&response.exception!==true&&!response.error
      &&!['exception','error','failed','rejected'].includes(response.status||'')
      &&!['exception','error','failed','rejected'].includes(riskAssessment?.status||'')
      &&!response.local_safety?.danger_detected&&!response.local_safety?.clinical_review_required
      &&!['urgent','soon_evaluation'].includes(response.action)
      &&!elderTurns(conversation).some(turn=>turn.local_safety?.danger_detected);
    const routineAnalysis=result?.r?.ok===true&&['ask','reply','finish'].includes(response.action)&&routineRisk
      &&typeof response.provider==='string'&&response.provider.trim()&&!/mock/i.test(response.provider)
      &&typeof response.trace_id==='string'&&response.trace_id.trim()
      &&completeness.clinical_state&&typeof completeness.clinical_state==='object'&&!Array.isArray(completeness.clinical_state)
      &&Array.isArray(completeness.contradictions)&&Array.isArray(completeness.unknowns)
      &&Array.isArray(completeness.relevant_context_ids)&&Array.isArray(completeness.evidence_turn_ids);
    const operation=conversation.manual_correction_reorganization||{};
    const sourceBinding={operation_kind:'corrected_reorganization',conversation_id:conversation.conversation_id,
      subject_id:subjectOf(conversation),scope_id:owner.scope_id,body_sha256:owner.body_sha256,
      conversation_version:sendingVersion,source_turn_versions:elderTurns(conversation).map(turn=>({turn_id:turn.turn_id,version:turn.version})),
      source_event_versions:(owner.source_events||[]).map(item=>({record_id:item.record_id,version:item.event.version})),
      source_media_versions:(owner.source_events||[]).filter(item=>item.media).map(item=>({media_id:item.media.media_id,version:item.media.version})),
      context_version:conversation.health_context_version??0,selected_context_ids:[...(conversation.selected_context_ids||[])]};
    const provenance={operation_kind:'corrected_reorganization',result_provenance:'operation_analysis_only_v1',
      scope_id:owner.scope_id,body_sha256:owner.body_sha256,source_binding:sourceBinding,
      trace_id:typeof response.trace_id==='string'?response.trace_id:null,
      provider:typeof response.provider==='string'?response.provider:null,
      model_id:typeof response.model_id==='string'?response.model_id:null,
      prompt_version:typeof response.prompt_version==='string'?response.prompt_version:null};
    const state=routineAnalysis?'completed':result?.r?.ok?'needs_review':'failed';
    const finalClaim={grant_id:owner.grant?.grant_id||null,receipt_id:owner.grant?.receipt_id||null,
      receipt_sha256:owner.grant?.receipt_sha256||null,subject_id:owner.subject_id,conversation_id:owner.conversation_id,
      scope_id:owner.scope_id,body_sha256:owner.body_sha256,state};
    const {failure_code:_oldFailureCode,provider_http_status:_oldProviderStatus,...operationBase}=operation;
    const failureCode=routineAnalysis?null:result?.r?.ok?'reorganization_result_not_routine':safeConversationFailureCode(result);
    const providerStatus=routineAnalysis?null:safeProviderHttpStatus(result,failureCode);
    const next={...stored,manual_correction_reorganization:{...operationBase,...provenance,state,
      ...(failureCode?{failure_code:failureCode}:{}),...(providerStatus?{provider_http_status:providerStatus}:{})},
      version:stored.version+1,updated_at:now()};
    if(routineAnalysis){
      next.completeness=completeness;
      next.analysis_sources=analysisSources(conversation);
      next.manual_correction_analysis_pending=false;
      next.relevant_health_context=(conversation.health_context||[]).filter(item=>completeness.relevant_context_ids.includes(item.context_id));
      const reportInput=invalidateChangedAnalysis(next,currentContext);
      reportInput.report=await buildCurrentConversationReport(reportInput,conversation.report,currentContext);
      Object.assign(next,reportInput);
    }
    const registry=await healthSubjects();
    if(registry.active_subject_id!==subjectOf(conversation)||!await correctionReorganizationCurrent(owner,wire))
      return {conversation:await vault.get(key)||stored,applied:false,reason:'source_changed'};
    const contextGuards=[];
    if(conversation.selected_context_ids?.length){
      const rawContext=await vault.get(healthContextKey(subjectOf(conversation)));
      if(Number(rawContext?.version||0)!==currentContext.version)return {conversation:await vault.get(key)||stored,applied:false,reason:'source_changed'};
      contextGuards.push({key:healthContextKey(subjectOf(conversation)),value:rawContext});
    }
    try{
      await ownedMutation({puts:[{key,value:next},{key:owner.grant_claim_key,value:finalClaim},{key:owner.scope_claim_key,value:finalClaim}],
        unchanged:[{key,value:stored},...extraGuards,...contextGuards]});
      return {conversation:next,applied:routineAnalysis,reason:routineAnalysis?'completed':state};
    }catch{
      return {conversation:await vault.get(key)||stored,applied:false,reason:'source_changed'};
    }
  }

  async function appendAssistantResult(conversation, result, extraGuards = []) {
    const sendingVersion = conversation.version;
    const sendingSources = JSON.stringify(analysisSources(conversation));
    const sendingQuote = elderTurns(conversation).at(-1)?.quote_context || null;
    let storedConversation = await vault.get(conversationKey(conversation.conversation_id));
    let currentContext = await healthContext(subjectOf(conversation));
    const sourceUnchanged = latest => latest && latest.version === sendingVersion
      && JSON.stringify(analysisSources(latest, currentContext)) === sendingSources;
    if (!storedConversation) throw new Error('conversation_not_found');
    if (!sourceUnchanged(storedConversation)) return { conversation: storedConversation, applied: false };
    // The result belongs to the sending snapshot, including its selected
    // context. Never rebind an old analysis to newer patient wording.
    const sendingContext = conversation.health_context;
    const sendingContextVersion = conversation.health_context_version;
    conversation = { ...excludeMockFacts(storedConversation), health_context: sendingContext, health_context_version: sendingContextVersion };
    const localUrgent = result.j?.action === 'urgent' && result.j?.provider === 'LocalDangerRule'
      && result.j?.assistant_text === safety.DANGER_REMINDER && elderTurns(conversation).at(-1)?.local_safety?.danger_detected;
    const riskRequested = !localUrgent && (['soon_evaluation', 'urgent'].includes(result.j?.action)
      || (result.j?.risk_assessment && result.j.risk_assessment.level !== 'none'));
    let riskAssessment = null;
    if (result.r.ok && riskRequested) {
      // Ordinary turns add no config request. A reviewed notice needs the live
      // trusted manifest, never approval fields authored by the model itself.
      const config = await cloudFetch('/api/app/config', {}, 8000);
      storedConversation = await vault.get(conversationKey(conversation.conversation_id));
      currentContext = await healthContext(subjectOf(conversation));
      if (!storedConversation) throw new Error('conversation_not_found');
      if (!sourceUnchanged(storedConversation)) return { conversation: storedConversation, applied: false };
      conversation = { ...excludeMockFacts(storedConversation), health_context: sendingContext, health_context_version: sendingContextVersion };
      riskAssessment = config.r.ok ? safety.validateReviewedRisk(result.j.risk_assessment,
        config.j.reviewed_risk_rules, elderTurns(conversation)) : null;
      if (riskAssessment && (result.j.action !== riskAssessment.level || result.j.assistant_text !== riskAssessment.notice)) riskAssessment = null;
    }
    const reviewedFixedText = localUrgent || Boolean(riskAssessment) || result.j?.assistant_text === CONVERSATION_BLOCKED_TEXT;
    const latestSourceText = elderTurns(conversation).at(-1)?.text || '';
    const maskedReply = maskSourceSupportedVisitPhrase(result.j?.assistant_text, latestSourceText);
    const replyTextSafe = !unsafeAssistantText(maskedReply ?? result.j?.assistant_text);
    const safeResult = result.r.ok && typeof result.j?.assistant_text === 'string' && result.j.assistant_text.trim()
      && result.j.assistant_text.length <= 1000 && ['ask', 'reply', 'finish', 'urgent', 'soon_evaluation'].includes(result.j.action)
      && !/mock/i.test(result.j.provider || '') && (!riskRequested || Boolean(riskAssessment))
      && (reviewedFixedText || replyTextSafe);
    const assistantText = safeResult ? String(result.j.assistant_text || CONVERSATION_FINISH_TEXT) : CONVERSATION_FAILURE_TEXT;
    const failureCode = safeResult ? null : result.r.ok
      ? typeof result.j?.assistant_text !== 'string' || !result.j.assistant_text.trim() || result.j.assistant_text.length > 1000
        || !['ask', 'reply', 'finish', 'urgent', 'soon_evaluation'].includes(result.j.action) ? 'model_response_invalid'
        : /mock/i.test(result.j.provider || '') ? 'model_mock_unavailable'
        : riskRequested && !riskAssessment ? 'reviewed_risk_invalid'
        : !replyTextSafe && !reviewedFixedText ? 'model_reply_unsafe' : 'model_response_invalid'
      : safeConversationFailureCode(result);
    const providerHttpStatus = safeProviderHttpStatus(result, failureCode);
    const assistant = {
      turn_id: id('turn'), role: 'assistant', text: assistantText,
      model_context_ids: safeResult ? (sendingContext || []).map(item => item.context_id) : [],
      action: safeResult ? result.j.action : 'finish',
      question_category: safeResult && !riskAssessment ? result.j.question_category || null : null,
      stop_reason: safeResult ? riskAssessment ? 'reviewed_risk_rule' : result.j.stop_reason || null : 'model_failed',
      created_at: now(), version: 1, ai_failed: !safeResult,
      ...(failureCode ? { error_code: failureCode } : {}),
      ...(providerHttpStatus ? { provider_http_status: providerHttpStatus } : {}),
      ...(safeResult && riskAssessment ? { risk_assessment: riskAssessment, reviewed_risk_validated: true } : {}),
    };
    const next = {
      ...conversation,
      turns: [...conversation.turns.map((turn, index) => index === conversation.turns.length - 1 && turn.ai_failed ? { ...turn, superseded: true } : turn), assistant],
      controller: safeResult && riskAssessment ? { ...conversation.controller, last_question_category: null }
        : safeResult && result.j.controller ? result.j.controller : conversation.controller,
      completeness: safeResult && result.j.completeness ? result.j.completeness : conversation.completeness,
      analysis_sources: safeResult && result.j.completeness ? analysisSources(conversation) : conversation.analysis_sources || null,
      manual_correction_analysis_pending: safeResult && result.j.completeness ? false : conversation.manual_correction_analysis_pending === true,
      relevant_health_context: safeResult && result.j.completeness ? (conversation.health_context || []).filter(item => result.j.completeness.relevant_context_ids?.includes(item.context_id)) : conversation.relevant_health_context || [],
      last_ai_metadata: safeResult ? { provider: result.j.provider, model_id: result.j.model_id, prompt_version: result.j.prompt_version, trace_id: result.j.trace_id } : { ai_failed: true, error: failureCode },
    };
    const current = invalidateChangedAnalysis(next, currentContext);
    current.report = await buildCurrentConversationReport(current, conversation.report, currentContext);
    const reportHistory=reportHistoryIncluding(conversation.report_history,conversation.report,current.report);
    const saved = { ...current,...(reportHistory.length?{report_history:reportHistory}:{}), version: conversation.version + 1, updated_at: now() };
    const registry = await healthSubjects();
    if (registry.active_subject_id !== subjectOf(conversation)) return { conversation: storedConversation, applied: false };
    const contextGuard = [{ key: HEALTH_SUBJECTS_KEY, value: registry }, ...extraGuards];
    if (conversation.selected_context_ids?.length) {
      const rawContext = await vault.get(healthContextKey(subjectOf(conversation)));
      if (Number(rawContext?.version || 0) !== currentContext.version) return { conversation: storedConversation, applied: false };
      contextGuard.push({ key: healthContextKey(subjectOf(conversation)), value: rawContext });
    }
    const latestQuote = elderTurns(storedConversation).at(-1)?.quote_context || null;
    if (JSON.stringify(latestQuote) !== JSON.stringify(sendingQuote)) return { conversation: storedConversation, applied: false };
    if (latestQuote) {
      if (!await quoteContextCurrent(storedConversation, latestQuote)) return { conversation: storedConversation, applied: false };
      const source = latestQuote.source;
      if (source.record_id) {
        const event = await vault.get(eventKey(source.record_id));
        if (!event || event.version !== source.record_version || event.raw_text !== latestQuote.text || event.state === 'superseded') {
          return { conversation: storedConversation, applied: false };
        }
        contextGuard.push({ key: eventKey(source.record_id), value: event });
      }
      if (source.media_id) {
        const media = await vault.get(mediaKey(source.media_id)), original = await vault.get(mediaBinaryKey(source.media_id));
        if (!media || media.version !== source.media_version || !original?.bytes) return { conversation: storedConversation, applied: false };
        contextGuard.push({ key: mediaKey(source.media_id), value: media }, { key: mediaBinaryKey(source.media_id), value: original });
      }
      if (latestQuote.role === 'assistant') {
        const contextKey = healthContextKey(subjectOf(storedConversation)), rawContext = await vault.get(contextKey);
        if (!contextGuard.some(guard => guard.key === contextKey)) contextGuard.push({ key: contextKey, value: rawContext });
      }
    }
    if (await vault.putIfUnchanged(conversationKey(conversation.conversation_id), storedConversation, saved, contextGuard)) {
      return { conversation: saved, applied: true };
    }
    const latest = await vault.get(conversationKey(conversation.conversation_id));
    if (!latest) throw new Error('conversation_not_found');
    return { conversation: latest, applied: false };
  }

  async function conversationReply(conversation, trialContinue = false, savedAudioTrial = null, newTextTrial = null, correctionReorganization = null) {
    if (conversation.trial_control && !trialContinue && !correctionReorganization) return fail(409, 'trial_review_required');
    const [conversationEvents, conversationMedia] = await Promise.all([listEvents(), mediaList()]);
    conversation = reconcileConversationAudioReview(conversation, conversationEvents, conversationMedia);
    if (liveConversationTurns(conversation).some(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript'
      && (turn.audio_source_invalidated === true || turn.audio_source_reviewed !== true
        && !['machine_transcribed', 'user_edited'].includes(turn.audio_source_status)))) return fail(409, 'audio_source_review_required');
    const latest = elderTurns(conversation).at(-1);
    if (latest?.local_safety?.danger_detected) {
      return ok(200, { action: 'urgent', assistant_text: safety.DANGER_REMINDER,
        provider: 'LocalDangerRule', stop_reason: 'urgent_rule',
        controller: { ...conversation.controller, last_question_category: null } });
    }
    return cloudRequest('/api/ai/conversation-turn', { healthSubjectId: subjectOf(conversation), method: 'POST', body: JSON.stringify(await conversationModelPayload(conversation)), ...(savedAudioTrial ? { savedAudioTrial, headers: { 'X-NoReset-Saved-Audio-Trial': savedAudioTrial.grant.grant_id } } : {}), ...(newTextTrial ? { newTextTrial, headers: { 'X-NoReset-Text-Trial': newTextTrial.grant.grant_id } } : {}), ...(correctionReorganization ? { correctionReorganization, ...(correctionReorganization.mode==='text_trial'?{headers:{'X-NoReset-Text-Trial':correctionReorganization.grant.grant_id}}:{}) } : {}), ...(trialContinue ? { trialVoiceContinue: { ...conversation.trial_control, conversation_version: conversation.version } } : {}) });
  }

  async function conversationRequest(path, options, locked = false, sourceLocked = false, backgroundInactive = false, lockedSourceRecordId = null) {
    const method = options?.method || 'GET';
    const pathname = path.split('?')[0];
    const parts = pathname.split('/').filter(Boolean);
    if (!locked && method !== 'GET' && parts[2] && !['start', 'current'].includes(parts[2])) {
      return withConversationLock(parts[2], () => conversationRequest(path, options, true));
    }
    const body = parseBody(options);
    if (body.subject_id && body.subject_id !== await activeSubjectId()) return fail(403, 'subject_mismatch');
    if (!sourceLocked && method === 'POST' && parts[3] === 'turns' && parts.length === 4) {
      // Existing-source linking participates in archive correction/deletion
      // locks so a new conversation cannot acquire a source midway through it.
      const lockIds=[];if(body.record_id)lockIds.push(body.record_id);
      if(body.quote_ref?.turn_id){
        const targetConversation=await vault.get(conversationKey(decodeURIComponent(parts[2]||'')));
        const target=targetConversation?.turns?.find(turn=>turn.turn_id===body.quote_ref.turn_id);
        if(target?.role==='elder'&&target.record_id)lockIds.push(target.record_id);
      }
      if(lockIds.length)return withEventLocks(lockIds,()=>conversationRequest(path,options,true,true));
    }
    if (pathname === '/api/conversations/saved-audio-trial/start' && method === 'POST') {
      if (!sourceLocked) return withEventLock(body.record_id, () => conversationRequest(path, options, true, true));
      return startSavedAudioTrial(body);
    }
    if (pathname === '/api/conversations' && method === 'GET') {
      const conversations = await Promise.all((await listConversations()).filter(item => item.turns.some(turn => turn.role === 'elder' && !turn.superseded)).map(conversationArchiveView));
      return ok(200, { ok: true, conversations });
    }
    if (pathname === '/api/conversations/current' && method === 'GET') {
      const params = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
      const localDate = params.get('local_date');
      if (!validLocalDate(localDate)) return fail(400, 'local_date_invalid');
      const conversations = await listConversations();
      const sameDay = conversations.find(item => item.last_local_date === localDate) || null;
      if (sameDay) return ok(200, { ok: true, conversation: await withSavedOnlyTextFirstSendState(await conversationWithCurrentReport(sameDay)), resume_choice_required: false });
      const latest = conversations.find(item => elderTurns(item).length > 0) || conversations[0] || null;
      if (!latest) return ok(200, { ok: true, conversation: null, resume_choice_required: false });
      return ok(200, { ok: true, conversation: null, previous_conversation: await conversationWithCurrentReport(latest), resume_choice_required: true });
    }
    if (pathname === '/api/conversations/start' && method === 'POST') {
      if (!validLocalDate(body.local_date)) return fail(400, 'local_date_invalid');
      if (body.mode === 'continue') {
        const conversations = await listConversations();
        const latest = conversations.find(item => elderTurns(item).length > 0) || conversations[0];
        if (!latest) return createConversation(body.local_date);
        const continued = await saveConversation({ ...latest, status: 'active', last_local_date: body.local_date });
        return ok(200, { ok: true, conversation: await withSavedOnlyTextFirstSendState(continued) });
      }
      if (body.mode !== 'new') return fail(400, 'conversation_mode_invalid');
      return createConversation(body.local_date);
    }
    const conversationId = decodeURIComponent(parts[2] || '');
    const storedConversation = await vault.get(conversationKey(conversationId));
    if (storedConversation && subjectOf(storedConversation) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
    if (parts.length === 4 && parts[3] === 'refresh-report' && method === 'POST') {
      return refreshConversationReport(conversationId, body);
    }
    let conversation = excludeMockFacts(storedConversation);
    if (!conversation) return fail(404, 'conversation_not_found');
    if(parts[3]==='legacy-reorganization-output'&&parts[4]&&parts[5]==='confirm'&&parts.length===6&&method==='POST'){
      const registry=await healthSubjects(),active=await activeSubjectId(registry),turnId=decodeURIComponent(parts[4]);
      const candidate=legacyReorganizationOutputCandidate(storedConversation);
      const turn=candidate?.turn;
      if(body.confirmed!==true||body.expected_conversation_version!==storedConversation.version
        ||body.expected_subject_id!==active||body.expected_subject_id!==subjectOf(storedConversation)
        ||body.expected_subject_version!==registry.version||body.expected_turn_id!==turnId
        ||!turn||turn.turn_id!==turnId||body.expected_turn_version!==turn.version||body.expected_turn_text!==turn.text
        ||body.expected_trace_id!==candidate.trace_id||body.expected_provider!==candidate.provider||body.expected_scope_id!==candidate.scope_id
        ||body.expected_body_sha256!==candidate.body_sha256)return fail(409,'legacy_reorganization_output_changed',{conversation:await conversationArchiveView(storedConversation)});
      const confirmedAt=now(),review={state:'confirmed',turn_id:turn.turn_id,turn_version:turn.version,
        trace_id:candidate.trace_id,provider:candidate.provider,scope_id:candidate.scope_id,body_sha256:candidate.body_sha256,confirmed_by:'local_user',confirmed_at:confirmedAt};
      let report=storedConversation.report;
      if(report&&Array.isArray(report.transcript)){
        const matching=report.transcript.filter(item=>item.turn_id===turnId);
        if(matching.some(item=>item.role!=='assistant'||item.text!==turn.text)||matching.length>1)
          return fail(409,'legacy_reorganization_report_changed',{conversation:await conversationArchiveView(storedConversation)});
      }
      const turns=storedConversation.turns.map(item=>item.turn_id===turnId?{...item,superseded:true,
          legacy_reorganization_history:{kind:'legacy_corrected_reorganization_reply',trace_id:candidate.trace_id,provider:candidate.provider,
          scope_id:candidate.scope_id,body_sha256:candidate.body_sha256,confirmed_by:'local_user',confirmed_at:confirmedAt}}:item);
      const nextTranscript=report?.transcript?.filter(item=>item.turn_id!==turnId);
      const coverage=report?questionCoverage({...storedConversation,turns},report,await healthContext(subjectOf(storedConversation))):null;
      const reportChanged=Boolean(report&&((Array.isArray(report.transcript)&&nextTranscript.length!==report.transcript.length)
        ||JSON.stringify(report.question_coverage)!==JSON.stringify(coverage)));
      if(reportChanged)report={...report,...(Array.isArray(report.transcript)?{transcript:nextTranscript}:{}),question_coverage:coverage,
        version:(Number.isSafeInteger(report.version)?report.version:0)+1,generated_at:confirmedAt};
      const saved={...storedConversation,turns,
        report,
        ...(reportChanged?{report_history:reportHistoryIncluding(storedConversation.report_history,storedConversation.report,report)}:{}),
        manual_correction_reorganization:{...storedConversation.manual_correction_reorganization,legacy_reply_review:review},
        version:storedConversation.version+1,updated_at:confirmedAt};
      try{await ownedMutation({puts:[{key:conversationKey(conversationId),value:saved}],unchanged:[{key:conversationKey(conversationId),value:storedConversation}]});}
      catch{return fail(409,'legacy_reorganization_output_changed',{conversation:await conversationArchiveView(await vault.get(conversationKey(conversationId))||storedConversation)});}
      return ok(200,{ok:true,conversation:await conversationArchiveView(saved)});
    }
    const [currentEvents, currentMedia] = await Promise.all([listEvents(), mediaList()]);
    conversation = reconcileConversationAudioReview(conversation, currentEvents, currentMedia);
    if (parts[3] === 'corrections' && parts[4] && parts.length === 5 && method === 'POST' && !sourceLocked) {
      const targetId = String(parseBody(options).target_turn_id || '');
      const target = conversation.turns.find(turn => turn.turn_id === targetId && !turn.superseded);
      if (target?.record_id) return withEventLock(target.record_id,
        () => conversationRequest(path, options, true, true, backgroundInactive, target.record_id));
    }
    if (parts[3] === 'corrections' && parts[4] && parts.length === 5 && method === 'POST') {
      const correctionId = decodeURIComponent(parts[4]);
      const correction = conversation.turns.find(turn => turn.turn_id === correctionId);
      if (body.confirmed !== true) return fail(400, 'correction_confirmation_required');
      if (['new_quote', 'new_text', 'replacement', 'replacement_text'].some(key => Object.prototype.hasOwnProperty.call(body, key))) {
        return fail(400, 'correction_replacement_must_come_from_source');
      }
      if (!Number.isSafeInteger(body.expected_conversation_version)
        || body.expected_conversation_version !== conversation.version) return fail(409, 'stale_conversation');
      if (!correction || correction.superseded || correction.role !== 'elder' || correction.source_kind !== 'elder'
        || correction.media_id || mockSource(correction)) return fail(409, 'correction_not_pending');
      if (!Number.isSafeInteger(body.expected_correction_version)
        || body.expected_correction_version !== correction.version) return fail(409, 'stale_correction');
      const isPending = (conversation.completeness?.contradictions || []).some(note => note.text === UNRESOLVED_CORRECTION_NOTE
        && Array.isArray(note.evidence_turn_ids) && note.evidence_turn_ids.includes(correctionId));
      if (!isPending || (conversation.manual_corrections || []).some(item => item.correction_turn_id === correctionId)) {
        return fail(409, 'correction_not_pending');
      }
      const parsed = explicitNaturalCorrection(correction.text);
      if (!parsed) return fail(409, 'correction_not_pending');
      const targetId = String(body.target_turn_id || '');
      const targetIndex = conversation.turns.findIndex(turn => turn.turn_id === targetId && !turn.superseded);
      const correctionIndex = conversation.turns.findIndex(turn => turn.turn_id === correctionId);
      const target = targetIndex >= 0 ? conversation.turns[targetIndex] : null;
      const quote = typeof body.old_quote === 'string' ? body.old_quote : '';
      if (sourceLocked && lockedSourceRecordId && target?.record_id !== lockedSourceRecordId) return fail(409, 'conversation_source_changed');
      if (!target || targetIndex >= correctionIndex || target.role !== 'elder' || target.source_kind !== 'elder'
        || target.media_id || mockSource(target) || !quote || quote !== quote.trim()
        || !Number.isSafeInteger(body.expected_target_version) || body.expected_target_version !== target.version
        || !fullSentenceQuotes(target.text).includes(quote) || exactOccurrenceCount(target.text, quote) !== 1) {
        return fail(409, 'correction_target_invalid');
      }
      if (latestEditableOwnTurn(conversation)?.turn_id !== target.turn_id) return fail(409, 'correction_target_not_latest');
      if (target.record_id ? !Number.isSafeInteger(body.expected_event_version) : body.expected_event_version !== null) {
        return fail(400, 'correction_source_version_required');
      }
      const replacement = parsed.newQuote;
      const updatedTargetText = target.text.replace(quote, replacement);
      if (updatedTargetText === target.text) return fail(409, 'correction_target_invalid');
      const timestamp = now(), puts = [], unchanged = [{ key: conversationKey(conversationId), value: storedConversation }];
      if (target.record_id) {
        const event = await readEvent(target.record_id);
        if (!event || event.record_id !== target.record_id || event.state === 'superseded'
          || event.source_kind !== 'elder' || (event.subject_id || SELF_SUBJECT_ID) !== subjectOf(conversation)
          || event.raw_text !== target.text || event.version !== body.expected_event_version
          || event.source_conversation_id && event.source_conversation_id !== conversationId) {
          return fail(409, 'conversation_source_changed');
        }
        const foreignOwners = (await conversationsUsingRecords([event.record_id])).some(owner => owner.conversation_id !== conversationId
          && owner.turns.some(turn => turn.role === 'elder' && !turn.superseded && turn.record_id === event.record_id));
        if (foreignOwners) return fail(409, 'conversation_source_changed');
        const updatedEvent = { ...event, raw_text: updatedTargetText, updated_at: timestamp, version: event.version + 1,
          state: 'inbox', local_safety: safety.scanDanger(updatedTargetText), draft: null, ai_metadata: null };
        puts.push(historyDocument(event, 'conversation_confirmed_correction', '使用者在同一对话中明确选择并确认替换整句；仅核对文字，不代表医学确认'));
        puts.push({ key: eventKey(event.record_id), value: updatedEvent });
        unchanged.push({ key: eventKey(event.record_id), value: event });
      }
      const manualCorrection = {
        correction_turn_id: correctionId, correction_version: correction.version, correction_text: correction.text,
        target_turn_id: target.turn_id, target_version_before: target.version, target_version_after: target.version + 1,
        old_quote: quote, new_quote: replacement, target_text_before: target.text, target_text_after: updatedTargetText,
        record_id: target.record_id || null, subject_id: subjectOf(conversation), confirmed_by: 'local_user',
        confirmation_scope: 'text_revision_only_not_medical_confirmation', confirmed_at: timestamp,
      };
      const turns = conversation.turns.map((turn, index) => {
        if (index === targetIndex) return { ...turn, text: updatedTargetText, local_safety: safety.scanDanger(updatedTargetText),
          version: turn.version + 1, edited_at: timestamp,
          versions: [...(turn.versions || []), { version: turn.version, text: turn.text, record_id: turn.record_id || null, replaced_at: timestamp }] };
        if ((index > targetIndex && turn.role === 'assistant') || turn.turn_id === correctionId) return { ...turn, superseded: true };
        return turn;
      });
      const edited = { ...conversation, turns, version: conversation.version + 1, updated_at: timestamp,
        controller: editedConversationController(conversation.controller), completeness: null, analysis_sources: null,
        relevant_health_context: [], manual_corrections: [...(conversation.manual_corrections || []), manualCorrection],
        manual_correction_analysis_pending: true };
      edited.report = buildConversationReport(edited, conversation.report);
      edited.report_history=reportHistoryIncluding(conversation.report_history,conversation.report,edited.report);
      puts.push({ key: conversationKey(conversationId), value: edited });
      try { await ownedMutation({ puts, unchanged }); }
      catch (error) { return fail(409, error.message === 'document_changed' ? 'conversation_source_changed' : 'correction_save_failed'); }
      return ok(200, { ok: true, ai_failed: false, model_called: false, conversation: edited });
    }
    if (parts.length === 3 && method === 'DELETE') {
      if (body.delete_scope_confirmed !== true) return fail(400, 'delete_confirmation_required');
      if (Number(body.expected_version) !== conversation.version) return fail(409, 'stale_conversation');
      const recordIds = [...new Set(conversation.turns.filter(turn => turn.role === 'elder').map(turn => turn.record_id).filter(Boolean))];
      const turnMediaIds = [...new Set(conversation.turns.map(turn => turn.media_id).filter(value => typeof value === 'string' && value))];
      const component = await eventRevisionComponent(recordIds);
      const lockedRecords = new Set([...recordIds, ...component.recordIds]);
      const lockedMedia = new Set(turnMediaIds);
      const mediaReferenceError = async (ids, ownedRecordIds) => {
        const ownedRecords = new Set(ownedRecordIds);
        for (const mediaId of ids) {
          const media = await vault.get(mediaKey(mediaId));
          if (!media) {
            if (await vault.get(mediaBinaryKey(mediaId))) return 'conversation_media_owner_unknown';
            continue;
          }
          if (subjectOf(media) !== subjectOf(conversation)) return 'conversation_media_owner_mismatch';
          const linkedRecordId = media.event_link?.record_id || media.record_id;
          if (linkedRecordId && !ownedRecords.has(linkedRecordId)) return 'conversation_source_shared';
          if (media.conversation_id && media.conversation_id !== conversationId
            && await vault.get(conversationKey(media.conversation_id))) return 'conversation_source_shared';
        }
        return null;
      };
      // The atomic plan covers item.conversation_id === conversationId media,
      // removeEventBody(recordId) history/event keys, and remove(conversationKey(conversationId)).
      while (true) {
        const result = await withEventLocks([...lockedRecords], async () => {
          const currentComponent = await eventRevisionComponent(recordIds);
          if (currentComponent.recordIds.some(id => !lockedRecords.has(id))) return { retryRecords: currentComponent.recordIds };
          if ((await conversationsUsingRecords(currentComponent.recordIds)).some(item => item.conversation_id !== conversationId)) {
            return { error: 'conversation_source_shared' };
          }
          const mediaOwners = await vault.list('conversation:');
          const sharesDeletedScope = (owners, mediaIds, recordIds) => owners.some(item => item.conversation_id !== conversationId
            && item.turns.some(turn => mediaIds.has(turn.media_id) || recordIds.has(turn.record_id)));
          if (sharesDeletedScope(mediaOwners, new Set(turnMediaIds), new Set(currentComponent.recordIds))) {
            return { error: 'conversation_source_shared' };
          }
          const initialPlan = await collectDeletionPlan(currentComponent.recordIds, conversationId, turnMediaIds);
          if (sharesDeletedScope(mediaOwners, new Set(initialPlan.mediaIds), new Set(currentComponent.recordIds))) {
            return { error: 'conversation_source_shared' };
          }
          if (initialPlan.mediaIds.some(id => !lockedMedia.has(id))) return { retryMedia: initialPlan.mediaIds };
          return withMediaLocks([...lockedMedia], async () => {
            const latestComponent = await eventRevisionComponent(recordIds);
            if (latestComponent.recordIds.some(id => !lockedRecords.has(id))) return { retryRecords: latestComponent.recordIds };
            const referenceError = await mediaReferenceError(turnMediaIds, latestComponent.recordIds);
            if (referenceError) return { error: referenceError };
            const latestPlan = await collectDeletionPlan(latestComponent.recordIds, conversationId, turnMediaIds);
            if (latestPlan.mediaIds.some(id => !lockedMedia.has(id))) return { retryMedia: latestPlan.mediaIds };
            const latestOwners = await vault.list('conversation:');
            if (sharesDeletedScope(latestOwners, new Set(latestPlan.mediaIds), new Set(latestComponent.recordIds))) {
              return { error: 'conversation_source_shared' };
            }
            await ownedMutation({ deletes: latestPlan.deletes });
            return { ok: true, plan: latestPlan };
          });
        });
        if (result.retryRecords) {
          for (const id of result.retryRecords) lockedRecords.add(id);
          continue;
        }
        if (result.retryMedia) {
          for (const id of result.retryMedia) lockedMedia.add(id);
          continue;
        }
        if (['conversation_source_shared', 'conversation_media_owner_mismatch', 'conversation_media_owner_unknown'].includes(result.error)) return fail(409, result.error, {
          message: result.error === 'conversation_source_shared'
            ? '这段对话引用的资料还被其他对话或记录使用，暂不能删除。当前资料未被删除。'
            : '无法确认这段对话关联原件的所属人；本次没有删除，请先核对原件关联。',
        });
        if (!result.ok) return fail(409, 'stale_delete_scope');
        return ok(200, { ok: true, deleted: { conversation_id: conversationId, record_count: result.plan.recordIds.length,
          local_media_count: result.plan.mediaIds.length, media_ids: result.plan.mediaIds,
          pending_upload_count: result.plan.uploadIds.length, encrypted_backups_unchanged: true } });
      }
    }
    if (parts.length === 3 && method === 'GET') {
      return ok(200, { ok: true, conversation: await conversationCurrentView(conversation, currentEvents, currentMedia) });
    }
    if (parts[3] === 'turns' && parts[4] && parts[5] === 'first-send' && method === 'POST') {
      const current = await vault.get(conversationKey(conversationId));
      const turns = liveConversationTurns(current), turn = turns.find(item => item.turn_id === decodeURIComponent(parts[4]));
      if (!current || !turn || turns.at(-1)?.turn_id !== turn.turn_id) return fail(409, 'new_text_trial_not_available');
      const registry = await healthSubjects(), subjectId = await activeSubjectId(registry);
      const contextSnapshot = await vault.get(healthContextKey(subjectId)), context = await healthContext(subjectId);
      const event = turn.record_id ? await vault.get(eventKey(turn.record_id)) : null;
      const previousTrial = await trialVoiceState();
      if (body.expected_conversation_version !== current.version || body.expected_turn_version !== turn.version
        || body.expected_event_version !== event?.version || body.expected_context_version !== context.version
        || body.expected_subject_version !== registry.version || body.expected_subject_id !== subjectId
        || subjectId !== subjectOf(current) || !await savedOnlyTextFirstSendAvailable(current)) {
        return fail(409, 'new_text_trial_source_changed', { conversation: await withSavedOnlyTextFirstSendState(current) });
      }
      const result = await runFreshTextTrial(current, previousTrial, registry, contextSnapshot, event, turn);
      const latest = result.conversation || await vault.get(conversationKey(conversationId));
      const responseConversation = await withSavedOnlyTextFirstSendState(latest);
      if (!result.dispatched) return ok(200, { ok: true, dispatched: false,
        text_trial: { state: responseConversation?.new_text_trial?.state || 'saved_only', reason: result.reason }, conversation: responseConversation });
      return ok(result.ai_failed ? 202 : 200, { ok: true, dispatched: true, ai_failed: result.ai_failed,
        text_trial: { state: result.reason }, conversation: responseConversation });
    }
    if (parts.length === 4 && parts[3] === 'reorganize-corrected' && method === 'POST') {
      const current = await vault.get(conversationKey(conversationId));
      const registry = await healthSubjects(), context = await healthContext(subjectOf(current));
      if (!current || body.expected_conversation_version !== current.version
        || body.expected_subject_id !== subjectOf(current) || body.expected_subject_version !== registry.version
        || body.expected_context_version !== context.version || current.manual_correction_analysis_pending !== true) {
        return fail(409, 'correction_reorganization_source_changed', { conversation: current });
      }
      if (liveConversationTurns(current).some(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript'
        && (turn.audio_source_invalidated === true || turn.audio_source_reviewed !== true
          && !['machine_transcribed', 'user_edited'].includes(turn.audio_source_status)))) {
        return fail(409, 'audio_source_review_required', { conversation: current });
      }
      const result = await runCorrectionReorganization(current);
      const latest = await vault.get(conversationKey(conversationId));
      const returned = await withSavedOnlyTextFirstSendState(latest || result.conversation);
      if (!result.dispatched) return ok(200, { ok:true, dispatched:false, reason:result.reason, conversation:returned });
      return ok(result.reason === 'completed' ? 200 : 202, { ok:true, dispatched:true, reason:result.reason,
        ai_failed:result.reason !== 'completed', conversation:returned });
    }
    if (parts.length === 4 && parts[3] === 'context' && method === 'POST') {
      const ids = body.context_ids;
      const current = await healthContext();
      if (!Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length
        || ids.some(value => typeof value !== 'string' || !current.entries.some(item => item.context_id === value && usableHealthEntry(item, subjectOf(conversation))))) {
        return fail(400, 'context_selection_invalid');
      }
      return (async () => {
        const latest = await vault.get(conversationKey(conversationId));
        const selected = new Set(ids);
        const removed = (latest.selected_context_ids || []).filter(value => !selected.has(value));
        const staleSources = invalidatedRespondingSources(latest, removed);
        let updated = { ...latest, selected_context_ids: ids,
          stale_responding_to_turn_ids: staleSources,
          controller: invalidateContextController(latest, removed, staleSources),
          health_context: current.entries.filter(item => selected.has(item.context_id)),
          health_context_version: current.version,
          relevant_health_context: (latest.relevant_health_context || []).filter(item => selected.has(item.context_id)),
          completeness: latest.completeness ? { ...latest.completeness,
            relevant_context_ids: (latest.completeness.relevant_context_ids || []).filter(value => selected.has(value)) } : null };
        updated = invalidateChangedAnalysis(updated, current);
        updated.report = await buildCurrentConversationReport(updated, latest.report, current);
        return ok(200, { ok: true, conversation: await saveConversation(updated) });
      })();
    }
    if (parts[3] === 'trial-continue' && method === 'POST') {
      let latest = await vault.get(conversationKey(conversationId));
      const control = latest?.trial_control, global = await trialVoiceState();
      if (!control || control.state !== 'review_required' || global?.state !== 'review_required' || !sameTrialOwner(control, global)
        || control.conversation_id !== conversationId) return fail(409, 'trial_stopped_or_not_pending', { conversation: latest });
      const turn = elderTurns(latest).at(-1), event = turn?.record_id ? await readEvent(turn.record_id) : null;
      if (Number(body.expected_version) !== latest.version || body.turn_id !== control.turn_id || Number(body.turn_version) !== control.turn_version
        || turn?.turn_id !== control.turn_id || turn?.version !== control.turn_version || !event || event.raw_text !== turn.text) return fail(409, 'trial_source_changed', { conversation: latest });
      latest = await saveTrialConversation(latest, { ...control, state: 'continuing' }, [], [{ key: conversationKey(conversationId), value: latest }, { key: TRIAL_VOICE_KEY, value: global }]);
      const continuingControl = latest.trial_control;
      let result;
      try { result = await conversationReply(latest, true); } catch { result = fail(0, 'network_unavailable'); }
      const marker = trialMarker(result.j);
      if (marker?.state === 'stopped') result = fail(422, 'trial_stopped');
      const appended = await appendAssistantResult(latest, result);
      latest = appended.conversation;
      if (!appended.applied) return ok(202, { ok: true, conversation: latest, result_discarded: true, trial_control: latest.trial_control });
      latest = await saveTrialConversation(latest, { ...control, state: latest.last_ai_metadata?.ai_failed ? 'stopped' : 'completed' }, [], [{ key: conversationKey(conversationId), value: latest }, { key: TRIAL_VOICE_KEY, value: continuingControl }]);
      const media = await vault.get(mediaKey(control.media_id));
      if (media) await ownedPut(mediaKey(control.media_id), { ...media, trial_control: latest.trial_control });
      return ok(latest.trial_control.state === 'completed' ? 200 : 202, { ok: true, conversation: latest, ai_failed: latest.trial_control.state === 'stopped', trial_control: latest.trial_control });
    }
    if (parts[3] === 'resume-assistant' && method === 'POST') {
      return (async () => {
        const [events, mediaItems] = await Promise.all([listEvents(), mediaList()]);
        let latest = reconcileConversationAudioReview(excludeMockFacts(await vault.get(conversationKey(conversationId))), events, mediaItems);
        if (liveConversationTurns(latest).some(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript'
          && (turn.audio_source_invalidated === true || turn.audio_source_reviewed !== true
            && !['machine_transcribed', 'user_edited'].includes(turn.audio_source_status)))) {
          return ok(200, { ok: true, recovered: false, ai_failed: false, conversation: latest, pending_reason: 'audio_source_review_required' });
        }
        const trial = await trialVoiceState();
        if (latest?.trial_control || trial && trial.state !== 'completed') return ok(200, { ok: true, conversation: await withSavedOnlyTextFirstSendState(latest), trial_control: latest?.trial_control || trial, recovered: false });
        const pending = pendingElderTurn(latest);
        if (!pending) return ok(200, { ok: true, recovered: false, ai_failed: false, conversation: latest });
        if (pending.source_kind === 'audio_transcript' && ['machine_transcribed', 'user_edited'].includes(pending.audio_source_status)) {
          if (body.explicit_audio_retry !== true) return ok(200, { ok: true, recovered: false, ai_failed: false, conversation: latest, pending_reason: 'audio_reply_requires_user_retry' });
          if (body.expected_version !== latest.version) return fail(409, 'stale_conversation', { conversation: latest });
          const eventIndex = new Map(events.map(item => [item.record_id, item])), mediaIndex = new Map(mediaItems.map(item => [item.media_id, item]));
          if (!audioConversationSourceCurrent(pending, eventIndex, mediaIndex, latest.conversation_id)) return fail(409, 'audio_source_changed', { conversation: latest });
          const result = await conversationReply(latest);
          const appended = await appendAssistantResult(latest, result);
          return ok(result.r.ok ? 200 : 202, { ok: true, recovered: appended.applied,
            result_discarded: !appended.applied, ai_failed: !!appended.conversation.last_ai_metadata?.ai_failed,
            conversation: appended.conversation });
        }
        if (latest.new_text_trial?.turn_id === pending.turn_id) return ok(200, { ok: true, recovered: false, ai_failed: false, conversation: await withSavedOnlyTextFirstSendState(latest), pending_reason: 'new_text_trial_no_replay' });
        const result = await conversationReply(latest);
        const appended = await appendAssistantResult(latest, result);
        latest = appended.conversation;
        return ok(result.r.ok ? 200 : 202, { ok: true, recovered: appended.applied, result_discarded: !appended.applied, ai_failed: !!latest.last_ai_metadata?.ai_failed, conversation: latest });
      })();
    }
    if (parts[3] === 'turns' && parts.length === 4 && method === 'POST') {
      const text = String(body.text || '').trim();
      if (!text || text.length > 10000) return fail(400, 'turn_text_invalid');
      if (mockSource({ text })) return fail(409, 'media_mock_unavailable');
      const operationKey = options?.headers?.['Idempotency-Key'];
      if (!operationKey) return fail(400, 'idempotency_key_required');
      const replay = await vault.get(`operation:conversation-turn:${operationKey}`);
      if (replay) {
        const saved = await vault.get(conversationKey(replay.conversation_id));
        if (saved && subjectOf(saved) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
        return ok(200, { ok: true, created: false, conversation: saved, turn_id: replay.turn_id });
      }
      const sourceMedia = body.media_id ? await vault.get(mediaKey(body.media_id)) : null;
      if (sourceMedia && subjectOf(sourceMedia) !== subjectOf(conversation)) return fail(403, 'subject_mismatch');
      const trial = await trialVoiceState();
      const pendingAudioTrial = sourceMedia?.kind === 'audio' && sourceMedia.trial_control?.state === 'review_required'
        && trial?.state === 'review_required' && trial.media_id === sourceMedia.media_id
        && trial.conversation_id === conversationId && sourceMedia.conversation_id === conversationId;
      let controlled = pendingAudioTrial ? trial : sourceMedia?.trial_control?.state === 'completed' ? null : sourceMedia?.trial_control;
      const controlledText = !controlled && conversation.trial_control && !body.media_id && !body.record_id
        && (!body.source_kind || body.source_kind === 'elder');
      if (controlledText) {
        const control = conversation.trial_control, last = elderTurns(conversation).at(-1);
        if (control.state !== 'completed' || trial?.state !== 'completed' || !sameTrialOwner(control, trial)
          || control.conversation_id !== conversationId || last?.turn_id !== control.turn_id || last?.version !== control.turn_version) {
          return fail(409, trial?.state === 'stopped' || control.state === 'stopped' ? 'trial_stopped' : 'trial_review_required');
        }
        if ((await mediaList()).some(item => item.kind === 'audio' && item.recognition_status === 'processing')) return fail(409, 'audio_recognition_in_progress');
        controlled = { review_required: true, state: 'review_required', source_kind: 'elder' };
      }
      const unrelatedText = !controlled && !conversation.trial_control && !sourceMedia && !body.media_id && !body.record_id
        && (!body.source_kind || body.source_kind === 'elder') && unrelatedTextTrialStop(trial, conversationId);
      if (trial && trial.state !== 'completed' && !controlled && !unrelatedText) return fail(409, trial.state === 'stopped' ? 'trial_stopped' : 'trial_review_required');
      if (conversation.trial_control && !controlled) return fail(409, 'trial_review_required');
      if (controlled && !controlledText && sourceMedia?.conversation_id !== conversationId) return fail(409, 'trial_source_changed');
      if (Number(body.expected_version) !== conversation.version) return fail(409, 'stale_conversation');
      if (liveConversationTurns(conversation).some(turn => turn.role === 'elder' && turn.source_kind === 'audio_transcript'
        && (turn.audio_source_invalidated === true || turn.audio_source_reviewed !== true
          && !['machine_transcribed', 'user_edited'].includes(turn.audio_source_status)))) return fail(409, 'audio_source_review_required');
      let explicitRespondingTo = null;
      if (Object.prototype.hasOwnProperty.call(body,'quote_ref')) {
        const ref=body.quote_ref,keys=ref&&typeof ref==='object'&&!Array.isArray(ref)?Object.keys(ref).sort():[];
        if(keys.join(',')!=='turn_id,version'||typeof ref.turn_id!=='string'||!Number.isSafeInteger(ref.version)||ref.version<1
          ||Object.prototype.hasOwnProperty.call(body,'responding_to'))return fail(400,'quote_context_invalid');
        if(body.media_id&&controlled||controlledText||unrelatedText||conversation.trial_control||conversation.saved_audio_trial
          ||trial&&trial.state!=='completed')return fail(409,'quote_context_stale');
        const matches=conversation.turns.filter(turn=>turn.turn_id===ref.turn_id),target=matches[0];
        if(matches.length!==1||!target||target.superseded||target.ai_failed||mockSource(target)
          ||(target.version??1)!==ref.version||!['elder','assistant'].includes(target.role))return fail(409,'quote_context_stale');
        const source=target.role==='assistant'?{source_kind:'assistant_message',record_id:null,record_version:null,media_id:null,media_version:null}:await (async()=>{
          if(!target.record_id)return null;
          const event=await readEvent(target.record_id);if(!event||event.state==='superseded'||event.raw_text!==target.text)return null;
          if(target.source_kind!=='audio_transcript')return event.source_kind==='elder'?{source_kind:'elder',record_id:event.record_id,record_version:event.version,media_id:null,media_version:null}:null;
          const media=target.media_id?await vault.get(mediaKey(target.media_id)):null;
          if(!media||media.kind!=='audio'||mockSource(media)||media.recognition_status!=='succeeded'
            ||!(await vault.get(mediaBinaryKey(media.media_id)))?.bytes)return null;
          return {source_kind:'audio_transcript',record_id:event.record_id,record_version:event.version,media_id:media.media_id,media_version:media.version};
        })();
        const quoteContext=source?{conversation_id:conversationId,turn_id:target.turn_id,role:target.role==='assistant'?'assistant':'elder',
          version:target.version??1,text:target.text,source}:null;
        if(!quoteContext||!await quoteContextCurrent(conversation,quoteContext))return fail(409,'quote_context_stale');
        explicitRespondingTo={quoteContext,target};
      }
      if (Object.prototype.hasOwnProperty.call(body, 'responding_to')) {
        const target = body.responding_to, targetKeys = target && typeof target === 'object' && !Array.isArray(target) ? Object.keys(target).sort() : [];
        if (targetKeys.join(',') !== 'text,turn_id,version' || typeof target.turn_id !== 'string'
          || typeof target.text !== 'string' || !Number.isSafeInteger(target.version) || target.version < 1) return fail(400, 'responding_to_invalid');
        if (body.media_id || body.record_id || body.source_kind === 'audio_transcript' || controlled || controlledText
          || unrelatedText || conversation.trial_control || conversation.saved_audio_trial || trial && trial.state !== 'completed') {
          return fail(409, 'followup_target_not_allowed');
        }
        const matches = conversation.turns.filter(turn => turn.turn_id === target.turn_id), selected = matches[0];
        if (matches.length !== 1 || !selected || selected.role !== 'assistant' || selected.superseded || selected.ai_failed
          || mockSource(selected) || !['ask', 'reply'].includes(selected.action)
          || selected.text !== target.text || (selected.version ?? 1) !== target.version) return fail(409, 'followup_target_stale');
        if ((conversation.stale_responding_to_turn_ids || []).includes(selected.turn_id)) return fail(409, 'followup_target_context_changed');
        const currentContext = await healthContext(subjectOf(conversation));
        if (Number(conversation.health_context_version || 0) !== Number(currentContext.version || 0)) return fail(409, 'followup_target_context_changed');
        const selectedContextIds = new Set((conversation.selected_context_ids || []).filter(contextId =>
          currentContext.entries.some(entry => entry.context_id === contextId && usableHealthEntry(entry, subjectOf(conversation)))));
        if (Array.isArray(selected.model_context_ids) && selected.model_context_ids.some(contextId => !selectedContextIds.has(contextId))) {
          return fail(409, 'followup_target_context_changed');
        }
        explicitRespondingTo = selected;
      }
      let event;
      if (body.record_id) event = await readEvent(body.record_id);
      if (body.record_id && !event) return fail(409, 'conversation_source_invalid');
      if (event && (!['elder', 'audio_transcript'].includes(event.source_kind) || event.raw_text !== text || event.state === 'superseded')) return fail(409, 'conversation_source_invalid');
      if (body.source_kind === 'audio_transcript' && event?.source_kind !== 'audio_transcript') return fail(409, 'audio_source_review_required');
      const audioSource = event?.source_kind === 'audio_transcript';
      if (event?.source_kind === 'audio_transcript') {
        if (body.source_kind !== 'audio_transcript' || !sourceMedia || sourceMedia.kind !== 'audio'
          || sourceMedia.recognition_status !== 'succeeded' || mockSource(sourceMedia.recognition) || sourceMedia.recognition?.is_mock) return fail(409, 'audio_source_changed');
        const acceptedStatus = ['machine_transcribed', 'user_edited'].includes(body.audio_source_status);
        if (safety.audioNeedsReview(event) && !acceptedStatus) return fail(409, 'audio_source_review_required');
        const existingOwners = await conversationsUsingRecords([event.record_id]);
        const hasForeignOwner = existingOwners.some(owner => owner.conversation_id !== conversationId
          && owner.turns.some(turn => turn.role === 'elder' && !turn.superseded && turn.record_id === event.record_id));
        const belongsElsewhere = Boolean(sourceMedia.conversation_id && sourceMedia.conversation_id !== conversationId
          || event.source_conversation_id && event.source_conversation_id !== conversationId);
        const explicitSourceReuse = body.explicit_source_reuse === true || operationKey.startsWith('saved-audio-conversation:');
        if ((hasForeignOwner || belongsElsewhere) && !explicitSourceReuse) return fail(409, 'conversation_source_shared');
        if (Number(body.source_version) !== event.version || Number(body.media_version) !== sourceMedia.version
          || safety.currentAudioSource(sourceMedia, await listEvents())?.record_id !== event.record_id
          || !(await vault.get(mediaBinaryKey(sourceMedia.media_id)))?.bytes) return fail(409, 'audio_source_changed');
      }
      const textTrialRegistry = unrelatedText ? await healthSubjects() : null;
      const textTrialContext = unrelatedText ? await vault.get(healthContextKey(subjectOf(conversation))) : undefined;
      if (!event) {
        const created = await createEvent({ subject_id: subjectOf(conversation), raw_text: text, source_kind: body.source_kind === 'audio_transcript' ? 'audio_transcript' : 'elder', actor_name: '老人', related_record_ids: elderTurns(conversation).map(turn => turn.record_id).filter(Boolean).slice(-10) }, `conversation-event:${operationKey}`);
        if (!created.r.ok) return created;
        event = created.j.event;
      }
      const userTurn = {
        turn_id: id('turn'), role: 'elder', original_text: text, text, source_kind: event.source_kind,
        record_id: event.record_id, media_id: body.media_id || null, local_safety: event.local_safety, created_at: now(), version: 1, versions: [],
        ...(event.source_kind === 'audio_transcript' ? { audio_source_reviewed: safety.audioNeedsReview(event) === false,
          audio_source_status: safety.audioNeedsReview(event) === false ? 'original_comparison' : body.audio_source_status || 'legacy_unclassified', audio_source_version: event.version,
          audio_source_media_version: sourceMedia.version, audio_source_conversation_id: conversationId,
          audio_source_conversation_version: conversation.version, audio_source_invalidated: false,
          ...(Number.isInteger(body.audio_duration_seconds) && body.audio_duration_seconds > 0 && body.audio_duration_seconds <= 3600
            ? { audio_duration_seconds: body.audio_duration_seconds } : {}) } : {}),
      };
      if(explicitRespondingTo?.quoteContext)userTurn.quote_context=explicitRespondingTo.quoteContext;
      const previous = liveConversationTurns(conversation).at(-1), respondingTo = explicitRespondingTo?.quoteContext?null:explicitRespondingTo || previous;
      if (respondingTo?.role === 'assistant' && ['ask', 'reply'].includes(respondingTo.action) && !respondingTo.ai_failed && !mockSource(respondingTo)) {
        userTurn.responding_to = { turn_id: respondingTo.turn_id, text: respondingTo.text };
        userTurn.responding_to_version = respondingTo.version ?? 1;
      }
      let withUser = {
        ...conversation,
        status: backgroundInactive ? conversation.status : 'active',
        last_local_date: currentLocalDate(),
        turns: [...conversation.turns, userTurn],
        controller: conversation.controller,
        completeness: conversation.completeness,
        active_episode_start_turn_id: null,
        ...(unrelatedText ? { new_text_trial: { turn_id: userTurn.turn_id, state: 'saved_only', created_at: now() } } : {}),
      };
      if (controlledText) withUser = invalidateChangedAnalysis(withUser, await healthContext());
      withUser.report = await buildCurrentConversationReport(withUser, conversation.report);
      const operation = { key: `operation:conversation-turn:${operationKey}`, value: { conversation_id: conversationId, turn_id: userTurn.turn_id } };
      const unchangedAudioSource = audioSource ? [{ key: eventKey(event.record_id), value: event }, { key: mediaKey(sourceMedia.media_id), value: sourceMedia }] : [];
      if (controlled) {
        try {
          conversation = await saveTrialConversation({ ...withUser, status: 'paused' }, { ...controlled, conversation_id: conversationId, turn_id: userTurn.turn_id, turn_version: userTurn.version, media_id: body.media_id || null }, [operation], [{ key: conversationKey(conversationId), value: storedConversation }, { key: TRIAL_VOICE_KEY, value: trial }, ...unchangedAudioSource]);
        } catch (error) {
          // Raw-first saving is intentional. A concurrent stop wins, while its
          // independently saved source remains available in My Records.
          if (error.message === 'document_changed') return fail(409, 'trial_source_changed', { raw_text_preserved_on_device: true, source_record_id: event.record_id });
          throw error;
        }
      } else conversation = await saveConversation(withUser, unchangedAudioSource);
      if (!controlled) await ownedPut(operation.key, operation.value);
      if (controlled) return ok(201, { ok: true, created: true, conversation, turn_id: userTurn.turn_id, trial_control: conversation.trial_control });
      if (unrelatedText) {
        let result;
        if (backgroundInactive) result = { dispatched: false, ai_failed: true, reason: 'background_inactive', conversation };
        else {
          try { result = await runFreshTextTrial(conversation, trial, textTrialRegistry, textTrialContext, event, userTurn); }
          catch { result = { dispatched: false, ai_failed: true, reason: 'source_changed', conversation }; }
        }
        const textTrial = { state: result.dispatched ? result.reason : 'saved_only', reason: result.dispatched ? undefined : result.reason };
        return ok(result.ai_failed ? 202 : 201, { ok: true, created: true,
          conversation: await withSavedOnlyTextFirstSendState(result.conversation),
          turn_id: userTurn.turn_id, ai_failed: result.ai_failed, text_trial: textTrial });
      }
      // A recognition already in flight can complete after an explicit pause.
      // Save its source and report, then wait for the user to return for a reply.
      if (backgroundInactive) return ok(201, { ok: true, created: true, conversation, turn_id: userTurn.turn_id });
      let result;try{result=await conversationReply(conversation)}catch(error){
        if(error?.message==='quote_context_stale')return fail(409,'quote_context_stale',{conversation:await conversationCurrentView(conversation)});
        throw error;
      }
      const appended = await appendAssistantResult(conversation, result);
      conversation = appended.conversation;
      if (body.keep_media_until_pause !== true) await cleanupTemporaryAudio(body.media_id);
      return ok(result.r.ok ? 201 : 202, { ok: true, created: true, result_discarded: !appended.applied, ai_failed: !!conversation.last_ai_metadata?.ai_failed, conversation, turn_id: userTurn.turn_id });
    }
    if (parts[3] === 'turns' && parts[4] && method === 'POST') {
      const turnId = decodeURIComponent(parts[4]);
      const text = String(body.text || '').trim();
      if (!text || text.length > 10000) return fail(400, 'turn_text_invalid');
      const index = conversation.turns.findIndex(turn => turn.turn_id === turnId && turn.role === 'elder');
      if (index < 0) return fail(404, 'turn_not_found');
      const current = conversation.turns[index];
      if (latestEditableOwnTurn(conversation)?.turn_id !== current.turn_id) return fail(409, 'turn_not_latest');
      if (Number(body.expected_version) !== current.version) return fail(409, 'stale_version');
      if (Number(body.expected_conversation_version) !== conversation.version) return fail(409, 'stale_conversation');
      if (current.source_kind === 'audio_transcript' && (conversation.trial_control || conversation.saved_audio_trial)) {
        return fail(409, 'audio_source_review_required');
      }
      let currentAudioEvent = null;
      if (current.source_kind === 'audio_transcript') {
        const [audioEvents, audioMedia] = await Promise.all([listEvents(), mediaList()]);
        const audioEventIndex = new Map(audioEvents.map(item => [item.record_id, item]));
        const audioMediaIndex = new Map(audioMedia.map(item => [item.media_id, item]));
        currentAudioEvent = audioEventIndex.get(current.record_id);
        if (!audioConversationSourceCurrent(current, audioEventIndex, audioMediaIndex, conversationId, subjectOf(conversation))) {
          return fail(409, 'audio_source_changed');
        }
      }
      const savedOnlyTextCorrection = !conversation.trial_control&&conversation.new_text_trial?.state==='saved_only'
        &&conversation.new_text_trial.turn_id===turnId&&liveConversationTurns(conversation).at(-1)?.turn_id===turnId;
      let trialControl = null, trialGlobal = null;
      if (conversation.trial_control) {
        const global = await trialVoiceState();
        if (!sameTrialOwner(conversation.trial_control, global) || global.conversation_id !== conversationId) return fail(409, 'trial_source_changed');
        const state = global.state === 'stopped' || conversation.trial_control.state === 'stopped' ? 'stopped'
          : global.state === 'continuing' || conversation.trial_control.state === 'continuing' ? 'continuing' : 'review_required';
        trialControl = { ...conversation.trial_control, state };
        trialGlobal = global;
      }
      const revisedSafety = safety.scanDanger(text);
      const turns = conversation.turns.map((turn, turnIndex) => {
        if (turnIndex === index) return { ...turn, text, ...(savedOnlyTextCorrection?{original_text:text}:{}), is_mock: false, local_safety: revisedSafety, version: turn.version + 1, edited_at: now(),
          ...(current.source_kind === 'audio_transcript' ? { audio_source_reviewed: false, audio_source_status: 'user_edited',
            audio_source_version: currentAudioEvent.version + 1, audio_source_invalidated: false,
            audio_source_conversation_version: conversation.version + 1 } : {}),
          versions: [...(turn.versions || []), { version: turn.version, text: turn.text, replaced_at: now() }] };
        if (turnIndex > index && turn.role === 'assistant') return { ...turn, superseded: true };
        return turn;
      });
      const edited = { ...conversation, turns, controller: editedConversationController(conversation.controller), completeness: null, analysis_sources: null, relevant_health_context: [] };
      if (trialControl) {
        const latest = elderTurns(edited).at(-1);
        edited.trial_control = { ...trialControl, conversation_id: conversationId, turn_id: latest.turn_id,
          turn_version: latest.version, media_id: latest.media_id || null, source_kind: latest.source_kind };
      }
      edited.report = buildConversationReport(edited, conversation.report);
      edited.report_history=reportHistoryIncluding(conversation.report_history,conversation.report,edited.report);
      const persistCorrection = async () => {
        const puts = [];
        if (current.record_id) {
          // Chat corrections and archive edits/deletion share the event lock.
          // Re-read after taking it rather than reviving a deleted/superseded
          // source or overwriting a correction made on the archive page.
          const event = await readEvent(current.record_id);
          if (!event || event.state === 'superseded' || event.raw_text !== current.text) return fail(409, 'conversation_source_changed');
          if (event.raw_text !== text) {
            puts.push(historyDocument(event, 'conversation_turn_corrected', '聊天原话已由使用者修改'));
            puts.push({ key: eventKey(event.record_id), value: { ...event,
              raw_text: text, updated_at: now(), version: event.version + 1,
              state: 'inbox', local_safety: revisedSafety, draft: null, ai_metadata: null,
              ...(current.source_kind === 'audio_transcript' ? { source_review: null } : {}) } });
          }
        }
        const saved = { ...edited, version: conversation.version + 1, updated_at: now() };
        puts.push({ key: conversationKey(conversationId), value: saved });
        if (trialControl) puts.push({ key: TRIAL_VOICE_KEY, value: saved.trial_control });
        // Both representations and the history commit together, including when
        // IndexedDB runs out of space or the page closes during a correction.
        await ownedMutation({ puts, ...(trialControl ? { unchanged: [{ key: conversationKey(conversationId), value: storedConversation }, { key: TRIAL_VOICE_KEY, value: trialGlobal }] } : {}) });
        return ok(200, { conversation: saved });
      };
      const persisted = current.record_id ? await withEventLock(current.record_id, persistCorrection) : await persistCorrection();
      if (!persisted.r.ok) return persisted;
      conversation = persisted.j.conversation;
      if (conversation.trial_control) {
        return ok(200, { ok: true, conversation, trial_control: conversation.trial_control });
      }
      if (savedOnlyTextCorrection) return ok(200, { ok: true, ai_failed: false, text_trial: { state: 'saved_only' },
        conversation: await withSavedOnlyTextFirstSendState(conversation) });
      const latestElder = liveConversationTurns(conversation).filter(turn => turn.role === 'elder').at(-1);
      const latestQuote = latestElder?.quote_context;
      if (latestQuote && !await quoteContextCurrent(conversation, latestQuote)) {
        return ok(200, { ok: true, quote_context_invalidated: true, conversation: await conversationCurrentView(conversation) });
      }
      let result;
      try { result = await conversationReply(conversation); }
      catch (error) {
        if (error?.message === 'quote_context_stale') {
          const latest = await vault.get(conversationKey(conversationId));
          const latestPatientTurn = latest && liveConversationTurns(latest).filter(turn => turn.role === 'elder').at(-1);
          if (latest && latestPatientTurn?.quote_context && !await quoteContextCurrent(latest, latestPatientTurn.quote_context)) {
            return ok(200, { ok: true, quote_context_invalidated: true, conversation: await conversationCurrentView(latest) });
          }
        }
        throw error;
      }
      const appended = await appendAssistantResult(conversation, result);
      conversation = appended.conversation;
      return ok(200, { ok: true, result_discarded: !appended.applied, ai_failed: !!conversation.last_ai_metadata?.ai_failed, conversation });
    }
    if (parts[3] === 'pause' && method === 'POST') {
      if (!conversation.trial_control) for (const turn of elderTurns(conversation)) await cleanupTemporaryAudio(turn.media_id);
      conversation = await saveConversation({ ...conversation, status: 'paused' });
      return ok(200, { ok: true, conversation });
    }
    if (parts[3] === 'finish' && method === 'POST') {
      if (!conversation.trial_control) for (const turn of elderTurns(conversation)) await cleanupTemporaryAudio(turn.media_id);
      conversation = await saveConversation({ ...conversation, status: 'finished' });
      return ok(200, { ok: true, conversation });
    }
    return fail(404, 'not_found');
  }

  function mediaPublic(media) {
    if (media.trial_control) {
      if (['failed', 'interrupted'].includes(media.recognition_status)) return { ...media, recognition: { ...media.recognition,
        retryable: false, manual_retry_after_authorization: false, error: { ...media.recognition?.error, retryable: false } } };
      return { ...media };
    }
    if (media.link_pending_reason === 'conversation_link_pending' && Date.now() - (Date.parse(media.updated_at || media.created_at) || 0) >= 120000) {
      return { ...media, link_pending_reason: null, conversation_link_error: 'conversation_link_interrupted' };
    }
    // A tab can close after saving 'processing'. Requests time out within 98 s;
    // after two minutes a manual retry can recover without an endless spinner.
    if (media.recognition_status === 'processing' && Date.now() - (Date.parse(media.updated_at || media.created_at) || 0) >= 120000) {
      return { ...media, recognition_status: 'interrupted', recognition: { retryable: true,
        error_message: '上次识别已中断，原件仍保存在本机，可以重试。',
        error: { code: 'recognition_interrupted', retryable: true } } };
    }
    if (media.recognition?.is_mock || mockSource(media.recognition)) {
      return { ...media, recognition_status: 'failed', recognition: { ...media.recognition, is_mock: true, retryable: true,
        error_message: '此前是模拟结果，不是原件内容。请在真实识别服务接通后重试。',
        error: { code: 'media_mock_unavailable', retryable: true } } };
    }
    if (media.recognition_status === 'failed' && ['trial_authorization_required', 'trial_budget_exhausted'].includes(media.recognition?.error?.code)) {
      const exhausted = media.recognition.error.code === 'trial_budget_exhausted';
      return { ...media, recognition: { ...media.recognition, retryable: false, manual_retry_after_authorization: true,
        error_message: exhausted ? '本次试验额度已用尽，原件已保存在本机。需要新的预算授权后才能手动重试。'
          : '试验尚未获预算授权，原件已保存在本机。获得授权后可手动重试。',
        error: { ...media.recognition.error, retryable: false } } };
    }
    if (media.recognition_status === 'failed' && RECOVERABLE_MEDIA_ERRORS.has(media.recognition?.error?.code)) {
      return { ...media, recognition: { ...media.recognition, retryable: true,
        error_message: '识别暂未完成，原件已保存在本机。服务恢复后可以重试。',
        error: { ...media.recognition.error, retryable: true } } };
    }
    return { ...media };
  }
  function referencesMediaId(value, mediaId, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => referencesMediaId(item, mediaId, seen));
    return Object.entries(value).some(([key, child]) =>
      (['media_id', 'source_media_id', 'source_audio_media_id'].includes(key) && child === mediaId)
      || referencesMediaId(child, mediaId, seen));
  }
  function collectMediaReferences(value, result, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach(item => collectMediaReferences(item, result, seen)); return; }
    for (const [key, child] of Object.entries(value)) {
      if (['media_id', 'source_media_id', 'source_audio_media_id'].includes(key) && typeof child === 'string') result.add(child);
      collectMediaReferences(child, result, seen);
    }
  }
  async function mediaRecognitionIsInFlight(media) {
    const lockName = `bingli-media-recognition:${media.media_id}`;
    if (localMediaRecognitionIds.has(media.media_id) || mediaRecognitionWrites.has(lockName)) return true;
    const locks = globalThis.navigator?.locks;
    if (typeof locks?.query === 'function') {
      try {
        const state = await locks.query();
        const names = [...(state.held || []), ...(state.pending || [])].map(lock => lock.name);
        if (names.includes(lockName)) return true;
        // The audio provider lock does not identify its owner. If this media
        // still says processing, fail closed while any tab holds that lock.
        if (media.kind === 'audio' && names.includes(AUDIO_RECOGNITION_LOCK)) return true;
        return false;
      } catch { return true; }
    }
    if (media.kind === 'audio' && await audioRecognitionInFlight()) return true;
    if (typeof locks?.request === 'function') {
      try {
        let acquired = false;
        await locks.request(lockName, { ifAvailable: true }, lock => { acquired = Boolean(lock); });
        return !acquired;
      } catch { return true; }
    }
    return false;
  }
  async function mediaDeletionSnapshot() {
    const [events, conversations, uploads, trial, historyDocs] = await Promise.all([
      vault.list('event:'), vault.list('conversation:'), vault.list('upload:'), vault.get(TRIAL_VOICE_KEY), driver.listDocs('history:'),
    ]);
    const histories = await Promise.all(historyDocs.map(async doc => ({ key: doc.key, value: await vault.get(doc.key) })));
    const historyMediaIds = new Set();
    histories.forEach(item => collectMediaReferences(item.value, historyMediaIds));
    return { events, conversations, uploads, trial, histories, historyMediaIds };
  }
  async function mediaDeletionBlock(media, subjectId, snapshot) {
    if (media.trial_control || referencesMediaId(snapshot.trial, media.media_id)
      || snapshot.conversations.some(item => referencesMediaId(item?.trial_control, media.media_id))) return 'trial_controlled';
    if (snapshot.uploads.some(item => item?.media_id === media.media_id)) return 'upload_in_progress';
    if (media.save_status !== 'saved') return 'upload_in_progress';
    if (media.recognition_status === 'processing' && await mediaRecognitionIsInFlight(media)) return 'processing';
    if (media.recognition_status === 'processing') {
      const publicMedia = mediaPublic(media), updatedAt = Date.parse(media.updated_at || media.created_at);
      if (publicMedia.recognition_status === 'processing' || !Number.isFinite(updatedAt)) return 'processing';
    }
    if (media.conversation_id != null) {
      if (typeof media.conversation_id !== 'string' || !media.conversation_id) return 'owner_unknown';
      const owner = snapshot.conversations.find(item => item?.conversation_id === media.conversation_id);
      if (owner && subjectOf(owner) !== subjectId) return 'owner_unknown';
    }
    const linkedRecordIds = new Set([media.event_link?.record_id, media.record_id].filter(Boolean));
    if (media.event_link?.record_id || media.record_id || media.link_status === 'linked'
      || snapshot.events.some(event => referencesMediaId(event, media.media_id) || linkedRecordIds.has(event?.record_id))
      || snapshot.historyMediaIds.has(media.media_id)
      || snapshot.conversations.some(item => referencesMediaId(item, media.media_id))) return 'linked';
    if (media.link_status === 'pending' || mediaPublic(media).link_pending_reason) return 'link_pending';
    return null;
  }
  async function mediaWithDeleteEligibility(media, snapshot, subjectId) {
    const blocked = await mediaDeletionBlock(media, subjectId, snapshot);
    return { ...mediaPublic(media), delete_eligibility: { allowed: blocked === null, reason: blocked || 'eligible' } };
  }
  async function mediaList() { const subjectId = await activeSubjectId(); return (await vault.list('media:')).filter(item => item?.media_id && subjectOf(item) === subjectId).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)); }
  function mediaCapabilities() { return { enabled: true, disabled_reason: null, max_total_bytes: MAX_MEDIA_BYTES, max_part_bytes: 2 * 1024 * 1024, max_parts: 12, audio_content_types: MEDIA_TYPES.audio, image_content_types: MEDIA_TYPES.image, multipart_upload: true, resumable_parts: true }; }
  async function mediaRequest(path, options) {
    const method = options?.method || 'GET'; const parts = path.split('/').filter(Boolean);
    if (path === '/api/media/capabilities' && method === 'GET') return ok(200, { ok: true, capabilities: mediaCapabilities() });
    if (path === '/api/media' && method === 'GET') {
      const [items, subjectId, snapshot] = await Promise.all([mediaList(), activeSubjectId(), mediaDeletionSnapshot()]);
      return ok(200, { ok: true, media: await Promise.all(items.map(item => mediaWithDeleteEligibility(item, snapshot, subjectId))) });
    }
    if (path === '/api/media/uploads' && method === 'POST') {
      const form = parseBody(options); const kind = form.get('kind'); const type = String(form.get('content_type') || '').split(';')[0]; const totalParts = Number(form.get('total_parts'));
      if (!MEDIA_TYPES[kind]?.includes(type) || !Number.isInteger(totalParts) || totalParts < 1 || totalParts > 12) return fail(415, 'unsupported_format');
      const operationKey=options?.headers?.['Idempotency-Key'];
      const requestedConversationId = String(form.get('conversation_id') || '');
      const conversationId = /^conversation_[A-Za-z0-9_-]{8,100}$/.test(requestedConversationId) ? requestedConversationId : null;
      const createUpload = async () => {
        const subjectId = await activeSubjectId(), owner = conversationId ? await vault.get(conversationKey(conversationId)) : null;
        if (conversationId && !owner) return fail(404, 'conversation_not_found');
        if (owner && subjectOf(owner) !== subjectId) return fail(403, 'subject_mismatch');
        if(operationKey){const replay=await vault.get(`operation:media-upload:${operationKey}`);if(replay){const existing=await vault.get(`upload:${replay.upload_id}`);if(existing)return subjectOf(existing) === subjectId ? ok(200,{ok:true,created:false,upload:existing}) : fail(403,'subject_mismatch');}}
        const uploadId = id('upload'); const mediaId = id('media');
        const upload = { upload_id: uploadId, subject_id: subjectId, media_id: mediaId, kind, content_type: type, total_parts: totalParts, expected_size: Number(form.get('expected_size')), expected_sha256: form.get('expected_sha256'), original_filename: form.get('original_filename') || 'media', temporary: form.get('temporary') === 'true', conversation_id: conversationId, created_at: now() };
        const puts = [{ key: `upload:${uploadId}`, value: upload }];
        if(operationKey) puts.push({ key: `operation:media-upload:${operationKey}`, value: { upload_id:uploadId,media_id:mediaId } });
        await ownedMutation({ puts }); return ok(201, { ok: true, created: true, upload });
      };
      return conversationId ? withConversationLock(conversationId, createUpload) : createUpload();
    }
    if (parts[0] === 'api' && parts[1] === 'media' && parts[2] === 'uploads' && parts[4] === 'parts' && method === 'POST') {
      const upload = await vault.get(`upload:${parts[3]}`); if (!upload) return fail(404, 'upload_not_found');
      if (subjectOf(upload) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
      const index = Number(parts[5]); const file = parseBody(options).get('file');
      if (!Number.isInteger(index) || index < 0 || index >= upload.total_parts || !file) return fail(400, 'invalid_part');
      const savePart = async () => {
        const current = await vault.get(`upload:${parts[3]}`); if (!current) return fail(404, 'upload_not_found');
        if (current.conversation_id && !(await vault.get(conversationKey(current.conversation_id)))) return fail(404, 'conversation_not_found');
        if (!Number.isInteger(index) || index < 0 || index >= current.total_parts || !file) return fail(400, 'invalid_part');
        await ownedMutation({ puts: [{ key: `upload-part:${current.upload_id}:${String(index).padStart(3, '0')}`, format: 'binary', value: file, metadata: { index, size: file.size } }] });
        return ok(201, { ok: true, created: true, part: { index, size: file.size } });
      };
      return upload.conversation_id ? withConversationLock(upload.conversation_id, savePart) : savePart();
    }
    if (parts[0] === 'api' && parts[1] === 'media' && parts[2] === 'uploads' && parts[4] === 'complete' && method === 'POST') {
      const upload = await vault.get(`upload:${parts[3]}`); if (!upload) return fail(404, 'upload_not_found');
      if (subjectOf(upload) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
      const completeUpload = async () => {
        const current = await vault.get(`upload:${parts[3]}`); if (!current) return fail(404, 'upload_not_found');
        if (current.conversation_id && !(await vault.get(conversationKey(current.conversation_id)))) return fail(404, 'conversation_not_found');
        const chunks = [];
        for (let index = 0; index < current.total_parts; index += 1) {
          const item = await vault.get(`upload-part:${current.upload_id}:${String(index).padStart(3, '0')}`); if (!item) return fail(409, 'upload_incomplete'); chunks.push(new Uint8Array(item.bytes));
        }
        const size = chunks.reduce((sum, item) => sum + item.length, 0); if (!size || size > MAX_MEDIA_BYTES || size !== current.expected_size) return fail(422, 'integrity_mismatch');
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
        if (current.expected_sha256 && digest !== current.expected_sha256) return fail(422, 'integrity_mismatch');
        const media = { media_id: current.media_id, subject_id: subjectOf(current), kind: current.kind, content_type: current.content_type, original_filename: current.original_filename, size, sha256: digest, temporary: current.temporary === true, conversation_id: current.conversation_id || null, created_at: now(), updated_at: now(), save_status: 'saved', recognition_status: 'not_started', link_status: 'not_linked', version: 1, recognition: null, event_link: null, local_safety: null };
        await ownedMutation({ puts: [{ key: mediaBinaryKey(media.media_id), format: 'binary', value: bytes.buffer,
          metadata: { content_type: media.content_type, filename: media.original_filename } }, { key: mediaKey(media.media_id), value: media }],
        deletes: [`upload:${current.upload_id}`, ...Array.from({ length: current.total_parts }, (_, index) => `upload-part:${current.upload_id}:${String(index).padStart(3, '0')}`)] });
        return ok(201, { ok: true, created: true, media: mediaPublic(media) });
      };
      return upload.conversation_id ? withConversationLock(upload.conversation_id, completeUpload) : completeUpload();
    }
    const mediaId = parts[2]; let media = await vault.get(mediaKey(mediaId));
    if (media && subjectOf(media) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
    if(!media&&parts.length===3&&['GET','DELETE'].includes(method)){const upload=(await vault.list('upload:')).find(item=>item.media_id===mediaId);if(upload){if(subjectOf(upload)!==await activeSubjectId())return fail(403,'subject_mismatch');if(method==='DELETE')return fail(409,'media_upload_in_progress');return ok(200,{ok:true,media:{media_id:mediaId,subject_id:subjectOf(upload),kind:upload.kind,content_type:upload.content_type,original_filename:upload.original_filename,save_status:'uploading',recognition_status:'not_started',link_status:'not_linked',version:0}})}}
    if (!media) return fail(404, 'media_not_found');
    if (parts.length === 3 && method === 'GET') {
      const [subjectId, snapshot] = await Promise.all([activeSubjectId(), mediaDeletionSnapshot()]);
      return ok(200, { ok: true, media: await mediaWithDeleteEligibility(media, snapshot, subjectId) });
    }
    if (parts.length === 3 && method === 'DELETE') {
      const body = parseBody(options);
      if (body.delete_scope_confirmed !== true) return fail(400, 'delete_confirmation_required');
      if (!Number.isSafeInteger(body.expected_version) || body.expected_version !== media.version) return fail(409, 'stale_version');
      const initialConversationId = media.conversation_id;
      const deleteUnderLocks = () => withMediaLock(mediaId, async () => {
        const current = await vault.get(mediaKey(mediaId));
        if (!current) return fail(404, 'media_not_found');
        if (subjectOf(current) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
        if (current.version !== body.expected_version || current.conversation_id !== initialConversationId) return fail(409, 'stale_version');
        const snapshot = await mediaDeletionSnapshot();
        const blocked = await mediaDeletionBlock(current, await activeSubjectId(), snapshot);
        if (blocked === 'linked') return fail(409, 'media_linked');
        if (blocked === 'link_pending') return fail(409, 'media_link_pending');
        if (blocked === 'processing') return fail(409, 'media_processing');
        if (blocked === 'upload_in_progress') return fail(409, 'media_upload_in_progress');
        if (blocked === 'trial_controlled') return fail(409, 'media_trial_controlled');
        if (blocked === 'owner_unknown') return fail(409, 'media_owner_unknown');
        const unchanged = [
          { key: mediaKey(mediaId), value: current },
          { key: mediaBinaryKey(mediaId), value: await vault.get(mediaBinaryKey(mediaId)) },
          { key: TRIAL_VOICE_KEY, value: snapshot.trial },
          ...snapshot.events.map(item => ({ key: eventKey(item.record_id), value: item })),
          ...snapshot.conversations.map(item => ({ key: conversationKey(item.conversation_id), value: item })),
          ...snapshot.uploads.map(item => ({ key: `upload:${item.upload_id}`, value: item })),
          ...snapshot.histories.filter(item => referencesMediaId(item.value, mediaId)),
        ];
        const deletes = [mediaKey(mediaId), mediaBinaryKey(mediaId)];
        for (const doc of await driver.listDocs()) if (doc.key.startsWith('operation:')) {
          const operation = await vault.get(doc.key);
          if (operation?.media_id === mediaId) { deletes.push(doc.key); unchanged.push({ key: doc.key, value: operation }); }
        }
        try { await ownedMutation({ deletes: deletes.filter(Boolean), unchanged }); }
        catch (error) { if (error.message === 'document_changed') return fail(409, 'stale_version'); throw error; }
        return ok(200, { ok: true, deleted: { media_id: mediaId, local_media_count: 1, encrypted_backups_unchanged: true } });
      });
      return initialConversationId ? withConversationLock(initialConversationId, deleteUnderLocks) : deleteUnderLocks();
    }
    if (parts[3] === 'recognize' && method === 'POST') {
      return withRecognitionLocks(media, () => withMediaLock('voice-recognition-start', async () => {
        const current = await vault.get(mediaKey(mediaId));
        if (!current) return fail(404, 'media_not_found');
        const sourceConversation = current.conversation_id ? await vault.get(conversationKey(current.conversation_id)) : null;
        if (current.conversation_id && !sourceConversation) return fail(404, 'conversation_not_found');
        if (mediaPublic(current).recognition_status === 'processing') return ok(202, { ok: true, action: 'existing', media: mediaPublic(current) });
        if (current.kind === 'audio') {
          const trial = await trialVoiceState();
          if (current.trial_control?.asr_trial_receipt_id) return fail(409, current.trial_control.state === 'stopped' ? 'trial_stopped' : 'trial_review_required', { media: mediaPublic(current) });
          if (await trialBlocksAudio(trial, current)) return fail(409, trial.state === 'stopped' ? 'trial_stopped' : 'trial_review_required', { media: mediaPublic(current) });
          if (current.recognition_status === 'succeeded' && current.trial_control) return ok(200, { ok: true, media: mediaPublic(current) });
          const activeAudio = await audioRecognitionInFlight();
          const recentProcessing = (await mediaList()).some(item => {
            const age = Date.now() - (Date.parse(item.updated_at || item.created_at) || 0);
            return item.media_id !== mediaId && item.kind === 'audio' && item.recognition_status === 'processing' && age < 120000;
          });
          if (activeAudio || recentProcessing) return fail(409, 'audio_recognition_in_progress', { media: mediaPublic(current) });
        }
        const processing = { ...current, conversation_version_at_start: sourceConversation?.version ?? null,
          recognition_status: 'processing', version: current.version + 1, updated_at: now(), recognition: null };
        let asrOwner = null;
        if (current.kind === 'audio') {
          const scoped = await asrTrialOwner(current, processing.version, await trialVoiceState());
          if (scoped.error) return fail(409, scoped.error, { media: mediaPublic(current) });
          asrOwner = scoped.owner;
        }
        await ownedPut(mediaKey(mediaId), processing);
        processRecognition(processing, asrOwner);
        return ok(202, { ok: true, action: 'started', media: mediaPublic(processing) });
      }));
    }
    if (parts[3] === 'link' && method === 'POST') {
      if (media.recognition?.is_mock || mockSource(media.recognition)) return fail(409, 'media_mock_unavailable');
      if (media.recognition_status !== 'succeeded' || !media.recognition?.text) return fail(409, 'recognition_not_succeeded');
      if (media.event_link?.record_id) return ok(200, { ok: true, event_created: false, media: mediaPublic(media) });
      return withRecognitionLocks(media, async () => {
        const current = await vault.get(mediaKey(mediaId));
        if (!current || current.version !== media.version) return fail(409, 'stale_version');
        if (current.conversation_id && !(await vault.get(conversationKey(current.conversation_id)))) return fail(404, 'conversation_not_found');
        if (current.recognition?.is_mock || mockSource(current.recognition)) return fail(409, 'media_mock_unavailable');
        if (current.recognition_status !== 'succeeded' || !current.recognition?.text) return fail(409, 'recognition_not_succeeded');
        if (current.event_link?.record_id) return ok(200, { ok: true, event_created: false, media: mediaPublic(current) });
        const created = await createEvent({ subject_id: subjectOf(current), raw_text: current.recognition.text, source_kind: current.kind === 'audio' ? 'audio_transcript' : 'document', actor_name: '本地用户' }, `media-link:${mediaId}`);
        if (!created.r.ok) return created;
        const linked = { ...current, event_link: { record_id: created.j.event.record_id }, record_id: created.j.event.record_id, link_status: 'linked', version: current.version + 1, updated_at: now(), local_safety: created.j.event.local_safety };
        await ownedPut(mediaKey(mediaId), linked); return ok(201, { ok: true, event_created: true, media: mediaPublic(linked), event: created.j.event });
      });
    }
    return fail(404, 'not_found');
  }

  async function processRecognition(media, asrOwner = null) {
    const lockName = `bingli-media-recognition:${media.media_id}`;
    localMediaRecognitionIds.add(media.media_id);
    if (media.kind === 'audio') localAudioRecognitionScopes += 1;
    try {
      const run = () => withLocalLock(lockName, mediaRecognitionWrites, () => processRecognitionUnlocked(media, asrOwner));
      // Keep the existing cross-tab audio lock for the whole provider request.
      return media.kind === 'audio'
        ? await withLocalLock(AUDIO_RECOGNITION_LOCK, audioRecognitionWrites, run)
        : await run();
    } finally {
      if (media.kind === 'audio') localAudioRecognitionScopes -= 1;
      localMediaRecognitionIds.delete(media.media_id);
    }
  }

  async function processRecognitionUnlocked(media, asrOwner = null) {
    pendingLocalOperations += 1;
    let recognitionTrial = null;
    try {
      const original = await vault.get(mediaBinaryKey(media.media_id));
      if (!original?.bytes) throw Object.assign(new Error('original_unavailable'), { code: 'original_unavailable' });
      const form = new FormData(); form.append('kind', media.kind); form.append('content_type', media.content_type); form.append('attempt_id', id('attempt')); form.append('file', new Blob([original.bytes], { type: media.content_type }), media.original_filename);
      const result = await cloudRequest('/api/ai/media/recognize', { healthSubjectId: subjectOf(media), method: 'POST', body: form,
        ...(media.kind === 'audio' ? { audioMediaId: media.media_id } : {}), ...(asrOwner ? { asrTrial: asrOwner } : {}) });
      const trial = media.kind === 'audio' ? trialMarker(result.j) : null;
      recognitionTrial = trial;
      if (trial && !asrOwner) await ownedPut(TRIAL_VOICE_KEY, { ...trial, media_id: media.media_id, conversation_id: media.conversation_id });
      if (!result.r.ok) throw Object.assign(new Error(result.j.error || 'recognition_failed'), { code: result.j.error, retryable: result.j.retryable === true, trial_control: trial });
      if (result.j.recognition?.is_mock || mockSource(result.j.recognition)) throw Object.assign(new Error('media_mock_unavailable'), { code: 'media_mock_unavailable', retryable: true });
      if (!result.j.recognition?.text?.trim()) throw Object.assign(new Error('recognition_empty'), { code: 'recognition_empty', retryable: true });
      await withRecognitionLocks(media, async () => {
        const current = await vault.get(mediaKey(media.media_id));
        if (!current || current.version !== media.version || current.recognition_status !== 'processing') return;
        let conversation = null;
        if (media.conversation_id) {
          conversation = await vault.get(conversationKey(media.conversation_id));
          if (!conversation) return;
        }
        const created = await createEvent({ subject_id: subjectOf(media), raw_text: result.j.recognition.text, source_kind: media.kind === 'audio' ? 'audio_transcript' : 'document', actor_name: '本地用户',
          ...(media.temporary === true && media.conversation_id ? { source_conversation_id: media.conversation_id } : {}) }, `media-real-link:${media.media_id}`);
        if (!created.r.ok) throw Object.assign(new Error(created.j.error), { code: created.j.error });
        let updated = { ...current, ...(trial ? { trial_control: asrOwner ? asrMediaControl(asrOwner, trial, 'review_required') : trial } : {}),
          ...(asrOwner && !trial ? { trial_control: asrMediaControl(asrOwner, null, 'review_required') } : {}), recognition_status: 'succeeded', recognition: result.j.recognition, local_safety: created.j.event.local_safety, event_link: { record_id: created.j.event.record_id }, record_id: created.j.event.record_id, link_status: 'linked', link_pending_reason: media.kind === 'audio' ? 'audio_source_review_required' : null, conversation_link_error: null, version: current.version + 1, updated_at: now() };
        await ownedPut(mediaKey(media.media_id), updated);
        if (updated.kind !== 'audio' && updated.temporary === true && updated.conversation_id) {
          const backgroundInactive = !trial && ['paused', 'finished'].includes(conversation.status)
            && conversation.version !== media.conversation_version_at_start;
          const linked = await conversationRequest(`/api/conversations/${updated.conversation_id}/turns`, {
            method: 'POST',
            headers: { 'Idempotency-Key': `media-conversation:${updated.media_id}` },
            body: JSON.stringify({ text: result.j.recognition.text, source_kind: 'audio_transcript', record_id: created.j.event.record_id, media_id: updated.media_id, expected_version: conversation.version, keep_media_until_pause: true }),
          }, true, true, backgroundInactive);
          if (linked.r.ok && linked.j.turn_id) {
            updated = { ...updated, conversation_turn_id: linked.j.turn_id, version: updated.version + 1, updated_at: now() };
          } else updated = { ...updated, conversation_link_error: linked.j.error || 'conversation_link_failed' };
          updated = { ...updated, link_pending_reason: null, updated_at: now() };
          await ownedPut(mediaKey(media.media_id), updated);
        }
      });
    } catch (error) {
      if (recognitionTrial) error.trial_control = { ...recognitionTrial, state: 'stopped' };
      if (['subject_changed', 'subject_mismatch', 'stale_health_subjects'].includes(error.message)) return;
      if (['vault_changed_requires_unlock', 'vault_locked'].includes(error.message)) {
        invalidateVaultSession();
        return;
      }
      await withRecognitionLocks(media, async () => {
        const current = await vault.get(mediaKey(media.media_id));
        if (!current || current.version !== media.version || current.recognition_status !== 'processing') return;
        if (media.conversation_id && !(await vault.get(conversationKey(media.conversation_id)))) return;
        const scopedTrialControl = asrOwner ? asrMediaControl(asrOwner, error.trial_control, 'stopped') : null;
        const retryable = !error.trial_control && !asrOwner && (error.retryable === true || RECOVERABLE_MEDIA_ERRORS.has(error.code));
        const message = error.code === 'original_unavailable' ? '原录音已无法读取，不能重新识别。请重新录音；此前的模拟结果不是真实转写。'
          : error.code === 'media_mock_unavailable' ? '语音或照片识别尚未接通，原件已保存在本机；接通真实服务后可重试。'
          : retryable ? '识别没有完成，原件已保存在本机，可以重试。' : '识别没有完成，原件已保存在本机。';
        const updated = { ...current, ...(error.trial_control ? { trial_control: asrOwner ? scopedTrialControl : { ...error.trial_control, state: 'stopped' } } : {}),
          ...(scopedTrialControl && !error.trial_control ? { trial_control: scopedTrialControl } : {}), recognition_status: 'failed', recognition: { error_message: message, error: { code: error.code || 'recognition_failed', retryable }, retryable }, version: current.version + 1, updated_at: now() };
        await ownedPut(mediaKey(media.media_id), updated);
        if (error.trial_control && !asrOwner) await ownedPut(TRIAL_VOICE_KEY, { ...error.trial_control, state: 'stopped', media_id: media.media_id, conversation_id: media.conversation_id });
      });
    } finally { pendingLocalOperations -= 1; }
  }

  async function withRecognitionLocks(media, task) {
    const run = () => withMediaLock(media.media_id, task);
    return media.conversation_id ? withConversationLock(media.conversation_id, run) : run();
  }

  async function request(path, options = {}) {
    try {
      await initialise();
      if (path === '/api/health-subjects' || path === '/api/health-subjects/active') return await requestInternal(path, options);
      const body = parseBody(options);
      await checkSubjectBinding(options, body);
      const result = await requestInternal(path, options);
      // Reads and delayed replies also stay owned by the displayed patient.
      // The inner CAS guards prevent changed registry state from committing
      // a memory mutation; this check prevents stale results reaching the UI.
      await checkSubjectBinding(options, body);
      return result;
    } catch (error) {
      if (error?.name === 'QuotaExceededError') return fail(507, 'local_storage_full');
      if (['subject_changed', 'stale_health_subjects'].includes(error.message)) return fail(409, error.message);
      if (error.message === 'subject_mismatch') return fail(403, error.message);
      if (['vault_changed_requires_unlock', 'vault_locked'].includes(error.message)) {
        invalidateVaultSession();
        return fail(409, error.message);
      }
      return fail(400, error.message || 'local_request_failed');
    }
  }

  async function requestInternal(path, options = {}) {
    let counted = false;
    try {
      await initialise();
      if (restoringBackup) return fail(409, 'vault_restore_in_progress');
      pendingLocalOperations += 1; counted = true;
      if (path.startsWith('/api/health-subjects') || path.startsWith('/api/health-memory')) return await healthMemoryRequest(path, options);
      if (path === '/api/health-context' && (options.method || 'GET') === 'GET') {
        const context = await healthContext();
        return ok(200, { ok: true, subject_id: context.subject_id, health_context: { ...context, entries: context.entries.filter(item => usableHealthEntry(item, context.subject_id)) } });
      }
      if (path === '/api/health-context' && (options.method || 'GET') === 'POST') {
        const body = parseBody(options), registry = await healthSubjects(), current = await healthContext(registry.active_subject_id);
        if (body.subject_id && body.subject_id !== current.subject_id) return fail(403, 'subject_mismatch');
        if (current.entries.some(item => !item.legacy_entry)) return fail(409, 'health_context_requires_memory_editor');
        if (body.expected_version !== undefined && body.expected_version !== current.version) return fail(409, 'stale_health_memory');
        const saved = normaliseHealthContext(body, current);
        return await saveHealthMemory(current, saved, registry, true) ? ok(200, { ok: true, subject_id: current.subject_id, health_context: saved }) : fail(409, 'stale_health_memory');
      }
      if (path === '/api/handoffs' && (options.method || 'GET') === 'POST') {
        const subjectId = await activeSubjectId();
        const body=parseBody(options),start=body.start_date?Date.parse(`${body.start_date}T00:00:00`):null,end=body.end_date?Date.parse(`${body.end_date}T23:59:59.999`):null;
        const selected=Array.isArray(body.record_ids)?new Set(body.record_ids):null;
        const allEvents = await listEvents();
        const items = allEvents.filter(event => event.state !== 'superseded' && !mockSource(event)).filter(event=>{const at=Date.parse(event.recorded_at);return (!selected||selected.has(event.record_id))&&(!start||at>=start)&&(!end||at<=end)});
        const includedRecords = new Set(items.map(item => item.record_id));
        const byId = new Map(allEvents.map(event => [event.record_id, event]));
        // A corrected document still carries the original photo through its history.
        for (const item of items) {
          let previous = item.supersedes_id;
          while (previous && !includedRecords.has(previous)) {
            includedRecords.add(previous);
            previous = byId.get(previous)?.supersedes_id;
          }
        }
        const media = (await mediaList()).map(mediaPublic).filter(item => {
          const recordId = item.event_link?.record_id || item.record_id;
          if (selected || start || end) return includedRecords.has(recordId);
          return true;
        });
        const currentMedia = await mediaList();
        const handoffEventIndex = new Map(allEvents.map(event => [event.record_id, event]));
        const handoffMediaIndex = new Map(currentMedia.map(item => [item.media_id, item]));
        const conversationReports = (await listConversations()).filter(item => item.report)
          .map(item => ({ item, elder: elderTurns(item), transcript: liveConversationTurns(item).filter(turn => !mockSource(turn)),
            sourcesCurrent: audioConversationSourcesCurrent(item, handoffEventIndex, handoffMediaIndex) }))
          .filter(({item,elder,sourcesCurrent}) => {
            const at = Date.parse(`${item.last_local_date||item.local_date}T12:00:00`);
            return sourcesCurrent && (!start||at>=start) && (!end||at<=end) && (!selected||elder.some(turn=>selected.has(turn.record_id)));
          })
          .map(({item,transcript}) => ({ conversation_id: item.conversation_id, subject_id: subjectOf(item), local_date: item.local_date,
            last_local_date: item.last_local_date, status: item.status, report: item.report, completeness: item.completeness,
            transcript: transcript.map(turn => ({ turn_id: turn.turn_id, role: turn.role, text: turn.text, original_text: turn.original_text,
              created_at: turn.created_at, version: turn.version, versions: turn.versions || [], record_id: turn.record_id || null,
              ...(turn.source_kind === 'audio_transcript' ? { source: { kind: 'audio_transcript', status: turn.audio_source_reviewed === true ? 'original_comparison' : turn.audio_source_status || 'legacy_unclassified',
                record_id: turn.record_id || null, record_version: turn.audio_source_version ?? null, media_id: turn.media_id || null,
                media_version: turn.audio_source_media_version ?? null, verified_by_user: turn.audio_source_reviewed === true } } : {}) })) }));
        const pending = items.filter(safety.documentNeedsReview);
        const pendingAudio = items.filter(event => event.source_kind === 'audio_transcript' && safety.audioNeedsReview(event));
        const pendingIds = new Set(pending.map(event => event.record_id));
        for (const event of pending) { let previous = event.supersedes_id; while (previous && !pendingIds.has(previous)) { pendingIds.add(previous); previous = byId.get(previous)?.supersedes_id; } }
        const attachments = media.map(item => {
          const recordId = item.record_id || item.event_link?.record_id;
          const unreviewed = pendingIds.has(recordId);
          const unreviewedAudio = pendingAudio.some(event => event.record_id === recordId);
          // Handoffs contain attachment status, never a second copy of raw OCR.
          const reasons = [...(unreviewed ? ['document_source_review_required'] : []), ...(unreviewedAudio ? ['audio_source_review_required'] : []), ...(item.recognition_status !== 'succeeded' ? ['media_recognition_incomplete'] : []), ...(item.link_status !== 'linked' ? ['media_event_not_linked'] : [])];
          return { media_id: item.media_id, kind: item.kind, record_id: recordId, save_status: item.save_status, recognition_status: item.recognition_status, link_status: item.link_status, is_mock: mockSource(item.recognition), local_safety: unreviewed || unreviewedAudio ? null : item.local_safety, pending_reason: unreviewedAudio ? 'audio_source_review_required' : item.link_pending_reason || item.recognition?.error?.code || null, has_text: Boolean(item.recognition?.text), unresolved: reasons.length > 0, unresolved_reasons: reasons };
        });
        const safeItems = items.filter(event => !safety.documentNeedsReview(event) && !(event.source_kind === 'audio_transcript' && safety.audioNeedsReview(event))).map(event => ({ ...event, unresolved: event.state !== 'recorded' || event.local_safety?.danger_detected || event.local_safety?.clinical_review_required }));
        return ok(201, { ok: true, handoff: { handoff_id: id('handoff'), subject_id: subjectId, created_at: now(), disclaimer: '用于沟通，不是诊断。', conversation_reports: conversationReports, items: safeItems, pending_documents: pending.map(({record_id, recorded_at}) => ({record_id, recorded_at, reason: 'document_source_review_required'})), pending_audio: pendingAudio.map(({record_id, recorded_at}) => ({record_id, recorded_at, reason: 'audio_source_review_required'})), media_attachments: attachments, unresolved_count: pending.length + pendingAudio.length + safeItems.filter(event => event.unresolved).length + attachments.filter(item => item.unresolved).length } });
      }
      if (path.startsWith('/api/conversations')) return await conversationRequest(path, options);
      if (path.startsWith('/api/events')) return await eventRequest(path, options);
      if (path.startsWith('/api/media')) return await mediaRequest(path, options);
      return fail(404, 'not_found');
    } catch (error) {
      if (error?.name === 'QuotaExceededError') return fail(507, 'local_storage_full');
      if (['subject_changed', 'stale_health_subjects'].includes(error.message)) return fail(409, error.message);
      if (error.message === 'subject_mismatch') return fail(403, error.message);
      if (error.message === 'document_changed') return fail(409, 'trial_source_changed');
      if (['vault_changed_requires_unlock', 'vault_locked'].includes(error.message)) {
        invalidateVaultSession();
        return fail(409, error.message);
      }
      return fail(400, error.message || 'local_request_failed');
    } finally { if (counted) pendingLocalOperations -= 1; }
  }

  async function originalObjectUrl(mediaId) {
    await initialise(); const owner = await vault.get(mediaKey(mediaId));
    if (subjectOf(owner) !== await activeSubjectId()) throw new Error('subject_mismatch');
    const original = await vault.get(mediaBinaryKey(mediaId)); if (!original) throw new Error('原件不存在');
    await activeSubjectId();
    return URL.createObjectURL(new Blob([original.bytes], { type: original.metadata.content_type || 'application/octet-stream' }));
  }

  async function backupBlob() {
    await initialise(); const archive = await vault.exportArchive();
    return new Blob([JSON.stringify(archive)], { type: 'application/vnd.bingli.encrypted+json' });
  }

  async function downloadBackup() {
    const blob = await backupBlob();
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `NoReset-加密备份-${new Date().toISOString().slice(0, 10)}.bingli`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function previewBackup(file, passphrase) {
    await initialise();
    if (!file || file.size > 100 * 1024 * 1024) throw new Error('backup_too_large');
    let archive; try { archive = JSON.parse(await file.text()); } catch { throw new Error('invalid_backup'); }
    const preview = await vault.previewArchive(archive, passphrase);
    return { archive, eventCount: preview.eventCount, mediaCount: preview.mediaCount, exportedAt: preview.exportedAt };
  }

  async function restoreBackup(preview, passphrase) {
    if (!preview?.archive) throw new Error('backup_not_previewed');
    await initialise();
    // Restoring replaces the complete vault. A still-running reply/recognition
    // must finish before replacement, and new operations cannot start midway.
    if (restoringBackup || pendingLocalOperations) throw new Error('local_operations_busy');
    restoringBackup = true;
    try {
      const restored = await vault.restoreArchive(preview.archive, passphrase);
      observedSubjectId = null;
      announceVaultRestore();
      return restored;
    }
    finally { restoringBackup = false; }
  }

  async function saveFeedback(description, page) {
    await initialise();
    if (restoringBackup) throw new Error('vault_restore_in_progress');
    if (typeof description !== 'string' || !description.trim() || description.length > 2000) throw new Error('feedback_invalid');
    const feedback = { feedback_id: id('feedback'), description: description.trim(), page: String(page || location.hash || 'home').slice(0, 120), occurred_at: now(), includes_health_content: false, status: 'saved_on_device' };
    pendingLocalOperations += 1;
    try { await ownedPut(`feedback:${feedback.feedback_id}`, feedback); return feedback; }
    finally { pendingLocalOperations -= 1; }
  }

  async function storageStatus() {
    const estimate = await navigator.storage?.estimate?.();
    return { persisted: await navigator.storage?.persisted?.(), usage: estimate?.usage || 0, quota: estimate?.quota || 0 };
  }

  globalThis.HealthLocal = {
    get active() { return active; },
    downloadBackup,
    initialise,
    onVaultState(listener) {
      if (typeof listener !== 'function') return () => {};
      vaultStateListeners.add(listener);
      return () => vaultStateListeners.delete(listener);
    },
    lock() { vault.lock(); active = false; initialisePromise = null; observedSubjectId = null; },
    normalizeReportDisplay,
    originalObjectUrl,
    onlineStatus,
    previewBackup,
    request,
    restoreBackup,
    saveFeedback,
    savedAudioTrialAvailable,
    storageStatus,
    trialVoiceState,
    vault,
  };
})();
