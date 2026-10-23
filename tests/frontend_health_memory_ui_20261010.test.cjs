// Synthetic subjects and health background. Actual app functions run over an
// isolated DOM and strict local API fixtures; this is not browser/model proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
const markup = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const response = (j, status = 200) => ({ r: { ok: status < 400, status }, j });
const registry = active_subject_id => ({ version: 2, active_subject_id,
  subjects: [{ subject_id: 'subject_self', label: '本人', relationship: 'self' },
    { subject_id: 'subject_fictional_family', label: '虚构家属乙', relationship: 'family' }] });
const entry = values => ({ context_id: 'context_fictional_1', subject_id: 'subject_self',
  category: 'conditions', text: '虚构甲：2021年医生曾告知有哮喘', temporal_status: 'historical',
  confirmation_status: 'confirmed', confirmed_by: 'self', occurred_on: '2021-02-03',
  source_kind: 'self_statement', source: 'user_confirmed', remember: true,
  recorded_at: '2026-10-10T00:00:00Z', confirmed_at: '2026-10-10T00:01:00Z',
  updated_at: '2026-10-10T00:01:00Z', ...values });
const memory = (entries = [], version = 4, subject_id = 'subject_self') => ({ health_context: { subject_id, version, entries } });

function harness() {
  const elements = new Map(), calls = [], effects = [], confirmations = [];
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { id, value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
        dataset: {}, style: {}, focus() { effects.push('focus:' + id); }, scrollIntoView() {},
        addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
        setAttribute() {}, removeAttribute() {}, reset() {},
        classList: { add(...items) { items.forEach(item => classes.add(item)); },
          remove(...items) { items.forEach(item => classes.delete(item)); },
          contains(item) { return classes.has(item); },
          toggle(item, enabled) { const next = enabled ?? !classes.has(item); next ? classes.add(item) : classes.delete(item); return next; } } });
    }
    return elements.get(id);
  };
  let apiHandler = (path, options) => {
    assert.equal(options.method || 'GET', 'GET', 'Every mutation needs an explicit fixture');
    if (path === '/api/health-subjects') return response(registry('subject_self'));
    if (path === '/api/health-memory') return response(memory());
    throw new Error('Unexpected fixture API: ' + path);
  };
  const context = vm.createContext({
    $: element, document: { getElementById: element, querySelector() { return null; }, querySelectorAll() { return []; } },
    localMode: true, activeHealthSubjectId: 'subject_self', healthSubjectsVersion: 2,
    healthSubjects: registry('subject_self').subjects, healthMemoryVersion: 4, healthMemoryEntries: [],
    healthMemoryEditingId: null, healthMemoryBusy: false, healthSubjectUiEpoch: 0, healthSubjectsRequestId: 0, healthSubjectsLoadPromise: null, healthSubjectSwitchBusy: false,
    healthSubjectLoaded: true, healthSubjectChanged: false,
    activeConversation: null, currentConversationDetail: null, pendingLegacyReorganizationReview: null, pendingRecordDelete: null,
    events: [], conversations: [], current: null, detailRequestSerial: 0,
    contextDraftSelection: new Set(), healthContextEntries: [], contextPickerRequestId: 0,
    contextPickerLoading: false, contextPickerLoadError: false, contextSelectionSaving: false,
    contextReturnFocus: null, contextInertTargets: [], reportReturnFocus: null, reportInertTargets: [],
    conversationLoading: false, conversationEditingTurnId: null, pendingConversationTurn: null,
    pendingMediaRetry: null, pendingAudioReview: null, pendingAudioReviewCandidates: [], pendingAudioRecoveryRequestId: 0,
    lastSpokenTurnId: null, voiceCaptureIntent: null, handoffSelection: new Set(), knownHandoffEvents: new Set(), visibleHandoffRecordIds: new Set(), handoffPreviewGeneration: 0,
    recordDataGeneration: 0,
    saveBusy: false, voicePermissionPending: false, voiceUploadPending: false, voicePermissionGeneration: 0, mediaRecorder: null,
    mediaItems: [], selectedPhoto: null, pendingRecordingBlob: null, uploadBusy: false, recognitionBusy: new Set(),
    isMockContent(value) { return value?.is_mock === true; }, mockText() { return false; },
    documentNeedsReview() { return false; }, reveal() {},
    toast(message) { effects.push('toast:' + message); },
    confirm(message) { confirmations.push(message); return true; },
    releaseOriginalsIn() { effects.push('releaseOriginals'); },
    closeConversationReport() { effects.push('closeReport'); element('conversationReportPanel').classList.add('hidden'); },
    closeHealthContextPicker() { effects.push('closeContext'); element('healthContextPickerPanel').classList.add('hidden'); },
    renderVoiceConversation() { effects.push('renderVoice'); }, renderConversationReport() { effects.push('renderReport'); },
    renderHome() { effects.push('renderHome'); }, renderList() { effects.push('renderList'); }, renderArchive() { effects.push('renderArchive'); },
    setVoiceComposerEnabled() {}, updateHealthContextButton() {}, setVoiceStatus() {},
    pauseConversation: async () => { effects.push('pauseConversation'); },
    loadMedia: async () => { effects.push('loadMedia'); },
    loadEvents: async () => { effects.push('loadEvents'); },
    refreshVoiceOnlineStatus: async () => {}, refreshStorageStatus: async () => {},
    loadHealthContext: async () => { effects.push('loadLegacyContext'); },
    api: async (path, options = {}) => {
      const call = { path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call); return apiHandler(path, options, call);
    },
  });
  const start = source.indexOf('function healthSubjectLabel(');
  const end = source.indexOf('async function loadHealthContext(', start);
  assert.ok(start >= 0 && end > start, 'Actual health memory section must exist');
  const helpers = [source.match(/^const HEALTH_CONTEXT_CATEGORY_LABELS=.*$/m)?.[0],
    source.match(/^const SOURCE_KIND_LABELS=.*$/m)?.[0],
    source.match(/^function dateText\(.*$/m)?.[0], source.match(/^function escapeHtml\(.*$/m)?.[0]];
  assert.ok(helpers.every(Boolean), 'Actual shared rendering helpers must exist');
  vm.runInContext(helpers.join('\n') + '\n' + source.slice(source.indexOf('function clearRecordPanels('), source.indexOf('function showView('))
    + '\n' + source.slice(start, end), context);
  const run = expression => vm.runInContext(expression, context);
  const setState = state => Object.entries(state).forEach(([key, value]) => run(key + ' = ' + JSON.stringify(value)));
  run('resetHealthMemoryForm()');
  return { element, calls, effects, confirmations, run, setState,
    loadReportUi() {
      const reportStart = source.indexOf('function renderConversationReport(){');
      const reportEnd = source.indexOf('function syncConversation(', reportStart);
      const detailStart = source.indexOf('function conversationDetailHtml(');
      const detailEnd = source.indexOf('async function showConversationDetail(', detailStart);
      const handoffStart = source.indexOf('async function handoff(){');
      const handoffEnd = source.indexOf('function updateTimer(){', handoffStart);
      assert.ok(reportStart >= 0 && reportEnd > reportStart && detailStart >= 0 && detailEnd > detailStart && handoffStart >= 0 && handoffEnd > handoffStart,
        'Actual report, detail and handoff DOM renderers must exist');
      vm.runInContext(`liveArchiveTurns = c => (c?.turns || []).filter(t => !t.superseded);
        elderArchiveTurns = c => liveArchiveTurns(c).filter(t => t.role === 'elder');
        conversationDateLabel = () => '10月14日'; conversationStatusLabel = () => '已暂停';
        conversationSummary = () => '妈妈的合成记录'; conversationTranscriptTurnHtml = t => '<p>' + escapeHtml(t.text || '') + '</p>';
        stateLabel = () => '已保存，待整理'; conversationSafety = () => null; safetyHtml = () => '';
        MEDIA_KIND_LABELS = { audio: '录音原件', image: '照片原件' };
        SAVE_STATUS_LABELS = { saved: '原件已保存', failed: '原件保存失败' };
        RECOGNITION_LABELS = { succeeded: '文字已识别', failed: '识别失败' };
        LINK_LABELS = { linked: '已关联记录', not_linked: '尚未关联记录' };
        safetyBanner = () => {}; bindConversationSourceActions = () => {};`, context);
      const legacyStart=source.indexOf('function legacyReorganizationOutputCandidate('),legacyEnd=source.indexOf('function conversationSafety(',legacyStart);
      assert.ok(legacyStart>=0&&legacyEnd>legacyStart,'Legacy-output review helpers must exist');
      vm.runInContext(source.slice(legacyStart,legacyEnd)+'\n'+source.slice(reportStart, reportEnd) + '\n' + source.slice(detailStart, detailEnd)
        + '\n' + source.slice(handoffStart, handoffEnd), context);
      this.loadHandoffSelectionUi();
    },
    loadHandoffSelectionUi() {
      const archiveStart=source.indexOf('function liveArchiveTurns('),archiveEnd=source.indexOf('function conversationDateLabel(',archiveStart);
      const linkedStart=source.indexOf('function conversationLinkedRecordIds('),linkedEnd=source.indexOf('function recentRecordItems(',linkedStart);
      const listStart=source.indexOf('function latestFirst('),listEnd=source.indexOf('function renderFilterStatus(',listStart);
      const filtersStart=source.indexOf('function applyRecordFilters('),filtersEnd=source.indexOf('async function loadEvents(',filtersStart);
      assert.ok(archiveStart>=0&&archiveEnd>archiveStart&&linkedStart>=0&&linkedEnd>linkedStart&&listStart>=0&&listEnd>listStart&&filtersStart>=0&&filtersEnd>filtersStart,
        'Actual filtered record and selection functions must exist');
      vm.runInContext(source.slice(archiveStart,archiveEnd)+'\n'+source.slice(linkedStart,linkedEnd)+'\n'+source.slice(listStart,listEnd)
        +'\n'+source.slice(filtersStart,filtersEnd)+'\nrenderList = () => { visibleHandoffRecordIds = filteredHandoffRecordIds(); }; renderHome = () => {}; renderArchive = () => {};',context);
    },
    loadEventsUi() {
      const start=source.indexOf('function showEventsLoadFailure('),end=source.indexOf('function setVoiceStatus(',start);
      assert.ok(start>=0&&end>start,'Actual event and conversation list read functions must exist');
      vm.runInContext(source.slice(start,end)+'\nsetModeLabel = () => {}; ensureHealthSubjectReady = async () => true;',context);
    },
    setApi(handler) { apiHandler = handler; } };
}

test('memory controls disclose explicit reuse, confirmation, dates and local family identity', () => {
  for (const id of ['healthSubjectSelect', 'newHealthSubjectLabel', 'addHealthSubjectBtn', 'healthSubjectStatus',
    'voiceSubjectLabel', 'archiveSubjectLabel', 'photoSubjectLabel', 'healthMemoryList', 'healthMemoryStatus', 'healthMemoryForm', 'healthMemoryCategory',
    'healthMemoryText', 'healthMemoryTemporalStatus', 'healthMemorySourceKind', 'healthMemoryOccurredOn',
    'healthMemoryConfirmedBy', 'healthMemoryConfirmed', 'healthMemoryRemember', 'saveHealthMemoryBtn', 'cancelHealthMemoryEditBtn']) {
    assert.match(markup, new RegExp('id="' + id + '"'));
  }
  const time = markup.match(/<select id="healthMemoryTemporalStatus">([\s\S]*?)<\/select>/)?.[1];
  assert.match(time, /^<option value="uncertain">/);
  for (const id of ['healthMemoryConfirmed', 'healthMemoryRemember']) {
    assert.doesNotMatch(markup.match(new RegExp('<input[^>]+id="' + id + '"[^>]*>'))?.[0] || '', /\bchecked\b/);
  }
  assert.match(markup, /以后对话记住.*已核对.*时间状态明确/);
  assert.match(markup, /核对不代表 AI 做出诊断/);
  assert.match(markup, /发生.*日期.*可留空/);
  assert.match(markup, /本机加密/);
  assert.match(markup, /id="voiceSubjectLabel"[^>]*>当前记录：尚未确认</);
  assert.match(markup, /id="archiveSubjectLabel"[^>]*>当前资料所属人：尚未确认</);
  assert.match(markup, /id="photoSubjectLabel"[^>]*>当前资料所属人：尚未确认</);
  assert.doesNotMatch(markup, /class="archive-avatar"[^>]*>我</);
  assert.doesNotMatch(markup, /这台设备里的健康资料/);
});

test('archive and photo owner labels follow the active local subject and safely render unresolved states and names', () => {
  const h = harness();
  const familyA = 'subject_fictional_family', familyB = 'subject_fictional_family_two';
  const subjects = [...registry('subject_self').subjects,
    { subject_id: familyB, label: '虚构家属丙', relationship: 'family' }];
  h.setState({ healthSubjects: subjects, healthSubjectLoaded: true, healthSubjectChanged: false,
    activeHealthSubjectId: 'subject_self', activeConversation: { subject_id: familyA } });
  h.run('updateHealthSubjectLabels()');
  assert.equal(h.element('archiveSubjectLabel').textContent, '当前资料所属人：本人');
  assert.equal(h.element('photoSubjectLabel').textContent, '当前资料所属人：本人');

  for (const [active, staleConversation, expected] of [
    [familyA, 'subject_self', '虚构家属乙'],
    [familyB, familyA, '虚构家属丙'],
  ]) {
    h.setState({ activeHealthSubjectId: active, activeConversation: { subject_id: staleConversation } });
    h.run('updateHealthSubjectLabels()');
    assert.equal(h.element('archiveSubjectLabel').textContent, `当前资料所属人：${expected}`);
    assert.equal(h.element('photoSubjectLabel').textContent, `当前资料所属人：${expected}`);
  }

  h.setState({ activeHealthSubjectId: 'subject_self', healthSubjectLoaded: false, healthSubjectChanged: false });
  h.run('updateHealthSubjectLabels()');
  assert.equal(h.element('archiveSubjectLabel').textContent, '当前资料所属人：尚未确认');
  assert.equal(h.element('photoSubjectLabel').textContent, '当前资料所属人：尚未确认');

  h.setState({ activeHealthSubjectId: familyB, healthSubjectLoaded: true, healthSubjectChanged: true });
  h.run('updateHealthSubjectLabels()');
  assert.equal(h.element('archiveSubjectLabel').textContent, '当前资料所属人：所属人已变化，请重新选择');
  assert.equal(h.element('photoSubjectLabel').textContent, '当前资料所属人：所属人已变化，请重新选择');

  const unsafe = '<img src=x onerror=alert(1)>';
  h.setState({ healthSubjectChanged: false, healthSubjects: [...subjects,
    { subject_id: 'subject_fictional_html', label: unsafe, relationship: 'family' }],
    activeHealthSubjectId: 'subject_fictional_html' });
  h.run('updateHealthSubjectLabels()');
  assert.equal(h.element('archiveSubjectLabel').textContent, `当前资料所属人：${unsafe}`);
  assert.equal(h.element('photoSubjectLabel').textContent, `当前资料所属人：${unsafe}`);
  assert.equal(h.element('archiveSubjectLabel').innerHTML, '');
  assert.equal(h.element('photoSubjectLabel').innerHTML, '');
});

test('conversation and handoff report DOM resolve each owner by its own ID after a member switch', async () => {
  const h = harness(), momId = 'subject_fictional_family';
  const report = { title: '就诊沟通记录', status_label: '自动整理 · 本人未核对', version: 2,
    source_turn_ids: ['turn_mom'], source_versions: [{ turn_id: 'turn_mom', version: 1, quote: '我以前膝盖疼过吗？' }],
    transcript: [{ turn_id: 'turn_mom', role: 'elder', source_kind: 'elder', text: '我以前膝盖疼过吗？' }],
    sections: [{ key: 'background_actions', title: '相关背景与已做处理', lines: [{ kind: 'context', text: '去年冬天膝盖疼，休息后缓解。', tags: ['历史背景'], source_label: '家属确认 · 家属转述 · 发生日期 2025-12-10' }] }] };
  h.setState({ healthSubjects: [...registry('subject_self').subjects.filter(subject => subject.subject_id !== momId), { subject_id: momId, label: '妈妈', relationship: 'family' }],
    healthSubjectLoaded: true, healthSubjectChanged: false, activeHealthSubjectId: momId,
    activeConversation: { conversation_id: 'conversation_mom', subject_id: momId, report },
    conversations:[{conversation_id:'conversation_mom',subject_id:momId,status:'paused',local_date:'2026-10-14',turns:[{turn_id:'turn_mom',record_id:'record_mom',role:'elder',text:'我以前膝盖疼过吗？'}]},
      {conversation_id:'conversation_self',subject_id:'subject_self',status:'paused',local_date:'2026-10-14',turns:[{turn_id:'turn_self',record_id:'record_self',role:'elder',text:'本人合成问题'}]}],
    handoffSelection:['record_mom','record_self'] });
  h.loadReportUi();
  h.run('renderList()');
  h.run('renderConversationReport()');
  assert.match(h.element('conversationReportBody').innerHTML, /就诊对象：<\/strong>妈妈/);
  assert.match(h.element('conversationReportBody').innerHTML, /家属确认 · 家属转述 · 发生日期 2025-12-10/);
  assert.equal(h.element('conversationReportStatus').textContent, '自动整理 · 本人未核对');
  assert.match(h.element('conversationReportBody').innerHTML, /老人/);

  let resolveHandoff;
  h.setApi(path => {
    assert.equal(path, '/api/handoffs');
    return new Promise(resolve => { resolveHandoff = resolve; });
  });
  const rendering = h.run('handoff()');
  h.setState({ activeHealthSubjectId: 'subject_self' });
  resolveHandoff(response({ handoff: { created_at: '2026-10-14T00:00:00Z', unresolved_count: 1,
    conversation_reports: [
      { conversation_id: 'conversation_mom', subject_id: momId, report, transcript: report.transcript },
      { conversation_id: 'conversation_self', subject_id: 'subject_self', report, transcript: report.transcript },
    ], items: [], pending_documents: [], pending_audio: [], media_attachments: [] } }));
  await rendering;
  const handoffHtml = h.element('handoff').innerHTML;
  assert.equal((handoffHtml.match(/就诊对象：<\/strong>妈妈/g) || []).length, 1);
  assert.equal((handoffHtml.match(/就诊对象：<\/strong>本人/g) || []).length, 1);
  assert.match(handoffHtml, /家属确认 · 家属转述 · 发生日期 2025-12-10/);
  assert.equal((handoffHtml.match(/自动整理 · 本人未核对/g) || []).length, 2);

  h.setState({ healthSubjects: [...registry('subject_self').subjects.filter(subject => subject.subject_id !== momId),
    { subject_id: momId, label: '<img src=x onerror=alert(1)>', relationship: 'family' }] });
  h.setApi(() => response({ handoff: { created_at: '2026-10-14T00:00:00Z', conversation_reports: [
    { conversation_id: 'conversation_mom', subject_id: momId, report, transcript: report.transcript },
  ], items: [], pending_documents: [], pending_audio: [], media_attachments: [] } }));
  await h.run('handoff()');
  assert.match(h.element('handoff').innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h.element('handoff').innerHTML, /<img src=x onerror/);
  assert.equal(h.run('reportSubjectLabel("subject_missing")'), '待确认');
});

test('standalone and attachment-only handoffs show the top-level owner; archived detail uses conversation ID', async () => {
  const h = harness(), momId = 'subject_fictional_family';
  h.setState({ healthSubjects: [...registry('subject_self').subjects.filter(subject => subject.subject_id !== momId),
    { subject_id: momId, label: '妈妈', relationship: 'family' }], healthSubjectLoaded: true,
    healthSubjectChanged: false, activeHealthSubjectId: 'subject_self', activeConversation: {
      subject_id: momId, status: 'paused', turns: [{ role: 'elder', text: '合成原话' }], report: null,
    },events:[{record_id:'record_family_standalone',state:'inbox',recorded_at:'2026-10-14T00:00:00Z',raw_text:'单独保存的合成记录'}],
    handoffSelection:['record_family_standalone'] });
  h.loadReportUi();
  h.run('renderList()');
  h.run('renderConversationDetail(activeConversation)');
  assert.match(h.element('detail').innerHTML, /就诊对象：<\/strong>妈妈/);
  assert.match(h.element('detail').innerHTML, /妈妈的合成记录/);

  h.setApi(path => {
    assert.equal(path, '/api/handoffs');
    return response({ handoff: { subject_id: momId, created_at: '2026-10-14T00:00:00Z', unresolved_count: 0,
      conversation_reports: [], items: [{ recorded_at: '2026-10-14T00:00:00Z', source_kind: 'elder', state: 'inbox', raw_text: '单独保存的合成记录' }],
      pending_documents: [], pending_audio: [], media_attachments: [] } });
  });
  await h.run('handoff()');
  assert.match(h.element('handoff').innerHTML, /就诊对象：<\/strong>妈妈/);
  assert.match(h.element('handoff').innerHTML, /单独保存的合成记录/);

  h.setApi(path => {
    assert.equal(path, '/api/handoffs');
    return response({ handoff: { subject_id: momId, created_at: '2026-10-14T00:00:00Z', unresolved_count: 1,
      conversation_reports: [], items: [], pending_documents: [], pending_audio: [],
      media_attachments: [{ kind: 'image', save_status: 'saved', recognition_status: 'failed', link_status: 'not_linked', unresolved: true }] } });
  });
  await h.run('handoff()');
  assert.match(h.element('handoff').innerHTML, /就诊对象：<\/strong>妈妈/);
  assert.match(h.element('handoff').innerHTML, /媒体原件与待处理状态/);
});

test('handoff only submits checked source IDs from visible filtered records and preserves complete conversations', async () => {
  const h=harness();h.loadReportUi();
  h.setState({conversations:[
    {conversation_id:'conversation_visible',status:'paused',local_date:'2026-10-19',last_local_date:'2026-10-19',turns:[
      {turn_id:'turn_visible_1',record_id:'record_visible_1',role:'elder',text:'咳嗽三天，虚构记录'},
      {turn_id:'turn_visible_2',record_id:'record_visible_2',role:'elder',text:'今天仍然不舒服'},
      {turn_id:'turn_superseded',record_id:'record_superseded',role:'elder',text:'咳嗽三天旧版本',superseded:true},
      {turn_id:'turn_mock',record_id:'record_mock',role:'elder',text:'咳嗽三天模拟文字',is_mock:true},
      {turn_id:'turn_assistant',record_id:'record_assistant',role:'assistant',text:'请描述一下'}]},
    {conversation_id:'conversation_hidden',status:'paused',local_date:'2026-10-19',last_local_date:'2026-10-19',turns:[
      {turn_id:'turn_hidden',record_id:'record_hidden',role:'elder',text:'头痛，虚构记录'}]},
    {conversation_id:'conversation_outside_date',status:'paused',local_date:'2026-10-21',last_local_date:'2026-10-21',turns:[
      {turn_id:'turn_outside',record_id:'record_outside',role:'elder',text:'咳嗽三天，虚构记录'}]},
  ],events:[
    {record_id:'record_standalone',state:'inbox',recorded_at:'2026-10-19T08:00:00Z',raw_text:'咳嗽三天，单独虚构记录'},
    {record_id:'record_mock_standalone',state:'inbox',recorded_at:'2026-10-19T08:00:00Z',raw_text:'咳嗽三天模拟文字',is_mock:true},
    {record_id:'record_visible_1',state:'inbox',recorded_at:'2026-10-19T08:00:00Z',raw_text:'linked event is not standalone'},
  ]});
  h.run('handoffSelection = new Set(["record_visible_1","record_visible_2","record_hidden","record_outside","record_standalone","record_mock_standalone"])');
  h.element('filterKeyword').value='咳嗽三天';h.element('filterStart').value='2026-10-18';h.element('filterEnd').value='2026-10-20';
  h.run('renderList()');
  const visible=h.run('[...filteredHandoffRecordIds()].sort()');
  assert.deepEqual(plain(visible),['record_standalone','record_visible_1','record_visible_2']);
  h.element('handoff').innerHTML='previous preview';h.element('handoff').classList.remove('hidden');
  h.setApi((path,options)=>{assert.equal(path,'/api/handoffs');assert.equal(options.method,'POST');return response({error:'offline'},503)});
  await h.run('handoff()');
  const request=h.calls.find(call=>call.path==='/api/handoffs');
  assert.deepEqual(request.body.record_ids,['record_visible_1','record_visible_2','record_standalone']);

  h.element('handoff').innerHTML='previous preview';h.element('handoff').classList.remove('hidden');
  h.run('setHandoffSelection(["record_visible_2"], false)');
  assert.deepEqual(plain([...h.run('handoffSelection')]),['record_visible_1','record_hidden','record_outside','record_standalone','record_mock_standalone']);
  assert.equal(h.element('handoff').classList.contains('hidden'),true);
  assert.equal(h.element('handoff').innerHTML,'');
  await h.run('handoff()');
  assert.deepEqual(h.calls.findLast(call=>call.path==='/api/handoffs').body.record_ids,['record_visible_1','record_standalone']);

  h.element('handoff').innerHTML='previous preview';h.element('handoff').classList.remove('hidden');
  h.run('applyRecordFilters({preventDefault(){}})');
  assert.equal(h.element('handoff').classList.contains('hidden'),true);
  assert.equal(h.element('handoff').innerHTML,'');
  h.element('filterKeyword').value='无匹配';
  h.run('applyRecordFilters({preventDefault(){}})');
  const before=h.calls.filter(call=>call.path==='/api/handoffs').length;
  await h.run('handoff()');
  assert.equal(h.calls.filter(call=>call.path==='/api/handoffs').length,before,'empty search does not request a handoff');
  assert.match(h.effects.filter(effect=>effect.startsWith('toast:')).at(-1),/没有已勾选的有效记录/);

  const selectionBefore=plain(Array.from(h.run('handoffSelection'))).sort();
  h.element('recordFilters').reset=()=>{for(const id of ['filterKeyword','filterKind','filterState','filterStart','filterEnd'])h.element(id).value=''};
  h.run('clearRecordFilters()');
  assert.deepEqual(plain(Array.from(h.run('handoffSelection'))).sort(),selectionBefore,'clearing filters keeps user selection');
});

test('actual loadEvents requires valid event and conversation reads, clears stale views on failure, and succeeds with both lists', async () => {
  for(const failure of ['conversation_http','conversation_throw','invalid_shape']){
    const h=harness();h.loadReportUi();h.loadEventsUi();
    h.setState({events:[{record_id:'stale_event'}],conversations:[{conversation_id:'stale_conversation'}],demoMode:false});
    h.run('handoffSelection = new Set(["stale_event"]); visibleHandoffRecordIds = new Set(["stale_event"])');
    h.element('handoff').innerHTML='old preview';h.element('handoff').classList.remove('hidden');
    h.setApi(async path=>{
      if(path==='/api/events')return response({events:[{record_id:'fresh_event'}]});
      if(path==='/api/conversations'){
        if(failure==='conversation_throw')throw new Error('temporarily unavailable');
        if(failure==='conversation_http')return response({error:'temporarily_unavailable'},503);
        return response({conversations:'invalid'});
      }
      throw new Error('unexpected request '+path);
    });
    assert.equal(await h.run('loadEvents()'),false,failure);
    assert.deepEqual(plain(h.run('events')),[],failure);
    assert.deepEqual(plain(h.run('conversations')),[],failure);
    assert.deepEqual(plain(Array.from(h.run('visibleHandoffRecordIds'))),[],failure);
    assert.equal(h.element('handoff').classList.contains('hidden'),true,failure);
    assert.equal(h.element('handoff').innerHTML,'',failure);
    for(const id of ['homeRecent','eventsList','archiveEvents'])assert.match(h.element(id).innerHTML,/记录暂时无法读取/,`${failure}/${id}`);
    await h.run('handoff()');
    assert.equal(h.calls.filter(call=>call.path==='/api/handoffs').length,0,`${failure}: stale handoff prevented`);
    assert.match(h.effects.filter(effect=>effect.startsWith('toast:')).at(-1),/没有已勾选的有效记录/,failure);
  }
  const h=harness();h.loadHandoffSelectionUi();h.loadEventsUi();
  h.run('renderList = () => { $("eventsList").textContent="fresh records"; }; renderHome = () => { $("homeRecent").textContent="fresh home"; }; renderArchive = () => { $("archiveEvents").textContent="fresh archive"; }');
  h.setApi(path=>path==='/api/events'?response({events:[{record_id:'fresh_event'}]}):response({conversations:[{conversation_id:'fresh_conversation'}]}));
  const loaded=await h.run('loadEvents()');assert.equal(loaded,true,JSON.stringify({calls:h.calls,events:plain(h.run('events')),conversations:plain(h.run('conversations')),toast:h.effects}));
  assert.equal(h.run('events[0].record_id'),'fresh_event');
  assert.equal(h.run('conversations[0].conversation_id'),'fresh_conversation');
  assert.equal(h.element('eventsList').textContent,'fresh records');
  assert.equal(h.element('homeRecent').textContent,'fresh home');
  assert.equal(h.element('archiveEvents').textContent,'fresh archive');
});

test('a delayed handoff response cannot restore a preview after selection or filters invalidate it', async () => {
  for(const change of ['selection','filter']){
    const h=harness();h.loadReportUi();
    h.setState({events:[{record_id:'record_visible',state:'inbox',recorded_at:'2026-10-19T08:00:00Z',raw_text:'合成交接原话'}]});
    h.run('handoffSelection = new Set(["record_visible"])');h.run('renderList()');
    let resolveRequest;h.setApi(()=>new Promise(resolve=>{resolveRequest=resolve}));
    const pending=h.run('handoff()');assert.equal(typeof resolveRequest,'function');
    if(change==='selection')h.run('setHandoffSelection(["record_visible"],false)');
    else{h.element('filterKeyword').value='没有匹配';h.run('applyRecordFilters({preventDefault(){}})')}
    assert.equal(h.element('handoff').classList.contains('hidden'),true,change);
    assert.equal(h.element('handoff').innerHTML,'',change);
    resolveRequest(response({handoff:{subject_id:'subject_self',created_at:'2026-10-19T09:00:00Z',unresolved_count:0,
      conversation_reports:[],items:[],pending_documents:[],pending_audio:[],media_attachments:[]}}));
    assert.equal(await pending,false,change);
    assert.equal(h.element('handoff').classList.contains('hidden'),true,change);
    assert.equal(h.element('handoff').innerHTML,'',change);
  }
});

test('new form retains uncertain/unconfirmed defaults and only explicit confirmed clear-time entries can be remembered', () => {
  const h = harness(), initial = plain(h.run('healthMemoryFormEntry()'));
  assert.equal(initial.temporal_status, 'uncertain');
  assert.equal(initial.confirmation_status, 'unconfirmed');
  assert.equal(initial.remember, false);
  assert.equal(initial.occurred_on, null);
  assert.equal(h.element('healthMemoryConfirmed').checked, false);
  assert.equal(h.element('healthMemoryRemember').disabled, true);
  h.element('healthMemoryConfirmed').checked = true;
  h.element('healthMemoryTemporalStatus').value = 'historical';
  h.run('updateHealthMemoryRememberEligibility()');
  assert.equal(h.element('healthMemoryRemember').disabled, false);
  h.element('healthMemoryRemember').checked = true;
  assert.equal(h.run('healthMemoryFormEntry().remember'), true);
  h.element('healthMemoryTemporalStatus').value = 'uncertain';
  h.run('updateHealthMemoryRememberEligibility()');
  assert.equal(h.element('healthMemoryRemember').checked, false);
  assert.equal(h.element('healthMemoryRemember').disabled, true);
  h.element('healthMemoryTemporalStatus').value = 'current';
  h.element('healthMemoryConfirmed').checked = false;
  h.element('healthMemoryRemember').checked = true;
  assert.equal(h.run('healthMemoryFormEntry().remember'), false, 'A programmatic checkbox cannot authorize reuse');
});

test('uncertain saved input sends current collection version and never silently confirms or remembers', async () => {
  const h = harness(); h.element('healthMemoryText').value = '虚构甲：不确定是否有过药物过敏';
  h.element('healthMemoryRemember').checked = true;
  h.setApi((path, options, call) => {
    if (path === '/api/health-subjects') return response(registry('subject_self'));
    assert.equal(path, '/api/health-memory');
    if (call.method === 'POST') {
      assert.equal(call.body.expected_version, 4);
      assert.equal(call.body.entry.confirmation_status, 'unconfirmed');
      assert.equal(call.body.entry.temporal_status, 'uncertain');
      assert.equal(call.body.entry.remember, false);
      assert.equal(call.body.entry.occurred_on, null);
      return response(memory([entry({ ...call.body.entry, remember: false })], 5), 201);
    }
    return response(memory([entry({ text: '虚构甲：不确定是否有过药物过敏',
      temporal_status: 'uncertain', confirmation_status: 'unconfirmed', remember: false })], 5));
  });
  await h.run('saveHealthMemory()');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.run('healthMemoryVersion'), 5);
  assert.equal(h.element('healthMemoryText').value, '');
  assert.equal(h.element('healthMemoryConfirmed').checked, false);
});

