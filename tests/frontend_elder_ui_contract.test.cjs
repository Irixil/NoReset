const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const frontend = path.join(__dirname, '../frontend');
const read = name => fs.readFileSync(path.join(frontend, name), 'utf8');
const markup = read('index.html');
const app = read('app.js');
const styles = read('styles.css');
const ios = read('ios.css');
const splash = read('splash.js');
const localStore = read('local-store.js');

test('complete elder frontend remains the only user-facing shell', () => {
  const nav = markup.match(/<nav class="bottom-nav"[\s\S]*?<\/nav>/)?.[0] || '';
  assert.equal((nav.match(/class="nav-item/g) || []).length, 3);
  for (const view of ['homeView', 'voiceView', 'photoCaptureView', 'recordsView', 'archiveView', 'settingsView']) {
    assert.match(markup, new RegExp(`id="${view}"`));
  }
  for (const control of ['recordBtn', 'voiceTextInput', 'voiceTextSend', 'photoInput', 'eventsList', 'archivePhotos', 'handoffBtn']) {
    assert.match(markup, new RegExp(`id="${control}"`));
  }
  assert.match(markup, /class="conversation-stream"/);
  assert.match(markup, /runtime-config\.js/);
  assert.match(markup, /local-store\.js/);
  assert.match(app, /globalThis\.HealthLocal\.request/);
});

test('the original mascot and voice-first identity are retained', () => {
  assert.ok(fs.existsSync(path.join(frontend, 'assets/brand-mascot.png')));
  assert.ok((markup.match(/assets\/brand-mascot\.png/g) || []).length >= 3);
  assert.match(markup, /身体感觉怎么样/);
  assert.match(markup, /慢慢说，我帮你记着/);
  assert.match(markup, /说给我听/);
});

test('text can be recorded without replacing the voice-first navigation', () => {
  assert.doesNotMatch(markup, /id="textView"|data-view="textView"|id="rawText"/);
  assert.match(markup, /打字说，或者点麦克风/);
  assert.match(app, /\/api\/conversations\/\$\{encodeURIComponent\(activeConversation\.conversation_id\)\}\/turns/);
  assert.match(app, /if\(saveBusy\|\|/);
});

test('prototype demo identity and simulated diagnostic chat are not shipped', () => {
  const shipped = `${markup}\n${app}`;
  assert.doesNotMatch(shipped, /王大爷|72 岁|上海|诊断交接|语音问答|边说边补全/);
  assert.match(app, /CONVERSATION|conversation/i);
  assert.match(markup, /核对记录，不等于诊断/);
  assert.match(markup, /不能诊断或提供用药、检查建议/);
});

test('mobile shell includes elderly touch, safe-area, dynamic viewport and reduced-motion safeguards', () => {
  assert.match(styles, /min-height:\s*48px/);
  assert.match(styles, /min-height:\s*100dvh/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(ios, /safe-area-inset-bottom/);
  assert.doesNotMatch(ios, /height:\s*844px/);
});

test('splash is dismissible, session-scoped and reduced-motion aware', () => {
  assert.match(markup, /id="splashSkip"/);
  assert.match(splash, /sessionStorage/);
  assert.match(splash, /Escape/);
  assert.match(splash, /prefers-reduced-motion/);
  assert.match(splash, /setTimeout\(closeSplash/);
});

test('minimal loop has no AI confirmation or family device-binding gate', () => {
  const shipped = `${markup}\n${app}\n${localStore}`;
  assert.doesNotMatch(shipped, /cloudPassword|cloudLoginForm|网站访问密码|\/api\/app\/login/);
  assert.doesNotMatch(shipped, /\/api\/app\/device\/activate|family_device_binding_required|ensureAiConsent/);
  assert.doesNotMatch(shipped, /在线识别尚未由家属开通|请让家属用绑定链接/);
  assert.doesNotMatch(localStore, /本次会把选中.*是否继续/);
  assert.match(localStore, /event_link:\s*\{ record_id: created\.j\.event\.record_id \}/);
  assert.match(markup, />保存照片原件并尝试识别</);
  assert.doesNotMatch(markup, /id="onlineAccessStatus"|id="uploadCloudBackupBtn"|id="refreshCloudBackupsBtn"/);
});

test('photo and uploaded audio start recognition immediately after the original is saved', () => {
  const media = read('media.js');
  assert.match(media, /savePhotoBtn[\s\S]*?uploadMedia\(selectedPhoto,'image'\)[\s\S]*?recognizeMedia\(m\.media_id\)/);
  assert.match(media, /audioUploadInput[\s\S]*?uploadMedia\(f,'audio'\)[\s\S]*?recognizeMedia\(m\.media_id\)/);
});

test('conversation edits the visible elder turn and regenerates the grounded report', () => {
  assert.match(app, /data-voice-turn-edit/);
  assert.match(app, /saveVoiceTurnEdit/);
  assert.doesNotMatch(app, /data-voice-summary-edit|saveVoiceSummaryCorrection/);
  assert.match(localStore, /parts\[3\] === 'turns'/);
  assert.match(localStore, /versions: \[\.\.\.\(turn\.versions \|\| \[\]\)/);
  assert.match(localStore, /conversation_turn_corrected/);
  assert.match(localStore, /local_safety: revisedSafety/);
  assert.match(localStore, /buildConversationReport\(edited, conversation\.report\)/);
  assert.match(markup, /修改聊天里的原话后，报告会自动更新|就诊沟通记录/);
  assert.match(app, /if\(editingTurn\)/);
  assert.match(app, /data-voice-turn-input[\s\S]*?scrollIntoView/);
});

test('conversation report is a keyboard-contained modal and mobile actions stay finger-sized', () => {
  assert.match(app, /handleConversationReportKeydown/);
  assert.match(app, /event\.key==='Escape'/);
  assert.match(app, /event\.key!=='Tab'/);
  assert.match(app, /querySelectorAll\('button:not\(\[disabled\]\), summary,/);
  assert.match(app, /setReportBackgroundInert\(true\)/);
  assert.match(app, /setAttribute\('inert'/);
  assert.match(app, /removeAttribute\('inert'/);
  assert.match(styles, /\.chat-edit-link\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /\.chat-inline-actions button\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(styles, /\.report-transcript summary\s*\{[^}]*min-height:\s*(?:44|52)px/);
});

test('record search has an explicit action and mobile record text keeps the full row', () => {
  assert.match(markup, /<form id="recordFilters"[\s\S]*?id="applyFilters"[\s\S]*?>搜索记录</);
  assert.match(markup, /id="filterResultsStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(markup, /id="eventsList"[^>]*tabindex="-1"/);
  assert.match(app, /recordFilters'[)]\?\.addEventListener\('submit',applyRecordFilters\)/);
  assert.match(app, /scrollIntoView\?\.\(\{behavior:'smooth',block:'start'\}\)/);
  assert.match(app, /找到 \$\{count\} 份符合条件的记录/);
  assert.match(styles, /\.handoff-choice\s*\{[^}]*width:\s*auto[^}]*flex:\s*none/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.event-item\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.event-item \.event-main\s*\{[^}]*grid-column:\s*1 \/ -1/);
});

test('record view opens a real detail page instead of scrolling to a preview below the list', () => {
  assert.match(markup, /id="recordDetailView"[^>]*class="view subview"[^>]*aria-labelledby="detailPageTitle"/);
  assert.match(markup, /id="recordDetailView"[\s\S]*?data-view="recordsView"[\s\S]*?返回我的记录[\s\S]*?id="detail"/);
  const recordsView = markup.match(/<section id="recordsView"[\s\S]*?<\/section>\s*<section id="recordDetailView"/)?.[0] || '';
  assert.doesNotMatch(recordsView.replace(/<section id="recordDetailView"[\s\S]*/, ''), /id="detail"/);
  assert.match(app, /async function showDetail\(id\)\{if\(!showView\('recordDetailView'\)\)return;/);
  assert.match(app, /function closeDetail\(\)\{showView\('recordsView'\)\}/);
  const detailRenderer = app.match(/function renderDetail[\s\S]*?async function loadRelatedHistory/)?.[0] || '';
  assert.doesNotMatch(detailRenderer, /reveal\(d/);
});

test('conversation has automatic exit report, resume choice and bounded pause-to-send recording', () => {
  assert.match(markup, /退出也会自动留下报告/);
  assert.match(markup, /接着上次说/);
  assert.match(markup, /记录新的情况/);
  assert.match(localStore, /status_label: '自动整理 · 本人未核对'/);
  assert.match(app, /no_new_fact|conversation/i);
  assert.match(app, /Date\.now\(\)-silenceStartedAt>=2600/);
  assert.match(app, /startSilenceWatch/);
});

test('conversation recovery keeps later additions in the same grounded history', () => {
  assert.match(app, /conversationHasPendingReply/);
  assert.match(app, /resume-assistant/);
  assert.match(app, /刚才的话已保存在本机/);
  assert.match(localStore, /pendingElderTurn/);
  assert.match(localStore, /withConversationLock/);
  assert.match(localStore, /conversationModelPayload/);
  assert.doesNotMatch(localStore, /startsNewEpisode|episodeIndex|modelTurns/);
});

test('the legacy urgent exception keeps its exact text check with local danger provenance', () => {
  assert.match(localStore, /action === 'urgent'[\s\S]{0,200}result\.j\?\.assistant_text === safety\.DANGER_REMINDER/);
  assert.doesNotMatch(localStore, /reviewedFixedText = result\.j\?\.action === 'urgent' \|\|/);
});

test('past medication and test facts are not confused with new medical advice', () => {
  assert.match(localStore, /已核对既往用药/);
  assert.match(localStore, /已核对既往资料/);
  assert.match(localStore, /建议\|应该\|应当\|最好/);
});

test('confirmed health context is encrypted locally and optional to attach to a conversation', () => {
  for (const control of ['healthConditions', 'healthMedications', 'healthAllergies', 'healthProcedures', 'healthTests', 'healthSimilarEpisodes', 'saveHealthContextBtn']) {
    assert.match(markup, new RegExp(`id="${control}"`));
  }
  assert.match(markup, /仅存本机/);
  assert.match(localStore, /HEALTH_CONTEXT_KEY = 'health-context:current'/);
  assert.match(localStore, /source: 'user_confirmed'/);
  assert.match(app, /loadHealthContext/);
  assert.match(app, /saveHealthContext/);
  assert.match(markup, /id="openHealthContextPickerBtn"[^>]*>带上相关资料（可选）/);
  assert.match(markup, /不会另附未勾选的背景，本段问答仍用于回复/);
});

test('reports use doctor handoff sections with sources and retain raw transcript', () => {
  for (const title of ['主要不适', '起病与变化', '症状特点与生活影响', '相关背景与已做处理', '尚待医生核实']) {
    assert.match(localStore, new RegExp(title));
  }
  const reportBuilder = localStore.match(/function buildConversationReport[\s\S]*?function conversationWithCurrentReport/)?.[0] || '';
  assert.match(reportBuilder, /analysisSourcesCurrent/);
  assert.match(reportBuilder, /groundedReportSummary/);
  assert.match(reportBuilder, /kind: 'quote', text: turn\.text/);
  assert.match(reportBuilder, /format_version: 5/);
  assert.match(localStore, /source_context_ids/);
  assert.match(localStore, /transcript:/);
  assert.match(app, /reportSectionsHtml/);
  assert.match(app, /查看完整对话/);
  assert.match(app, /reportFactHtml/);
  assert.match(markup, /用于和医生沟通，不是诊断/);
});

test('records group one conversation into one dated summary and keep both sides of the transcript', () => {
  assert.match(markup, /id="conversationRecordTpl"[\s\S]*?>查看完整对话</);
  assert.match(markup, /完整对话、单独记录、录音和照片放在一起/);
  assert.match(app, /api\('\/api\/conversations'\)/);
  assert.match(app, /function conversationLinkedRecordIds/);
  assert.match(app, /function standaloneEvents/);
  assert.match(app, /showConversationDetail\(conversation\.conversation_id\)/);
  assert.match(app, /function conversationDetailHtml/);
  assert.match(app, /speaker=assistant\?'\u5c0f\u96f6':'\u6211'/);
  assert.match(localStore, /transcript: liveConversationTurns\(conversation\)\.filter\(turn => !mockSource\(turn\)\)\.map/);
  assert.match(localStore, /transcript: liveConversationTurns\(item\)\.filter\(turn => !mockSource\(turn\)\)/);
  assert.match(localStore, /pathname === '\/api\/conversations' && method === 'GET'/);
});

test('every record card exposes a bottom-right confirmed delete action', () => {
  assert.doesNotMatch(app, /id="deleteConversationBtn"/);
  assert.match(markup, /id="conversationRecordTpl"[\s\S]*?class="record-delete-btn"[\s\S]*?aria-label="删除这条完整对话"/);
  assert.match(markup, /id="eventTpl"[\s\S]*?class="record-delete-btn"[\s\S]*?aria-label="删除这条记录"/);
  assert.match(app, /deleteConversation\(conversation,deleteButton\)/);
  assert.match(app, /deleteRecord\(event,deleteButton\)/);
  assert.match(app, /async function deleteConversation\(conversation,button=null\)/);
  assert.match(app, /method:'DELETE'[\s\S]*?delete_scope_confirmed:true,expected_version:conversation\.version/);
  assert.match(app, /确定删除这条完整对话吗/);
  assert.match(styles, /\.record-actions\s*\{[^}]*align-self:\s*flex-end/);
  assert.match(styles, /\.record-delete-btn\s*\{[^}]*width:\s*48px[^}]*height:\s*48px/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.event-item > \.record-actions\s*\{[^}]*grid-row:\s*3[^}]*justify-self:\s*end/);
  const conversationRequest = localStore.match(/async function conversationRequest[\s\S]*?async function processRecognition/)?.[0] || '';
  assert.match(conversationRequest, /method === 'DELETE'/);
  assert.match(conversationRequest, /delete_scope_confirmed/);
  assert.match(conversationRequest, /expected_version/);
  assert.match(conversationRequest, /item\.conversation_id === conversationId/);
  assert.match(conversationRequest, /removeEventBody\(recordId\)/);
  assert.match(conversationRequest, /remove\(conversationKey\(conversationId\)\)/);
});

test('clinical intake controller uses broad history dimensions instead of the old four-step script', () => {
  for (const category of ['main_complaint', 'onset_course', 'symptom_character', 'aggravating_relieving', 'associated_symptoms', 'functional_impact', 'relevant_history', 'prior_actions_results']) {
    assert.match(localStore, new RegExp(category));
  }
  assert.doesNotMatch(localStore, /question_count:\s*min\([^\n]*,\s*6\)/);
});
