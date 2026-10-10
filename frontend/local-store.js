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
  const RECOVERABLE_MEDIA_ERRORS = new Set(['media_mock_unavailable', 'provider_not_configured', 'media_configuration_invalid', 'session_unavailable', 'authentication_required', 'access_not_configured', 'ai_rate_limited', 'configuration_missing', 'network_unavailable', 'provider_timeout', 'provider_unavailable', 'provider_rate_limited']);
  let initialisePromise;
  let active = false;
  let pendingLocalOperations = 0;
  let restoringBackup = false;
  // The patient displayed in this unlocked page stays bound to this realm.
  // A shared IndexedDB selection changed by another tab cannot retarget a form.
  let observedSubjectId = null;
  const conversationWrites = new Map();
  const eventWrites = new Map();
  const mediaWrites = new Map();
  const TRIAL_VOICE_KEY = 'trial-control:voice';
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
  const CONVERSATION_FAILURE_TEXT = '这句话已保存在本机，但小零暂时没有收到模型的回复。您可以稍后重试，也可以继续记下想说的话。';
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
  function liveConversationTurns(conversation) {
    return (conversation?.turns || []).filter(turn => !turn.superseded);
  }
  function mockSource(item) {
    return item?.is_mock === true || /\[Mock (?:ASR|OCR)\]/i.test(String(item?.raw_text || item?.text || ''));
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
  async function listConversations() {
    const values = await vault.list('conversation:');
    const currentContext = await healthContext();
    return values.filter(item => item?.conversation_id && subjectOf(item) === currentContext.subject_id)
      .map(item => conversationWithCurrentReport({ ...item, subject_id: subjectOf(item) }, currentContext)).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
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
    return { context_id: previous?.context_id || id('context'), subject_id: subjectId, ...input, text: input.text.trim(),
      source: confirmed ? 'user_confirmed' : 'user_unconfirmed', recorded_at: previous?.recorded_at || time,
      confirmed_at: confirmed ? time : null, updated_at: time };
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
      const clean = { ...conversation, subject_id: previous.subject_id, selected_context_ids: selected,
        health_context: saved.entries.filter(item => selected.includes(item.context_id) && usableHealthEntry(item, previous.subject_id)),
        health_context_version: saved.version, relevant_health_context: [], completeness: null, analysis_sources: null,
        controller: legacyCompatibility ? conversation.controller : { ...conversation.controller, pending_followups: [] },
        version: legacyCompatibility ? conversation.version : conversation.version + 1, updated_at: now() };
      // Historical assistant nominations retain their immutable source receipt
      // on the old form's compatibility route. They are explicitly out of the
      // current scope; current background caches and clinical state are cleared.
      clean.report = conversation.report ? buildConversationReport(clean,
        legacyCompatibility ? conversation.report : { ...conversation.report, question_coverage: null }, saved) : null;
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
  function elderTurns(conversation) { return (conversation.turns || []).filter(turn => turn.role === 'elder' && !turn.superseded && !mockSource(turn)); }
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
    const allText = [...sources.map(turn => turn.text), ...contexts.map(entry => entry.text)];
    if (!pieces.length || pieces.some(piece => {
      const pieceClauses = clauses(piece);
      const literal = allText.some(text => {
        if (!String(text).includes(piece)) return false;
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
    return { kind: 'summary', text: item.summary, tags: ['当前整理 · 待核对'],
      source_turn_ids: turnIds, source_context_ids: contextIds,
      source_versions: sources.map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
      source_label: `当前原话${sources.length ? ' ' + sources.map(turn => turns.indexOf(turn) + 1).join('、') : '与所选背景'} · 本人未核对` };
  }
  function unclearAssociatedSymptoms(text) {
    const topic = '(?:别的|其他)(?:身体)?(?:变化|症状|表现)';
    const unknown = '(?:不清楚|不知道|不记得|不确定|记不清|说不清)';
    const withinClause = '[^，。；！？,;!?\\n]*';
    return new RegExp(`${topic}${withinClause}${unknown}|${unknown}${withinClause}${topic}`).test(text || '');
  }
  function reportTurnCategories(turn, state) {
    const fromState = CLINICAL_CATEGORIES.filter(category => state?.[category]?.status === 'known' && state[category].evidence_turn_ids?.includes(turn.turn_id));
    // Once reviewed source references exist, do not reclassify "晚上睡得好"
    // as an onset time merely because it contains "晚上".
    if (Object.keys(state).length) return fromState;
    const fromWords = CLINICAL_CATEGORIES.filter(category => REPORT_PATTERNS[category].test(turn.text || ''));
    return [...new Set([...fromState, ...fromWords])];
  }
  function reportSectionFor(categories, preferChief = false) {
    if (preferChief && categories.includes('main_complaint')) return 'chief_complaint';
    if (categories.includes('onset_course')) return 'onset_course';
    if (categories.some(category => ['relevant_history', 'prior_actions_results'].includes(category))) return 'background_actions';
    if (categories.some(category => ['symptom_character', 'aggravating_relieving', 'associated_symptoms', 'functional_impact'].includes(category))) return 'symptoms_impact';
    if (categories.includes('main_complaint')) return 'chief_complaint';
    return null;
  }
  function reportSourceQuotes(items, turns) {
    const byId = new Map(turns.filter(turn => !REPORT_META_MESSAGE.test(turn.text || '')).map(turn => [turn.turn_id, turn.text]));
    return [...new Set(items.flatMap(item => {
      const quotes = [...new Set((item.evidence_turn_ids || []).map(turnId => byId.get(turnId)).filter(Boolean))];
      return quotes.length >= 2 ? quotes : [];
    }))];
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
    return text ? { question: text, current: !question.superseded,
      source: { turn_id: question.turn_id, version: question.version, quote: question.text } } : null;
  }
  const SHORT_ANSWER = /^(?:没有|没|无|不是|有|是|有的|不知道|不清楚|不确定|不记得)[。.!！\s]*$/;
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
  function buildConversationReport(conversation, previous = null, currentContext = null) {
    const turns = elderTurns(conversation);
    if (!turns.length) return null;
    const transcript = turns.map((turn, index) => `${index + 1}. ${turn.text}`);
    const state = conversation.completeness?.clinical_state || {};
    const grouped = [
      { key: 'chief_complaint', title: '主要不适', lines: [] },
      { key: 'onset_course', title: '起病与变化', lines: [] },
      { key: 'symptoms_impact', title: '症状特点与生活影响', lines: [] },
      { key: 'background_actions', title: '相关背景与已做处理', lines: [] },
      { key: 'patient_questions', title: '患者关心的问题', lines: [] },
    ];
    const bySection = new Map(grouped.map(section => [section.key, section]));
    const collectedCategories = new Set();
    let hasChiefComplaint = false;
    const boundAnalysis = analysisSourcesCurrent(conversation);
    if (boundAnalysis) for (const category of CLINICAL_CATEGORIES) {
      const line = groundedReportSummary(state[category], conversation);
      if (!line) continue;
      const sectionKey = reportSectionFor([category], category === 'main_complaint');
      if (sectionKey) {
        collectedCategories.add(category);
        // Short replies keep their valid backend category, but their meaning
        // is displayed only with the actual question and patient original.
        if (!shortAnswerSummary(line.text)) bySection.get(sectionKey).lines.push(line);
      }
    }
    const hasCurrentSummary = grouped.some(section => section.lines.some(line => line.kind === 'summary'));
    if (!hasCurrentSummary) grouped.filter(section => section.key !== 'patient_questions')
      .forEach(section => { section.title += '（原话历史 · 待核对）'; });
    turns.forEach((turn, index) => {
      if (REPORT_META_MESSAGE.test(turn.text || '')) return;
      if (SHORT_ANSWER.test(turn.text)) return;
      if (/(担心|害怕|会不会|要不要|怎么办|想知道)/.test(turn.text || '') && !REPORT_PATTERNS.main_complaint.test(turn.text || '')) {
        bySection.get('patient_questions').lines.push({ kind: 'quote', text: turn.text, tags: ['患者疑问'],
          source_turn_ids: [turn.turn_id], source_versions: [{ turn_id: turn.turn_id, version: turn.version, quote: turn.text }],
          source_label: `患者原话 ${index + 1}` });
        return;
      }
      if (hasCurrentSummary) return;
      const categories = reportTurnCategories(turn, state);
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
    const missingLabels = {
      main_complaint: '最主要的不舒服和具体部位', onset_course: '开始时间及之后的变化',
      symptom_character: '具体感觉和严重程度', associated_symptoms: '是否同时出现其他身体变化',
      functional_impact: '对走路、睡眠、进食或自理的影响', relevant_history: '相关既往情况或相似经历',
      prior_actions_results: '已经采取的处理及结果',
    };
    const missing = Object.entries(missingLabels).filter(([category]) => !collectedCategories.has(category)).map(([, label]) => label);
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
    const contradictionQuotes = reportSourceQuotes(conversation.completeness?.contradictions || [], turns);
    if (contradictionQuotes.length) riskLines.push({
      kind: 'check', text: `这些原话可能有出入：${contradictionQuotes.map(text => `“${text}”`).join('；')}`,
      tags: ['原话有出入'], source_turn_ids: (conversation.completeness?.contradictions || []).flatMap(item => item.evidence_turn_ids || []),
      source_label: '请结合原话确认',
    });
    if (missing.length) riskLines.push({
      kind: 'check', text: `尚未问清：${missing.join('、')}。`, tags: ['信息未完整'], source_label: '继续对话后会自动补充',
    });
    const coverage = questionCoverage(conversation, previous, currentContext);
    const answerLines = answerContextLines(conversation);
    if (answerLines.length) grouped.push({ key: 'answer_context', title: '原话与对应问题', lines: answerLines });
    const pendingLines = pendingQuestionLines(conversation, coverage);
    riskLines.push(...pendingLines);
    grouped.push({ key: 'verification', title: '尚待医生核实', lines: riskLines });
    const usefulSections = grouped.filter(section => section.lines.length);
    const bodyParts = usefulSections.map(section => `${section.title}\n${section.lines.map(line => `- ${line.tags?.length ? `${line.tags.join('、')}：` : ''}${line.text}`).join('\n')}`);
    bodyParts.push(`老人原话历史（按说话顺序完整保留）\n${transcript.join('\n')}`);
    return {
      report_id: previous?.report_id || id('report'),
      format_version: 5,
      title: '就诊沟通记录',
      status: 'auto_unreviewed',
      status_label: '自动整理 · 本人未核对',
      version: (previous?.version || 0) + 1,
      generated_at: now(),
      source_turn_ids: turns.map(turn => turn.turn_id),
      source_versions: turns.map(turn => ({ turn_id: turn.turn_id, version: turn.version, quote: turn.text })),
      source_context_ids: conversation.completeness?.relevant_context_ids || [],
      pending_questions: pendingLines.map(line => line.text),
      question_coverage: coverage,
      reviewed_risk_assessments: reviewedRisks,
      legacy_clinical_review_status: 'active_unvalidated',
      clinical_validation_status: 'not_verified_by_this_application',
      sections: usefulSections,
      transcript: liveConversationTurns(conversation).filter(turn => !mockSource(turn)).map(turn => ({
        turn_id: turn.turn_id,
        role: turn.role,
        text: turn.text,
        source_kind: turn.source_kind || (turn.role === 'assistant' ? 'system' : 'elder'),
        created_at: turn.created_at,
        version: turn.version,
      })),
      body: bodyParts.join('\n\n'),
      disclaimer: '用于和医生沟通，不是诊断，也不包含用药或治疗建议。',
    };
  }
  function conversationWithCurrentReport(conversation, currentContext = null) {
    conversation = excludeMockFacts(conversation);
    if (!conversation || !elderTurns(conversation).length) return conversation;
    const missingBinding = conversation.completeness && !conversation.analysis_sources;
    const changedAnalysis = conversation.completeness && !analysisSourcesCurrent(conversation, currentContext);
    // Legacy data without a binding may retain only full historical quotes.
    const reportInput = missingBinding ? conversation : invalidateChangedAnalysis(conversation, currentContext);
    conversation = invalidateChangedAnalysis(conversation, currentContext);
    const staleRisk = (conversation.report?.reviewed_risk_assessments || [])
      .some(assessment => !safety.reviewedRiskSourcesCurrent(assessment, elderTurns(conversation)));
    const staleSources = JSON.stringify(conversation.report?.source_versions) !== JSON.stringify(analysisSources(conversation).turns);
    const currentTurns = elderTurns(conversation);
    const staleQuoteSources = conversation.report?.sections?.some(section => section.lines?.some(line => {
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
    const expectedSummaries = analysisSourcesCurrent(conversation, currentContext) ? CLINICAL_CATEGORIES.flatMap(category => {
      const line = groundedReportSummary(conversation.completeness?.clinical_state?.[category], conversation);
      const section = reportSectionFor([category], category === 'main_complaint');
      return line && section && !shortAnswerSummary(line.text) ? [JSON.stringify([section, line])] : [];
    }).sort() : [];
    const cachedSummaries = (conversation.report?.sections || []).flatMap(section => (section.lines || [])
      .filter(line => line.kind === 'summary').map(line => JSON.stringify([section.key, line]))).sort();
    const staleSummaries = JSON.stringify(expectedSummaries) !== JSON.stringify(cachedSummaries);
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
    if (conversation.report?.format_version === 5 && !staleRisk && !changedAnalysis && !staleSources && !staleQuoteSources && !unboundSummary && !staleSummaries && !stalePending && !staleCoverage && !staleAnswers) return conversation;
    return { ...conversation, report: buildConversationReport(reportInput, conversation.report, currentContext) };
  }
  function conversationArchiveView(conversation) {
    const current = conversationWithCurrentReport(conversation);
    return {
      conversation_id: current.conversation_id,
      local_date: current.local_date,
      last_local_date: current.last_local_date,
      created_at: current.created_at,
      updated_at: current.updated_at,
      status: current.status,
      version: current.version,
      report: current.report,
      turns: liveConversationTurns(current).map(turn => ({
        turn_id: turn.turn_id,
        role: turn.role,
        text: turn.text,
        source_kind: turn.source_kind || (turn.role === 'assistant' ? 'system' : 'elder'),
        record_id: turn.record_id || null,
        created_at: turn.created_at,
        edited_at: turn.edited_at || null,
        version: turn.version,
        versions: turn.versions || [],
        action: turn.action || null,
        is_mock: mockSource(turn),
        local_safety: turn.local_safety || null,
      })),
    };
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
  async function saveConversation(conversation) {
    const saved = { ...conversation, version: (conversation.version || 0) + 1, updated_at: now() };
    await ownedPut(conversationKey(saved.conversation_id), saved);
    return saved;
  }
  async function cleanupTemporaryAudio(mediaId) {
    if (!mediaId) return false;
    return withMediaLock(mediaId, async () => {
      const media = await vault.get(mediaKey(mediaId));
      if (!media || media.trial_control || media.kind !== 'audio' || media.temporary !== true || media.recognition_status !== 'succeeded' || media.recognition?.is_mock || mockSource(media.recognition)) return false;
      await ownedMutation({ deletes: [mediaBinaryKey(mediaId), mediaKey(mediaId)] });
      return true;
    });
  }

  function injectGate() {
    if (document.getElementById('localVaultGate')) return;
    const gate = document.createElement('section');
    gate.id = 'localVaultGate'; gate.className = 'secure-gate'; gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true'); gate.setAttribute('aria-labelledby', 'vaultTitle');
    gate.innerHTML = `<div class="secure-card"><div class="secure-brand"><img src="assets/brand-mascot.png" alt=""><div><strong>NoReset·内测版</strong><span>陪你把每次不舒服记下来</span></div></div><p class="secure-kicker" id="vaultKicker">本机资料已加密</p><h1 id="vaultTitle">解锁本机健康资料</h1><p id="vaultExplain">健康记录加密保存在当前浏览器。恢复口令不会上传；忘记后无法由服务器找回。</p><form id="vaultForm"><label for="vaultPassphrase">恢复口令（至少 10 个字或字符）</label><input id="vaultPassphrase" type="password" minlength="10" autocomplete="current-password" required><label id="vaultConfirmLabel" for="vaultPassphraseConfirm" class="hidden">再输入一次</label><input id="vaultPassphraseConfirm" class="hidden" type="password" minlength="10" autocomplete="new-password"><button class="primary" id="vaultSubmit" type="submit">解锁</button><p id="vaultStatus" class="status" role="status"></p></form><details id="vaultRestore"><summary>已有加密备份？从备份恢复</summary><p>换设备或清理过浏览器时，选择以前下载的备份，并输入那份备份的恢复口令。</p><form id="vaultRestoreForm"><label for="vaultRestoreFile">加密备份文件</label><input id="vaultRestoreFile" type="file" accept=".bingli,application/json" required><label for="vaultRestorePassphrase">备份的恢复口令</label><input id="vaultRestorePassphrase" type="password" autocomplete="current-password" required><button class="outline" id="vaultRestoreSubmit" type="submit">检查并恢复备份</button><p id="vaultRestoreStatus" class="status" role="status"></p></form></details><p class="secure-foot">请妥善记住口令，并定期在设置中下载加密备份。</p></div>`;
    document.body.append(gate);
  }

  async function unlockUi() {
    injectGate();
    const gate = document.getElementById('localVaultGate');
    const status = await vault.status();
    const isSetup = !status.configured;
    document.getElementById('vaultKicker').textContent = isSetup ? '第一次使用 · 只需设置一次' : '本机资料已加密';
    document.getElementById('vaultTitle').textContent = isSetup ? '保护这台设备上的健康记录' : '解锁本机健康资料';
    document.getElementById('vaultExplain').textContent = isSetup
      ? '请设置一个自己记得住的口令。记录只保存在当前浏览器，口令不会上传；忘记后无法找回。'
      : '健康记录加密保存在当前浏览器。恢复口令不会上传；忘记后无法由服务器找回。';
    document.getElementById('vaultSubmit').textContent = isSetup ? '建立并进入' : '解锁';
    document.getElementById('vaultSubmit').disabled = false;
    document.getElementById('vaultStatus').textContent = '';
    document.getElementById('vaultRestore').classList.toggle('hidden', !isSetup);
    document.getElementById('vaultPassphrase').autocomplete = isSetup ? 'new-password' : 'current-password';
    document.getElementById('vaultConfirmLabel').classList.toggle('hidden', !isSetup);
    document.getElementById('vaultPassphraseConfirm').classList.toggle('hidden', !isSetup);
    gate.classList.remove('hidden');
    const appShell = document.querySelector('.app-shell');
    if (appShell) appShell.inert = true;
    document.getElementById('vaultPassphrase').focus();
    return new Promise(resolve => {
      const complete = async () => {
        for (const name of ['vaultPassphrase', 'vaultPassphraseConfirm', 'vaultRestorePassphrase']) document.getElementById(name).value = '';
        active = true; gate.classList.add('hidden');
        if (appShell) appShell.inert = false;
        try { await navigator.storage?.persist?.(); } catch {}
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
    });
  }

  async function initialise() {
    if (!initialisePromise) initialisePromise = unlockUi();
    await initialisePromise;
    return true;
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

  async function cloudRequest(path, options = {}) {
    const subjectAllowed = async () => !options.healthSubjectId || options.healthSubjectId === await activeSubjectId();
    if (!await subjectAllowed()) return fail(403, 'subject_mismatch');
    const voice = path === '/api/ai/conversation-turn' || (path === '/api/ai/media/recognize' && options.body?.get?.('kind') === 'audio');
    const blockedVoice = async () => {
      if (!voice) return null;
      const trial = await trialVoiceState(), owner = options.trialVoiceContinue;
      if (owner) {
        const conversation = await vault.get(conversationKey(owner.conversation_id));
        const control = conversation?.trial_control;
        const sameOwner = value => value?.state === 'continuing' && value.conversation_id === owner.conversation_id
          && value.turn_id === owner.turn_id && value.turn_version === owner.turn_version && value.media_id === owner.media_id;
        if (!sameOwner(trial) || !sameOwner(control) || conversation.version !== owner.conversation_version) return fail(409, trial?.state === 'stopped' ? 'trial_stopped' : 'trial_review_required');
      } else if (trial && trial.state !== 'completed') return fail(409, trial.state === 'stopped' ? 'trial_stopped' : 'trial_review_required');
      return null;
    };
    const blocked = await blockedVoice(); if (blocked) return blocked;
    const { trialVoiceContinue, healthSubjectId, ...transportOptions } = options;
    // Read the current HttpOnly session before each operation; never retain a token
    // in a backup, browser storage or a second UI password flow.
    const csrf = await onlineSession();
    if (!csrf) return fail(401, 'session_unavailable', { retryable: true });
    if (!await subjectAllowed()) return fail(403, 'subject_mismatch');
    const lateBlocked = await blockedVoice(); if (lateBlocked) return lateBlocked;
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
  async function collectDeletionPlan(recordIds, conversationId = null) {
    const recordSet = new Set(recordIds);
    const linkedMedia = (await mediaList()).filter(item => recordSet.has(item.event_link?.record_id)
      || recordSet.has(item.record_id) || (conversationId && item.conversation_id === conversationId));
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
  async function updateEvent(event, action, changes, note = null) {
    const updated = { ...event, ...changes, version: event.version + 1, updated_at: now() };
    await ownedMutation({ puts: [historyDocument(event, action, note), { key: eventKey(event.record_id), value: updated }] }); return updated;
  }

  async function eventRequest(path, options, locked = false) {
    const method = options?.method || 'GET'; const parts = path.split('/').filter(Boolean);
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
      const plan = await eventDeletionPlan(recordId);
      if (plan.error === 'conversation_source_changed') return linkedSourceConflict();
      if (plan.error) return fail(plan.error === 'event_not_found' ? 404 : 409, plan.error);
      return withMediaLocks(plan.mediaIds, async () => {
        const latest = await eventDeletionPlan(recordId);
        if (latest.error === 'conversation_source_changed') return linkedSourceConflict();
        if (latest.error) return fail(latest.error === 'event_not_found' ? 404 : 409, latest.error);
        if (latest.mediaIds.some(mediaId => !plan.mediaIds.includes(mediaId))) return fail(409, 'stale_media_links');
        await ownedMutation({ deletes: latest.deletes });
        return ok(200, { ok: true, deleted: { record_id: recordId, record_count: latest.recordIds.length, local_media_count: latest.mediaIds.length, encrypted_backups_unchanged: true } });
      });
    }
    if (parts.length === 3 && method === 'GET') return ok(200, { ok: true, event: mockSource(event) ? { ...event, is_mock: true } : event });
    if (parts[3] === 'history' && method === 'GET') return ok(200, { ok: true, history: await vault.list(`history:${recordId}:`), audit: [] });
    if (method !== 'POST') return fail(404, 'not_found');
    if (Number(body.expected_version) !== event.version) return fail(409, 'stale_version');
    if (parts[3] === 'source-review') {
      if (event.source_kind !== 'document' || event.state === 'superseded' || mockSource(event)) return fail(409, 'source_review_not_available');
      if (body.compared_with_original !== true) return fail(400, 'source_review_confirmation_required');
      const updated = await updateEvent(event, 'source_reviewed', { source_review: { method: 'original_comparison', text: event.raw_text, confirmed_at: now() }, state: 'inbox', draft: null, ai_metadata: null, confirmation_scope: null }, '使用者声明已对照原件逐行核对；看不清的内容保留为未知');
      return ok(200, { ok: true, event: updated });
    }
    if (['organize', 'review', 'summary'].includes(parts[3]) && safety.documentNeedsReview(event)) return fail(409, 'document_source_review_required', { event });
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
      const replacement = { ...superseded, record_id: id('rec'), raw_text: body.raw_text, source_kind: event.source_kind === 'document' ? 'document' : body.source_kind || event.source_kind, actor_name: body.actor_name || event.actor_name, recorded_at: now(), updated_at: now(), occurred_time: event.occurred_time, state: 'inbox', version: 1, supersedes_id: event.record_id, local_safety: safety.scanDanger(body.raw_text), draft: null, ai_metadata: null, source_review: null, confirmation_scope: null };
      const supersededHistory = historyDocument(event, 'superseded', body.reason);
      const replacementHistory = historyDocument(replacement, 'created_from_revision', body.reason);
      const puts = [
        { key: eventKey(superseded.record_id), value: superseded },
        { key: eventKey(replacement.record_id), value: replacement },
        supersededHistory,
        replacementHistory,
      ];
      for (const conversation of await conversationsUsingRecords([recordId])) {
        const firstIndex = conversation.turns.findIndex(turn => turn.role === 'elder' && turn.record_id === recordId);
        if (firstIndex < 0) return linkedSourceConflict();
        const editedAt = now();
        const turns = conversation.turns.map((turn, index) => {
          if (turn.role === 'elder' && turn.record_id === recordId) return { ...turn,
            text: replacement.raw_text, record_id: replacement.record_id, source_kind: replacement.source_kind,
            is_mock: false, local_safety: replacement.local_safety, version: turn.version + 1, edited_at: editedAt,
            versions: [...(turn.versions || []), { version: turn.version, text: turn.text,
              record_id: turn.record_id, replaced_at: editedAt }],
          };
          if (index > firstIndex && turn.role === 'assistant') return { ...turn, superseded: true };
          return turn;
        });
        const updated = { ...conversation, turns, version: conversation.version + 1, updated_at: editedAt,
          controller: openingConversationController(), completeness: null, relevant_health_context: [],
          last_ai_metadata: null };
        updated.report = buildConversationReport(updated, conversation.report);
        puts.push({ key: conversationKey(conversation.conversation_id), value: updated });
      }
      await ownedMutation({ puts });
      return ok(201, { ok: true, event: replacement });
    }
    return fail(404, 'not_found');
  }

  async function createConversation(localDate) {
    if (!validLocalDate(localDate)) return fail(400, 'local_date_invalid');
    const registry = await healthSubjects(), subjectId = await activeSubjectId(registry), context = await healthContext(subjectId);
    const remembered = context.entries.filter(item => item.remember && usableHealthEntry(item, registry.active_subject_id)).slice(0, 5);
    const createdAt = now();
    const conversation = {
      conversation_id: id('conversation'),
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
    await ownedMutation({ puts: [{ key: conversationKey(conversation.conversation_id), value: conversation }], unchanged: [{ key: HEALTH_SUBJECTS_KEY, value: registry }] });
    return ok(201, { ok: true, conversation });
  }

  async function conversationModelPayload(conversation) {
    const allElderTurns = elderTurns(conversation).slice(-40);
    if (subjectOf(conversation) !== await activeSubjectId()) throw new Error('subject_mismatch');
    const currentContext = await healthContext(subjectOf(conversation));
    const selected = new Set(conversation.selected_context_ids || []);
    const context = currentContext.entries.filter(item => selected.has(item.context_id) && usableHealthEntry(item, subjectOf(conversation))).slice(0, 5);
    conversation.health_context = context;
    conversation.health_context_version = currentContext.version;
    return {
      subject_id: subjectOf(conversation),
      turns: allElderTurns.map(turn => {
        const index = conversation.turns.findIndex(item => item.turn_id === turn.turn_id);
        const previous = conversation.turns[index - 1];
        const question = turn.responding_to || (previous?.role === 'assistant' && ['ask', 'reply'].includes(previous.action) && !mockSource(previous)
          ? { turn_id: previous.turn_id, text: previous.text } : null);
        return { turn_id: turn.turn_id, text: turn.text, version: turn.version, ...(question && !mockSource(question) ? { responding_to: question } : {}) };
      }),
      controller: conversation.controller,
      health_context: context.map(healthEntryPayload),
    };
  }

  async function appendAssistantResult(conversation, result) {
    const sendingVersion = conversation.version;
    const sendingSources = JSON.stringify(analysisSources(conversation));
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
    const safeResult = result.r.ok && typeof result.j?.assistant_text === 'string' && result.j.assistant_text.trim()
      && result.j.assistant_text.length <= 1000 && ['ask', 'reply', 'finish', 'urgent', 'soon_evaluation'].includes(result.j.action)
      && !/mock/i.test(result.j.provider || '') && (!riskRequested || Boolean(riskAssessment))
      && (reviewedFixedText || !unsafeAssistantText(result.j.assistant_text));
    const assistantText = safeResult ? String(result.j.assistant_text || CONVERSATION_FINISH_TEXT) : CONVERSATION_FAILURE_TEXT;
    const assistant = {
      turn_id: id('turn'), role: 'assistant', text: assistantText,
      action: safeResult ? result.j.action : 'finish',
      question_category: safeResult && !riskAssessment ? result.j.question_category || null : null,
      stop_reason: safeResult ? riskAssessment ? 'reviewed_risk_rule' : result.j.stop_reason || null : 'model_failed',
      created_at: now(), version: 1, ai_failed: !safeResult,
      ...(safeResult && riskAssessment ? { risk_assessment: riskAssessment, reviewed_risk_validated: true } : {}),
    };
    const next = {
      ...conversation,
      turns: [...conversation.turns.map((turn, index) => index === conversation.turns.length - 1 && turn.ai_failed ? { ...turn, superseded: true } : turn), assistant],
      controller: safeResult && riskAssessment ? { ...conversation.controller, last_question_category: null }
        : safeResult && result.j.controller ? result.j.controller : conversation.controller,
      completeness: safeResult && result.j.completeness ? result.j.completeness : conversation.completeness,
      analysis_sources: safeResult && result.j.completeness ? analysisSources(conversation) : conversation.analysis_sources || null,
      relevant_health_context: safeResult && result.j.completeness ? (conversation.health_context || []).filter(item => result.j.completeness.relevant_context_ids?.includes(item.context_id)) : conversation.relevant_health_context || [],
      last_ai_metadata: safeResult ? { provider: result.j.provider, model_id: result.j.model_id, prompt_version: result.j.prompt_version, trace_id: result.j.trace_id } : { ai_failed: true, error: result.j?.error || 'ai_conversation_failed' },
    };
    const current = invalidateChangedAnalysis(next, currentContext);
    current.report = buildConversationReport(current, conversation.report);
    const saved = { ...current, version: conversation.version + 1, updated_at: now() };
    const registry = await healthSubjects();
    if (registry.active_subject_id !== subjectOf(conversation)) return { conversation: storedConversation, applied: false };
    const contextGuard = [{ key: HEALTH_SUBJECTS_KEY, value: registry }];
    if (conversation.selected_context_ids?.length) {
      const rawContext = await vault.get(healthContextKey(subjectOf(conversation)));
      if (Number(rawContext?.version || 0) !== currentContext.version) return { conversation: storedConversation, applied: false };
      contextGuard.push({ key: healthContextKey(subjectOf(conversation)), value: rawContext });
    }
    if (await vault.putIfUnchanged(conversationKey(conversation.conversation_id), storedConversation, saved, contextGuard)) {
      return { conversation: saved, applied: true };
    }
    const latest = await vault.get(conversationKey(conversation.conversation_id));
    if (!latest) throw new Error('conversation_not_found');
    return { conversation: latest, applied: false };
  }

  async function conversationReply(conversation, trialContinue = false) {
    if (conversation.trial_control && !trialContinue) return fail(409, 'trial_review_required');
    const latest = elderTurns(conversation).at(-1);
    if (latest?.local_safety?.danger_detected) {
      return ok(200, { action: 'urgent', assistant_text: safety.DANGER_REMINDER,
        provider: 'LocalDangerRule', stop_reason: 'urgent_rule',
        controller: { ...conversation.controller, last_question_category: null } });
    }
    return cloudRequest('/api/ai/conversation-turn', { healthSubjectId: subjectOf(conversation), method: 'POST', body: JSON.stringify(await conversationModelPayload(conversation)), ...(trialContinue ? { trialVoiceContinue: { ...conversation.trial_control, conversation_version: conversation.version } } : {}) });
  }

  async function conversationRequest(path, options, locked = false, sourceLocked = false, backgroundInactive = false) {
    const method = options?.method || 'GET';
    const pathname = path.split('?')[0];
    const parts = pathname.split('/').filter(Boolean);
    if (!locked && method !== 'GET' && parts[2] && !['start', 'current'].includes(parts[2])) {
      return withConversationLock(parts[2], () => conversationRequest(path, options, true));
    }
    const body = parseBody(options);
    if (body.subject_id && body.subject_id !== await activeSubjectId()) return fail(403, 'subject_mismatch');
    if (!sourceLocked && method === 'POST' && parts[3] === 'turns' && parts.length === 4 && body.record_id) {
      // Existing-source linking participates in archive correction/deletion
      // locks so a new conversation cannot acquire a source midway through it.
      return withEventLock(body.record_id, () => conversationRequest(path, options, true, true));
    }
    if (pathname === '/api/conversations' && method === 'GET') {
      const conversations = (await listConversations()).filter(item => item.turns.some(turn => turn.role === 'elder' && !turn.superseded)).map(conversationArchiveView);
      return ok(200, { ok: true, conversations });
    }
    if (pathname === '/api/conversations/current' && method === 'GET') {
      const params = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
      const localDate = params.get('local_date');
      if (!validLocalDate(localDate)) return fail(400, 'local_date_invalid');
      const conversations = await listConversations();
      const sameDay = conversations.find(item => item.last_local_date === localDate) || null;
      if (sameDay) return ok(200, { ok: true, conversation: conversationWithCurrentReport(sameDay), resume_choice_required: false });
      const latest = conversations.find(item => elderTurns(item).length > 0) || conversations[0] || null;
      if (!latest) return ok(200, { ok: true, conversation: null, resume_choice_required: false });
      return ok(200, { ok: true, conversation: null, previous_conversation: conversationWithCurrentReport(latest), resume_choice_required: true });
    }
    if (pathname === '/api/conversations/start' && method === 'POST') {
      if (!validLocalDate(body.local_date)) return fail(400, 'local_date_invalid');
      if (body.mode === 'continue') {
        const conversations = await listConversations();
        const latest = conversations.find(item => elderTurns(item).length > 0) || conversations[0];
        if (!latest) return createConversation(body.local_date);
        const continued = await saveConversation({ ...latest, status: 'active', last_local_date: body.local_date });
        return ok(200, { ok: true, conversation: continued });
      }
      if (body.mode !== 'new') return fail(400, 'conversation_mode_invalid');
      return createConversation(body.local_date);
    }
    const conversationId = decodeURIComponent(parts[2] || '');
    const storedConversation = await vault.get(conversationKey(conversationId));
    if (storedConversation && subjectOf(storedConversation) !== await activeSubjectId()) return fail(403, 'subject_mismatch');
    let conversation = excludeMockFacts(storedConversation);
    if (!conversation) return fail(404, 'conversation_not_found');
    if (parts.length === 3 && method === 'DELETE') {
      if (body.delete_scope_confirmed !== true) return fail(400, 'delete_confirmation_required');
      if (Number(body.expected_version) !== conversation.version) return fail(409, 'stale_conversation');
      const recordIds = [...new Set(conversation.turns.filter(turn => turn.role === 'elder').map(turn => turn.record_id).filter(Boolean))];
      const component = await eventRevisionComponent(recordIds);
      const lockedRecords = new Set([...recordIds, ...component.recordIds]);
      const lockedMedia = new Set();
      // The atomic plan covers item.conversation_id === conversationId media,
      // removeEventBody(recordId) history/event keys, and remove(conversationKey(conversationId)).
      while (true) {
        const result = await withEventLocks([...lockedRecords], async () => {
          const currentComponent = await eventRevisionComponent(recordIds);
          if (currentComponent.recordIds.some(id => !lockedRecords.has(id))) return { retryRecords: currentComponent.recordIds };
          if ((await conversationsUsingRecords(currentComponent.recordIds)).some(item => item.conversation_id !== conversationId)) {
            return { error: 'conversation_source_shared' };
          }
          const initialPlan = await collectDeletionPlan(currentComponent.recordIds, conversationId);
          if (initialPlan.mediaIds.some(id => !lockedMedia.has(id))) return { retryMedia: initialPlan.mediaIds };
          return withMediaLocks([...lockedMedia], async () => {
            const latestComponent = await eventRevisionComponent(recordIds);
            if (latestComponent.recordIds.some(id => !lockedRecords.has(id))) return { retryRecords: latestComponent.recordIds };
            const latestPlan = await collectDeletionPlan(latestComponent.recordIds, conversationId);
            if (latestPlan.mediaIds.some(id => !lockedMedia.has(id))) return { retryMedia: latestPlan.mediaIds };
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
        if (result.error === 'conversation_source_shared') return fail(409, result.error, {
          message: '这段对话的原话还被其他对话引用，暂不能删除，以免其他报告失去来源。当前资料未被删除。',
        });
        if (!result.ok) return fail(409, 'stale_delete_scope');
        return ok(200, { ok: true, deleted: { conversation_id: conversationId, record_count: result.plan.recordIds.length,
          local_media_count: result.plan.mediaIds.length, pending_upload_count: result.plan.uploadIds.length, encrypted_backups_unchanged: true } });
      }
    }
    if (parts.length === 3 && method === 'GET') return ok(200, { ok: true, conversation: conversationWithCurrentReport(conversation, await healthContext()) });
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
        let updated = { ...latest, selected_context_ids: ids,
          health_context: current.entries.filter(item => selected.has(item.context_id)),
          health_context_version: current.version,
          relevant_health_context: (latest.relevant_health_context || []).filter(item => selected.has(item.context_id)),
          completeness: latest.completeness ? { ...latest.completeness,
            relevant_context_ids: (latest.completeness.relevant_context_ids || []).filter(value => selected.has(value)) } : null };
        updated = invalidateChangedAnalysis(updated, current);
        updated.report = buildConversationReport(updated, latest.report);
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
        let latest = excludeMockFacts(await vault.get(conversationKey(conversationId)));
        const trial = await trialVoiceState();
        if (latest?.trial_control || trial && trial.state !== 'completed') return ok(200, { ok: true, conversation: latest, trial_control: latest?.trial_control || trial, recovered: false });
        const pending = pendingElderTurn(latest);
        if (!pending) return ok(200, { ok: true, recovered: false, ai_failed: false, conversation: latest });
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
      let controlled = sourceMedia?.trial_control;
      const trial = await trialVoiceState();
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
      if (trial && trial.state !== 'completed' && !controlled) return fail(409, trial.state === 'stopped' ? 'trial_stopped' : 'trial_review_required');
      if (conversation.trial_control && !controlled) return fail(409, 'trial_review_required');
      if (controlled && !controlledText && (sourceMedia.conversation_id !== conversationId || sourceMedia.record_id !== body.record_id || sourceMedia.recognition?.text !== text)) return fail(409, 'trial_source_changed');
      if (Number(body.expected_version) !== conversation.version) return fail(409, 'stale_conversation');
      let event;
      if (body.record_id) event = await readEvent(body.record_id);
      if (body.record_id && !event) return fail(409, 'conversation_source_invalid');
      if (event && (!['elder', 'audio_transcript'].includes(event.source_kind) || event.raw_text !== text || event.state === 'superseded')) return fail(409, 'conversation_source_invalid');
      if (!event) {
        const created = await createEvent({ subject_id: subjectOf(conversation), raw_text: text, source_kind: body.source_kind === 'audio_transcript' ? 'audio_transcript' : 'elder', actor_name: '老人', related_record_ids: elderTurns(conversation).map(turn => turn.record_id).filter(Boolean).slice(-10) }, `conversation-event:${operationKey}`);
        if (!created.r.ok) return created;
        event = created.j.event;
      }
      const userTurn = {
        turn_id: id('turn'), role: 'elder', original_text: text, text, source_kind: event.source_kind,
        record_id: event.record_id, media_id: body.media_id || null, local_safety: event.local_safety, created_at: now(), version: 1, versions: [],
      };
      const previous = liveConversationTurns(conversation).at(-1);
      if (previous?.role === 'assistant' && ['ask', 'reply'].includes(previous.action) && !mockSource(previous)) {
        userTurn.responding_to = { turn_id: previous.turn_id, text: previous.text };
        userTurn.responding_to_version = previous.version;
      }
      let withUser = {
        ...conversation,
        status: backgroundInactive ? conversation.status : 'active',
        turns: [...conversation.turns, userTurn],
        controller: conversation.controller,
        completeness: conversation.completeness,
        active_episode_start_turn_id: null,
      };
      if (controlledText) withUser = invalidateChangedAnalysis(withUser, await healthContext());
      withUser.report = buildConversationReport(withUser, conversation.report);
      const operation = { key: `operation:conversation-turn:${operationKey}`, value: { conversation_id: conversationId, turn_id: userTurn.turn_id } };
      if (controlled) {
        try {
          conversation = await saveTrialConversation({ ...withUser, status: 'paused' }, { ...controlled, conversation_id: conversationId, turn_id: userTurn.turn_id, turn_version: userTurn.version, media_id: body.media_id || null }, [operation], [{ key: conversationKey(conversationId), value: storedConversation }, { key: TRIAL_VOICE_KEY, value: trial }]);
        } catch (error) {
          // Raw-first saving is intentional. A concurrent stop wins, while its
          // independently saved source remains available in My Records.
          if (error.message === 'document_changed') return fail(409, 'trial_source_changed', { raw_text_preserved_on_device: true, source_record_id: event.record_id });
          throw error;
        }
      } else conversation = await saveConversation(withUser);
      if (!controlled) await ownedPut(operation.key, operation.value);
      if (controlled) return ok(201, { ok: true, created: true, conversation, turn_id: userTurn.turn_id, trial_control: conversation.trial_control });
      // A recognition already in flight can complete after an explicit pause.
      // Save its source and report, then wait for the user to return for a reply.
      if (backgroundInactive) return ok(201, { ok: true, created: true, conversation, turn_id: userTurn.turn_id });
      const result = await conversationReply(conversation);
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
      if (Number(body.expected_version) !== current.version) return fail(409, 'stale_version');
      if (Number(body.expected_conversation_version) !== conversation.version) return fail(409, 'stale_conversation');
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
        if (turnIndex === index) return { ...turn, text, is_mock: false, local_safety: revisedSafety, version: turn.version + 1, edited_at: now(), versions: [...(turn.versions || []), { version: turn.version, text: turn.text, replaced_at: now() }] };
        if (turnIndex > index && turn.role === 'assistant') return { ...turn, superseded: true };
        return turn;
      });
      const edited = { ...conversation, turns, controller: openingConversationController(), completeness: null, analysis_sources: null, relevant_health_context: [] };
      if (trialControl) {
        const latest = elderTurns(edited).at(-1);
        edited.trial_control = { ...trialControl, conversation_id: conversationId, turn_id: latest.turn_id,
          turn_version: latest.version, media_id: latest.media_id || null, source_kind: latest.source_kind };
      }
      edited.report = buildConversationReport(edited, conversation.report);
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
              state: 'inbox', local_safety: revisedSafety, draft: null, ai_metadata: null } });
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
      const result = await conversationReply(conversation);
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
  async function mediaList() { const subjectId = await activeSubjectId(); return (await vault.list('media:')).filter(item => item?.media_id && subjectOf(item) === subjectId).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)); }
  function mediaCapabilities() { return { enabled: true, disabled_reason: null, max_total_bytes: MAX_MEDIA_BYTES, max_part_bytes: 2 * 1024 * 1024, max_parts: 12, audio_content_types: MEDIA_TYPES.audio, image_content_types: MEDIA_TYPES.image, multipart_upload: true, resumable_parts: true }; }
  async function mediaRequest(path, options) {
    const method = options?.method || 'GET'; const parts = path.split('/').filter(Boolean);
    if (path === '/api/media/capabilities' && method === 'GET') return ok(200, { ok: true, capabilities: mediaCapabilities() });
    if (path === '/api/media' && method === 'GET') return ok(200, { ok: true, media: (await mediaList()).map(mediaPublic) });
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
    if(!media&&parts.length===3&&method==='GET'){const upload=(await vault.list('upload:')).find(item=>item.media_id===mediaId);if(upload)return subjectOf(upload) === await activeSubjectId() ? ok(200,{ok:true,media:{media_id:mediaId,subject_id:subjectOf(upload),kind:upload.kind,content_type:upload.content_type,original_filename:upload.original_filename,save_status:'uploading',recognition_status:'not_started',link_status:'not_linked',version:0}}) : fail(403,'subject_mismatch');}
    if (!media) return fail(404, 'media_not_found');
    if (parts.length === 3 && method === 'GET') return ok(200, { ok: true, media: mediaPublic(media) });
    if (parts[3] === 'recognize' && method === 'POST') {
      return withRecognitionLocks(media, () => withMediaLock('voice-recognition-start', async () => {
        const current = await vault.get(mediaKey(mediaId));
        if (!current) return fail(404, 'media_not_found');
        const sourceConversation = current.conversation_id ? await vault.get(conversationKey(current.conversation_id)) : null;
        if (current.conversation_id && !sourceConversation) return fail(404, 'conversation_not_found');
        if (mediaPublic(current).recognition_status === 'processing') return ok(202, { ok: true, action: 'existing', media: mediaPublic(current) });
        if (current.kind === 'audio') {
          const trial = await trialVoiceState();
          if (trial && trial.state !== 'completed') return fail(409, trial.state === 'stopped' ? 'trial_stopped' : 'trial_review_required', { media: mediaPublic(current) });
          if (current.recognition_status === 'succeeded' && current.trial_control) return ok(200, { ok: true, media: mediaPublic(current) });
          if ((await mediaList()).some(item => item.media_id !== mediaId && item.kind === 'audio' && item.recognition_status === 'processing')) return fail(409, 'audio_recognition_in_progress', { media: mediaPublic(current) });
        }
        const processing = { ...current, conversation_version_at_start: sourceConversation?.version ?? null,
          recognition_status: 'processing', version: current.version + 1, updated_at: now(), recognition: null };
        await ownedPut(mediaKey(mediaId), processing);
        processRecognition(processing);
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

  async function processRecognition(media) {
    pendingLocalOperations += 1;
    let recognitionTrial = null;
    try {
      const original = await vault.get(mediaBinaryKey(media.media_id));
      if (!original?.bytes) throw Object.assign(new Error('original_unavailable'), { code: 'original_unavailable' });
      const form = new FormData(); form.append('kind', media.kind); form.append('content_type', media.content_type); form.append('attempt_id', id('attempt')); form.append('file', new Blob([original.bytes], { type: media.content_type }), media.original_filename);
      const result = await cloudRequest('/api/ai/media/recognize', { healthSubjectId: subjectOf(media), method: 'POST', body: form });
      const trial = media.kind === 'audio' ? trialMarker(result.j) : null;
      recognitionTrial = trial;
      if (trial) await ownedPut(TRIAL_VOICE_KEY, { ...trial, media_id: media.media_id, conversation_id: media.conversation_id });
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
        let updated = { ...current, ...(trial ? { trial_control: trial } : {}), recognition_status: 'succeeded', recognition: result.j.recognition, local_safety: created.j.event.local_safety, event_link: { record_id: created.j.event.record_id }, record_id: created.j.event.record_id, link_status: 'linked', link_pending_reason: media.temporary === true && media.conversation_id ? 'conversation_link_pending' : null, conversation_link_error: null, version: current.version + 1, updated_at: now() };
        await ownedPut(mediaKey(media.media_id), updated);
        if (updated.temporary === true && updated.conversation_id) {
          // Only a pause/finish after this attempt started defers the reply.
          // A new recording made after returning to a paused conversation still
          // follows the ordinary automatic dialogue path.
          const backgroundInactive = !trial && ['paused', 'finished'].includes(conversation.status)
            && conversation.version !== media.conversation_version_at_start;
          // This internal source is already owned by the conversation lock.
          // Its local owner pointer makes archive mutations take that lock too;
          // avoid taking event after media, which would invert delete's order.
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
          if (backgroundInactive && linked.r.ok && linked.j.turn_id && updated.kind === 'audio') {
            // The media lock is already held. Apply the same successful,
            // temporary, non-trial cleanup without trying to acquire it again.
            await ownedMutation({ deletes: [mediaBinaryKey(updated.media_id), mediaKey(updated.media_id)] });
          }
        }
      });
    } catch (error) {
      if (recognitionTrial) error.trial_control = { ...recognitionTrial, state: 'stopped' };
      if (['subject_changed', 'subject_mismatch', 'stale_health_subjects'].includes(error.message)) return;
      if (['vault_changed_requires_unlock', 'vault_locked'].includes(error.message)) {
        active = false; initialisePromise = null; observedSubjectId = null;
        return;
      }
      await withRecognitionLocks(media, async () => {
        const current = await vault.get(mediaKey(media.media_id));
        if (!current || current.version !== media.version || current.recognition_status !== 'processing') return;
        if (media.conversation_id && !(await vault.get(conversationKey(media.conversation_id)))) return;
        const retryable = !error.trial_control && (error.retryable === true || RECOVERABLE_MEDIA_ERRORS.has(error.code));
        const message = error.code === 'original_unavailable' ? '原录音已无法读取，不能重新识别。请重新录音；此前的模拟结果不是真实转写。'
          : error.code === 'media_mock_unavailable' ? '语音或照片识别尚未接通，原件已保存在本机；接通真实服务后可重试。'
          : retryable ? '识别没有完成，原件已保存在本机，可以重试。' : '识别没有完成，原件已保存在本机。';
        const updated = { ...current, ...(error.trial_control ? { trial_control: { ...error.trial_control, state: 'stopped' } } : {}), recognition_status: 'failed', recognition: { error_message: message, error: { code: error.code || 'recognition_failed', retryable }, retryable }, version: current.version + 1, updated_at: now() };
        await ownedPut(mediaKey(media.media_id), updated);
        if (error.trial_control) await ownedPut(TRIAL_VOICE_KEY, { ...error.trial_control, state: 'stopped', media_id: media.media_id, conversation_id: media.conversation_id });
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
      if (['subject_changed', 'stale_health_subjects'].includes(error.message)) return fail(409, error.message);
      if (error.message === 'subject_mismatch') return fail(403, error.message);
      if (['vault_changed_requires_unlock', 'vault_locked'].includes(error.message)) {
        active = false; initialisePromise = null; observedSubjectId = null;
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
        const conversationReports = (await listConversations()).filter(item => item.report).map(item => ({ item, elder: elderTurns(item), transcript: liveConversationTurns(item).filter(turn => !mockSource(turn)) })).filter(({item,elder})=>{const at=Date.parse(`${item.last_local_date||item.local_date}T12:00:00`);return (!start||at>=start)&&(!end||at<=end)&&(!selected||elder.some(turn=>selected.has(turn.record_id)))}).map(({item,transcript}) => ({ conversation_id: item.conversation_id, local_date: item.local_date, last_local_date: item.last_local_date, status: item.status, report: item.report, completeness: item.completeness, transcript: transcript.map(turn => ({ turn_id: turn.turn_id, role: turn.role, text: turn.text, original_text: turn.original_text, created_at: turn.created_at, version: turn.version, versions: turn.versions || [], record_id: turn.record_id || null })) }));
        const pending = items.filter(safety.documentNeedsReview);
        const pendingIds = new Set(pending.map(event => event.record_id));
        for (const event of pending) { let previous = event.supersedes_id; while (previous && !pendingIds.has(previous)) { pendingIds.add(previous); previous = byId.get(previous)?.supersedes_id; } }
        const attachments = media.map(item => {
          const unreviewed = pendingIds.has(item.record_id || item.event_link?.record_id);
          // Handoffs contain attachment status, never a second copy of raw OCR.
          const reasons = [...(unreviewed ? ['document_source_review_required'] : []), ...(item.recognition_status !== 'succeeded' ? ['media_recognition_incomplete'] : []), ...(item.link_status !== 'linked' ? ['media_event_not_linked'] : [])];
          return { media_id: item.media_id, kind: item.kind, record_id: item.record_id || item.event_link?.record_id, save_status: item.save_status, recognition_status: item.recognition_status, link_status: item.link_status, is_mock: mockSource(item.recognition), local_safety: unreviewed ? null : item.local_safety, pending_reason: item.link_pending_reason || item.recognition?.error?.code || null, has_text: Boolean(item.recognition?.text), unresolved: reasons.length > 0, unresolved_reasons: reasons };
        });
        const safeItems = items.filter(event => !safety.documentNeedsReview(event)).map(event => ({ ...event, unresolved: event.state !== 'recorded' || event.local_safety?.danger_detected || event.local_safety?.clinical_review_required }));
        return ok(201, { ok: true, handoff: { handoff_id: id('handoff'), created_at: now(), disclaimer: '用于沟通，不是诊断。', conversation_reports: conversationReports, items: safeItems, pending_documents: pending.map(({record_id, recorded_at}) => ({record_id, recorded_at, reason: 'document_source_review_required'})), media_attachments: attachments, unresolved_count: pending.length + safeItems.filter(event => event.unresolved).length + attachments.filter(item => item.unresolved).length } });
      }
      if (path.startsWith('/api/conversations')) return await conversationRequest(path, options);
      if (path.startsWith('/api/events')) return await eventRequest(path, options);
      if (path.startsWith('/api/media')) return await mediaRequest(path, options);
      return fail(404, 'not_found');
    } catch (error) {
      if (['subject_changed', 'stale_health_subjects'].includes(error.message)) return fail(409, error.message);
      if (error.message === 'subject_mismatch') return fail(403, error.message);
      if (error.message === 'document_changed') return fail(409, 'trial_source_changed');
      if (['vault_changed_requires_unlock', 'vault_locked'].includes(error.message)) {
        active = false; initialisePromise = null; observedSubjectId = null;
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
    try { const restored = await vault.restoreArchive(preview.archive, passphrase); observedSubjectId = null; return restored; }
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
    lock() { vault.lock(); active = false; initialisePromise = null; observedSubjectId = null; },
    originalObjectUrl,
    onlineStatus,
    previewBackup,
    request,
    restoreBackup,
    saveFeedback,
    storageStatus,
    trialVoiceState,
    vault,
  };
})();