test('successful health-memory writes are not reported as failed when readback returns false or throws', async () => {
  for(const operation of ['save','remember','delete'])for(const readMode of ['false','throw']){
    const h=harness(),original=entry();
    h.setState({healthMemoryEntries:[original],healthMemoryVersion:4});
    if(operation==='save')h.element('healthMemoryText').value='虚构甲：补充的一项健康背景';
    h.setApi((path,options,call)=>{
      if(path==='/api/health-subjects')return response(registry('subject_self'));
      if(path==='/api/health-memory'&&call.method==='GET'){
        if(readMode==='throw')throw new Error('read unavailable');
        return response({error:'temporarily_unavailable'},503);
      }
      if(path==='/api/health-memory')return response(memory([entry(call.body.entry)],5),201);
      assert.equal(path,'/api/health-memory/context_fictional_1');
      return response(memory([],5));
    });
    if(operation==='delete')h.run('editHealthMemoryEntry("context_fictional_1")');
    const result=operation==='save'?await h.run('saveHealthMemory()'):
      await h.run('mutateHealthMemoryEntry("context_fictional_1", '+JSON.stringify(operation)+')');
    assert.equal(result,true,`${operation}/${readMode}: write succeeded`);
    assert.equal(h.calls.filter(call=>['POST','PATCH','DELETE'].includes(call.method)).length,1,`${operation}/${readMode}: no write retry`);
    assert.equal(h.run('healthMemoryEntries.length'),0,`${operation}/${readMode}: stale entries cleared`);
    assert.equal(h.run('healthMemoryVersion'),0,`${operation}/${readMode}: stale version cleared`);
    assert.match(h.element('healthMemoryList').innerHTML,/暂时无法读取/,`${operation}/${readMode}`);
    assert.match(h.element('healthMemoryStatus').textContent,/已保存.*重新打开设置读取/,`${operation}/${readMode}`);
    assert.doesNotMatch(h.element('healthMemoryStatus').textContent,/保存没有完成|操作没有完成|可以重试/,`${operation}/${readMode}`);
    assert.ok(h.effects.includes('closeReport'),`${operation}/${readMode}: conversation summary invalidated`);
  }
});

test('entry correction preserves identity and sends current CAS version with source, temporal state and explicit confirmation', async () => {
  const h = harness(), original = entry(); h.setState({ healthMemoryEntries: [original], healthMemoryVersion: 7 });
  h.run('editHealthMemoryEntry("context_fictional_1")');
  assert.equal(h.run('healthMemoryEditingId'), original.context_id);
  assert.equal(h.element('healthMemoryText').value, original.text);
  assert.equal(h.element('healthMemoryOccurredOn').value, '2021-02-03');
  assert.equal(h.element('healthMemoryConfirmed').checked, false, 'Correction requires a fresh confirmation');
  assert.equal(h.element('healthMemoryRemember').checked, false);
  h.element('healthMemoryText').value = '虚构甲：更正为2023年医生曾告知有哮喘';
  h.element('healthMemoryOccurredOn').value = '2023-02-03';
  h.element('healthMemoryConfirmed').checked = true;
  h.run('updateHealthMemoryRememberEligibility()');
  h.element('healthMemoryRemember').checked = true;
  h.setApi((path, options, call) => {
    if (path === '/api/health-subjects') return response(registry('subject_self'));
    if (call.method === 'PATCH') {
      assert.equal(path, '/api/health-memory/' + original.context_id);
      assert.equal(call.body.expected_version, 7);
      assert.equal(call.body.entry.text, h.element('healthMemoryText').value);
      assert.equal(call.body.entry.occurred_on, '2023-02-03');
      assert.equal(call.body.entry.source_kind, 'self_statement');
      assert.equal(call.body.entry.temporal_status, 'historical');
      assert.equal(call.body.entry.confirmation_status, 'confirmed');
      assert.equal(call.body.entry.confirmed_by, 'self');
      return response(memory([entry(call.body.entry)], 8));
    }
    assert.equal(path, '/api/health-memory'); return response(memory([entry()], 8));
  });
  await h.run('saveHealthMemory()');
  assert.equal(h.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(h.run('healthMemoryVersion'), 8);
  assert.equal(h.run('healthMemoryEditingId'), null);
});

test('a stale correction reloads current entries while retaining the unsaved edit and naming the conflict', async () => {
  const h = harness(); h.setState({ healthMemoryEntries: [entry()], healthMemoryVersion: 7 });
  h.run('editHealthMemoryEntry("context_fictional_1")');
  const draft = '虚构甲：本页尚未保存的纠正'; h.element('healthMemoryText').value = draft;
  h.setApi((path, options, call) => {
    if (call.method === 'PATCH') return response({ error: 'stale_health_memory' }, 409);
    if (path === '/api/health-subjects') return response(registry('subject_self'));
    assert.equal(path, '/api/health-memory');
    return response(memory([entry({ text: '虚构甲：另一页先保存的版本' })], 8));
  });
  await h.run('saveHealthMemory()');
  assert.equal(h.element('healthMemoryText').value, draft);
  assert.equal(h.run('healthMemoryEditingId'), 'context_fictional_1');
  assert.equal(h.run('healthMemoryVersion'), 8);
  assert.match(h.element('healthMemoryList').innerHTML, /另一页先保存的版本/);
  assert.match(h.element('healthMemoryStatus').textContent, /其他|另.*页|更新|版本/);
  assert.match(h.element('healthMemoryStatus').textContent, /保留|仍/);
  assert.equal(h.element('saveHealthMemoryBtn').disabled, false);
});

test('rendered entries show separate time, source, owner and confirmation metadata and escape supplied text', () => {
  const h = harness();
  h.setState({ healthMemoryEntries: [entry({ category: 'medications', text: '<img src=x onerror="synthetic()">',
    confirmed_by: 'family', source_kind: 'family_report' }), entry({ context_id: 'context_fictional_uncertain',
    text: '虚构甲：是否过敏尚待核实', category: 'allergies', temporal_status: 'uncertain',
    confirmation_status: 'unconfirmed', confirmed_at: null, remember: false })] });
  h.run('renderHealthMemory()');
  const html = h.element('healthMemoryList').innerHTML;
  assert.match(html, /药物使用记录/);
  assert.match(html, /过去的情况/);
  assert.doesNotMatch(html, /正在使用的药物/);
  assert.match(html, /所属人.*本人/);
  assert.match(html, /原文来源.*家属转述/);
  assert.match(html, /记录时间/);
  assert.match(html, /更新时间/);
  assert.match(html, /情况日期.*2021-02-03/);
  assert.match(html, /核对人 \/ 时间.*家属/);
  assert.match(html, /不确定.*待核实/);
  assert.match(html, /尚未核对/);
  assert.match(html, /data-health-memory-remember="context_fictional_uncertain" disabled/);
  assert.match(html, /&lt;img src=x onerror=&quot;synthetic\(\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('stop remembering, revoke confirmation and delete each use current CAS version and update future-use disclosure', async () => {
  for (const action of ['remember', 'revoke', 'delete']) {
    const h = harness(), original = entry(); h.setState({ healthMemoryEntries: [original], healthMemoryVersion: 9 });
    if (action === 'delete') h.run('editHealthMemoryEntry("context_fictional_1")');
    const next = action === 'delete' ? [] : [entry({ remember: false,
      confirmation_status: action === 'revoke' ? 'unconfirmed' : 'confirmed' })];
    h.setApi((path, options, call) => {
      if (path === '/api/health-subjects') return response(registry('subject_self'));
      if (call.method === 'GET') { assert.equal(path, '/api/health-memory'); return response(memory(next, 10)); }
      assert.equal(path, '/api/health-memory/' + original.context_id);
      assert.equal(call.method, action === 'delete' ? 'DELETE' : 'PATCH');
      assert.equal(call.body.expected_version, 9);
      assert.equal(call.body.subject_id, 'subject_self');
      assert.equal(call.body.expected_subject_version, 2);
      if (action === 'delete') assert.deepEqual(call.body, { expected_version: 9, subject_id: 'subject_self', expected_subject_version: 2 });
      else {
        assert.equal(call.body.entry.remember, false);
        assert.equal(call.body.entry.confirmation_status, action === 'revoke' ? 'unconfirmed' : 'confirmed');
        assert.equal(call.body.entry.text, original.text);
        assert.equal(call.body.entry.temporal_status, 'historical');
        assert.equal(call.body.entry.occurred_on, '2021-02-03');
      }
      return response(memory(next, 10));
    });
    assert.equal(await h.run('mutateHealthMemoryEntry("context_fictional_1", ' + JSON.stringify(action) + ')'), true, action);
    assert.equal(h.run('healthMemoryVersion'), 10, action);
    assert.equal(h.run('healthMemoryEntries.length'), next.length, action);
    assert.equal(h.element('saveHealthMemoryBtn').disabled, false, action);
    assert.ok(h.effects.includes('closeReport'), 'Cached report clears after ' + action);
    assert.ok(h.effects.includes('loadEvents'), 'Record views refresh after ' + action);
    if (action === 'delete') {
      assert.equal(h.confirmations.length, 1);
      assert.equal(h.run('healthMemoryEditingId'), null);
      assert.equal(h.element('healthMemoryText').value, '');
      assert.match(h.element('healthMemoryStatus').textContent, /已删除.*不再使用/);
    } else if (action === 'revoke') assert.match(h.element('healthMemoryStatus').textContent, /取消确认和记忆.*不会发送/);
    else assert.match(h.element('healthMemoryStatus').textContent, /停止自动记住/);
  }
});

test('switching subjects pauses old conversation and removes old record, media, report and handoff panes before reading the new memory', async () => {
  const h = harness(), familyId = 'subject_fictional_family';
  h.setState({ activeConversation: { conversation_id: 'conversation_fictional_self', subject_id: 'subject_self' },
    events: [{ record_id: 'record_fictional_self' }], conversations: [{ conversation_id: 'conversation_fictional_self' }],
    current: { record_id: 'record_fictional_self' }, healthContextEntries: [entry()], healthMemoryEntries: [entry()],
    mediaItems: [{ media_id: 'media_fictional_self' }], pendingRecordingBlob: { synthetic: true },
    conversationEditingTurnId: 'turn_fictional_self', pendingConversationTurn: { synthetic: true },
    pendingMediaRetry: { synthetic: true }, lastSpokenTurnId: 'turn_fictional_self' });
  h.run('contextDraftSelection.add("context_fictional_1");handoffSelection.add("record_fictional_self");knownHandoffEvents.add("record_fictional_self")');
  const oldPanes = ['detail', 'handoff', 'dangerBanner', 'archivePhotos', 'photoPreview', 'homeRecent', 'eventsList', 'archiveEvents'];
  oldPanes.forEach(id => { h.element(id).innerHTML = 'synthetic previous person'; });
  h.setApi((path, options, call) => {
    if (path === '/api/health-subjects/active') {
      assert.deepEqual(call.body, { subject_id: familyId, expected_version: 2 });
      assert.ok(h.effects.includes('pauseConversation'));
      return response({ ...registry(familyId), version: 3 });
    }
    if (path === '/api/health-subjects') return response({ ...registry(familyId), version: 3 });
    assert.equal(path, '/api/health-memory');
    assert.equal(h.run('activeConversation'), null, 'Old conversation clears before new background is read');
    assert.equal(h.element('archiveSubjectLabel').textContent, '当前资料所属人：虚构家属乙');
    assert.equal(h.element('photoSubjectLabel').textContent, '当前资料所属人：虚构家属乙');
    assert.deepEqual(plain(h.run('events')), []);
    oldPanes.forEach(id => assert.equal(h.element(id).innerHTML, '', id));
    return response(memory([entry({ context_id: 'context_fictional_family', subject_id: familyId,
      text: '虚构乙：2024年曾有湿疹' })], 1, familyId));
  });
  assert.equal(await h.run('activateHealthSubject("subject_fictional_family")'), true);
  assert.equal(h.run('activeHealthSubjectId'), familyId);
  assert.deepEqual(plain(h.run('conversations')), []);
  assert.deepEqual(plain(h.run('mediaItems')), []);
  for (const name of ['activeConversation', 'current', 'pendingRecordingBlob', 'conversationEditingTurnId',
    'pendingConversationTurn', 'pendingMediaRetry', 'lastSpokenTurnId']) assert.equal(h.run(name), null, name);
  for (const name of ['contextDraftSelection', 'handoffSelection', 'knownHandoffEvents']) assert.equal(h.run(name + '.size'), 0, name);
  assert.equal(h.run('healthSubjectUiEpoch'), 1);
  assert.match(h.element('voiceSubjectLabel').textContent, /虚构家属乙/);
  assert.match(h.element('healthMemoryList').innerHTML, /虚构乙/);
  assert.doesNotMatch(h.element('healthMemoryList').innerHTML, /虚构甲/);
  assert.equal(h.element('healthSubjectSelect').disabled, false);
});

test('an old subject memory response arriving after a switch cannot overwrite the new person or their list', async () => {
  const h = harness(), familyId = 'subject_fictional_family'; let releaseOld, memoryReads = 0, switched = false;
  h.setApi((path, options) => {
    if (path === '/api/health-subjects/active') { switched = true; return response({ ...registry(familyId), version: 3 }); }
    if (path === '/api/health-subjects') return response({ ...registry(switched ? familyId : 'subject_self'), version: switched ? 3 : 2 });
    assert.equal(path, '/api/health-memory');
    memoryReads++;
    if (memoryReads === 1) return new Promise(resolve => { releaseOld = resolve; });
    return response(memory([entry({ subject_id: familyId, text: '虚构乙的新资料' })], 6, familyId));
  });
  const oldLoad = h.run('loadHealthMemory()'); await new Promise(setImmediate);
  assert.equal(memoryReads, 1);
  assert.equal(await h.run('activateHealthSubject("subject_fictional_family")'), true);
  releaseOld(response(memory([entry({ text: '虚构甲的晚到旧资料' })], 99)));
  assert.equal(await oldLoad, false);
  assert.equal(h.run('activeHealthSubjectId'), familyId);
  assert.equal(h.run('healthMemoryVersion'), 6);
  assert.match(h.element('healthMemoryList').innerHTML, /虚构乙的新资料/);
  assert.doesNotMatch(h.element('healthMemoryList').innerHTML, /虚构甲|晚到旧资料/);
});

test('unfinished input or recording blocks subject switching and preserves the current identity and draft', async () => {
  for (const cause of ['input', 'recording', 'saving']) {
    const h = harness();
    if (cause === 'input') h.element('healthMemoryText').value = '虚构甲尚未保存的输入';
    if (cause === 'recording') h.setState({ mediaRecorder: { state: 'recording' } });
    if (cause === 'saving') h.setState({ saveBusy: true });
    assert.equal(await h.run('activateHealthSubject("subject_fictional_family")'), false, cause);
    assert.equal(h.calls.length, 0, cause);
    assert.equal(h.run('activeHealthSubjectId'), 'subject_self', cause);
    assert.equal(h.element('healthSubjectSelect').value, 'subject_self', cause);
    assert.match(h.element('healthSubjectStatus').textContent, /未保存|完成/, cause);
    if (cause === 'input') assert.equal(h.element('healthMemoryText').value, '虚构甲尚未保存的输入');
  }
});

test('creating a family subject saves only label, relationship and current subject-registry version without switching', async () => {
  const h = harness(); h.element('newHealthSubjectLabel').value = '  虚构家属丙  ';
  h.setApi((path, options, call) => {
    assert.equal(path, '/api/health-subjects');
    if (call.method === 'POST') {
      assert.deepEqual(call.body, { label: '虚构家属丙', relationship: 'family', expected_version: 2 });
      return response({ ...registry('subject_self'), version: 3 }, 201);
    }
    return response({ ...registry('subject_self'), version: 3,
      subjects: [...registry('subject_self').subjects, { subject_id: 'subject_fictional_third', label: '虚构家属丙', relationship: 'family' }] });
  });
  assert.equal(await h.run('createHealthSubject()'), true);
  assert.equal(h.run('activeHealthSubjectId'), 'subject_self');
  assert.equal(h.run('healthSubjectsVersion'), 3);
  assert.equal(h.element('newHealthSubjectLabel').value, '');
  assert.match(h.element('healthSubjectSelect').innerHTML, /虚构家属丙/);
  assert.equal(h.calls.some(call => call.path === '/api/health-subjects/active'), false);
});

test('a stale tab binds its shown owner and registry version, keeps its draft, and cannot adopt the other person implicitly', async () => {
  const h=harness();h.setState({healthMemoryVersion:0,healthMemoryEntries:[entry()]});
  h.run('renderHealthMemory();updateHealthSubjectLabels()');
  const draft='虚构甲自己的未保存过敏史';h.element('healthMemoryText').value=draft;
  h.setApi((path,options,call)=>{
    if(call.method==='POST'){
      assert.equal(path,'/api/health-memory');
      assert.equal(call.body.subject_id,'subject_self');
      assert.equal(call.body.expected_subject_version,2);
      assert.equal(call.body.expected_version,0);
      return response({error:'subject_changed'},409);
    }
    assert.equal(path,'/api/health-subjects','No family memory may be loaded after an identity conflict');
    return response({...registry('subject_fictional_family'),version:3,observed_subject_id:'subject_self'});
  });
  assert.equal(await h.run('saveHealthMemory()'),false);
  assert.equal(h.element('healthMemoryText').value,draft);
  assert.equal(h.run('activeHealthSubjectId'),'subject_self');
  assert.equal(h.run('healthSubjectChanged'),true);
  assert.match(h.element('voiceSubjectLabel').textContent,/所属人已变化，请重新选择/);
  assert.match(h.element('healthMemoryList').innerHTML,/虚构甲/);
  assert.doesNotMatch(h.element('healthMemoryList').innerHTML,/虚构家属乙/);
  assert.match(h.element('healthSubjectConflictNotice').textContent,/另一页面.*保留.*重新选择/);
  const posts=h.calls.filter(call=>call.method==='POST').length;
  assert.equal(await h.run('saveHealthMemory()'),false);
  assert.equal(h.calls.filter(call=>call.method==='POST').length,posts,'A second click cannot auto-transfer the draft');
});

test('the actual local API adapter binds scoped reads and preserves the shown identity when the store rejects another-page switch', async () => {
  const h=harness(),start=source.indexOf('async function api('),end=source.indexOf('async function refreshRuntimeConfiguration(',start);
  h.run(source.slice(start,end));
  h.run('globalThis.HealthLocal={request:async(path,opt)=>({r:{ok:false,status:409},j:{error:"subject_changed"},captured:{path,opt}})}');
  const result=await h.run('api("/api/events",{headers:{"Idempotency-Key":"synthetic-only"}})');
  assert.equal(result.captured.opt.headers['X-Health-Subject-Id'],'subject_self');
  assert.equal(result.captured.opt.headers['X-Health-Subject-Version'],'2');
  assert.equal(result.captured.opt.headers['Idempotency-Key'],'synthetic-only');
  assert.equal(h.run('healthSubjectChanged'),true);
  assert.equal(h.run('activeHealthSubjectId'),'subject_self');
});

test('explicitly reselecting the original person preserves the old-person draft and starts no assistant request', async () => {
  const h=harness(),draft='虚构甲：重新选本人后仍待保存';
  h.setState({healthSubjectChanged:true,healthSubjectsVersion:3});
  h.element('healthMemoryText').value=draft;h.element('voiceTextInput').value='虚构甲的一句尚未发送原话';
  h.setApi((path,options,call)=>{
    if(path==='/api/health-subjects/active'){
      assert.deepEqual(call.body,{subject_id:'subject_self',expected_version:3});
      return response({...registry('subject_self'),version:4,observed_subject_id:'subject_self'});
    }
    if(path==='/api/health-subjects')return response({...registry('subject_self'),version:4,observed_subject_id:'subject_self'});
    assert.equal(path,'/api/health-memory');return response(memory([],1));
  });
  assert.equal(await h.run('activateHealthSubject("subject_self")'),true);
  assert.equal(h.element('healthMemoryText').value,draft);
  assert.equal(h.element('voiceTextInput').value,'虚构甲的一句尚未发送原话');
  assert.equal(h.run('healthSubjectChanged'),false);
  assert.equal(h.run('activeHealthSubjectId'),'subject_self');
  assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
  assert.match(h.element('healthSubjectStatus').textContent,/重新选择.*保留/);
});

test('future occurrence dates fail locally with the entered text and date retained', async () => {
  const h=harness();h.element('healthMemoryText').value='虚构甲：未来日期输入错误';h.element('healthMemoryOccurredOn').value='2099-01-01';
  assert.equal(await h.run('saveHealthMemory()'),false);
  assert.equal(h.calls.length,0);
  assert.equal(h.element('healthMemoryText').value,'虚构甲：未来日期输入错误');
  assert.equal(h.element('healthMemoryOccurredOn').value,'2099-01-01');
  assert.match(h.element('healthMemoryStatus').textContent,/日期不能晚于今天.*保留/);
});

test('legacy background saving also binds the displayed owner and keeps raw input on identity conflict', async () => {
  const h=harness(),start=source.indexOf('async function saveHealthContext('),end=source.indexOf('function setupBackupRestore(',start);
  assert.ok(start >= 0 && end > start, 'extract only the legacy background save function');
  h.run(source.match(/^const HEALTH_CONTEXT_FIELDS=.*$/m)[0]+'\n'+source.slice(start,end));
  const draft='虚构甲的旧入口病史草稿';h.element('healthConditions').value=draft;
  h.setApi((path,options,call)=>{
    if(call.method==='POST'){
      assert.equal(path,'/api/health-context');assert.equal(call.body.subject_id,'subject_self');assert.equal(call.body.expected_subject_version,2);
      assert.equal(call.body.fields.conditions,draft);return response({error:'subject_changed'},409);
    }
    assert.equal(path,'/api/health-subjects');return response({...registry('subject_fictional_family'),version:3,observed_subject_id:'subject_self'});
  });
  await h.run('saveHealthContext()');
  assert.equal(h.element('healthConditions').value,draft);
  assert.equal(h.run('activeHealthSubjectId'),'subject_self');
  assert.equal(h.run('healthSubjectChanged'),true);
  assert.match(h.element('healthContextStatus').textContent,/没有保存.*保留/);
});

function loadActualPause(h) {
  const start = source.indexOf('async function pauseConversation(');
  const end = source.indexOf('async function submitConversationText(', start);
  assert.ok(start >= 0 && end > start, 'extract the actual pause-save function');
  h.run(source.slice(start, end));
  h.setState({ activeConversation: { conversation_id: 'conversation_synthetic_pause', turns: [
    { turn_id: 'elder_synthetic', role: 'elder', text: '完全虚构：保存失败反馈测试原话' },
  ] } });
}

test('pause HTTP failure gives visible feedback without retrying or replacing the original turn', async () => {
  const h = harness(); loadActualPause(h);
  h.setApi((path, options) => {
    assert.equal(path, '/api/conversations/conversation_synthetic_pause/pause');
    assert.equal(options.method, 'POST');
    return response({ error: 'synthetic_save_failed' }, 503);
  });

  await h.run('pauseConversation()');

  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.match(h.effects.join('\n'), /退出时未能确认保存结果，请重新打开对话核对/);
  assert.equal(h.run('activeConversation.turns[0].text'), '完全虚构：保存失败反馈测试原话');
});

test('pause request exception gives visible feedback without retrying or replacing the original turn', async () => {
  const h = harness(); loadActualPause(h);
  h.setApi(() => { throw new Error('synthetic_transport_failure'); });

  await h.run('pauseConversation()');

  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.match(h.effects.join('\n'), /退出时未能确认保存结果，请重新打开对话核对/);
  assert.equal(h.run('activeConversation.turns[0].text'), '完全虚构：保存失败反馈测试原话');
});

test('successful pause updates the conversation and does not show failure feedback', async () => {
  const h = harness(); loadActualPause(h);
  h.setApi((path, options) => {
    assert.equal(path, '/api/conversations/conversation_synthetic_pause/pause');
    assert.equal(options.method, 'POST');
    return response({ conversation: { conversation_id: 'conversation_synthetic_pause', status: 'paused', turns: [
      { turn_id: 'elder_synthetic', role: 'elder', text: '完全虚构：保存失败反馈测试原话' },
    ] } });
  });

  await h.run('pauseConversation()');

  assert.equal(h.run('activeConversation.status'), 'paused');
  assert.doesNotMatch(h.effects.join('\n'), /退出时未能确认保存结果/);
});
