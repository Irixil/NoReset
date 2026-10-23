const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');

test('invalidated audio keeps a concise actionable notice in the current chat', () => {
  const turn = { turn_id: 'turn_audio', role: 'elder', source_kind: 'audio_transcript', text: '右手腕不舒服。', media_id: 'media_audio', audio_source_invalidated: true };
  const context = vm.createContext({ activeConversation: { turns: [turn] }, turn, conversationEditingTurnId: null,
    saveBusy: false, isMockContent: () => false, canShowSavedTextFirstSend: () => false, escapeHtml: String });
  vm.runInContext(appSource.slice(appSource.indexOf('function audioDurationLabel('), appSource.indexOf('function naturalCorrectionTargets(')), context);
  vm.runInContext(appSource.slice(appSource.indexOf('function voiceTurnHtml('), appSource.indexOf('let voiceTurnMenuFocus=')), context);
  const html = vm.runInContext('voiceTurnHtml(turn)', context);
  assert.match(html, /录音来源已变化，请重新打开记录/);
  assert.doesNotMatch(html, /识别文字.*尚未人工核对|尚未对照原音/);
});

test('a failed original lookup shows its existing error outside the clipped player and restores the button', async () => {
  const statuses = [], turn = { turn_id: 'turn_audio', role: 'elder', source_kind: 'audio_transcript', text: '右手腕不舒服。', media_id: 'media_audio' };
  let lookups = 0;
  const target = { textContent: '', querySelector: () => null };
  const button = { dataset: { turnOriginal: turn.turn_id }, disabled: false, closest: () => ({ querySelector: () => target }) };
  const box = { querySelectorAll: selector => selector === '[data-turn-play]' ? [button] : [] };
  const context = vm.createContext({
    showConversationOriginal: async () => { lookups++; target.textContent = '这份临时录音已清理或暂时无法读取；识别文字与修改历史仍保留。'; return false; },
    setVoiceStatus: (message, tone) => statuses.push({ message, tone }),
  });
  const start = appSource.indexOf('function bindConversationSourceActions('), end = appSource.indexOf('function canShowSavedTextFirstSend(', start);
  vm.runInContext(appSource.slice(start, end), context);
  context.bindConversationSourceActions(box, { conversation_id: 'conversation_test', turns: [turn] });
  await button.onclick();
  assert.equal(lookups, 1, 'one tap makes one lookup');
  assert.equal(button.disabled, false, 'the playback control is restored');
  assert.ok(statuses.some(item => item.tone === 'error' && /录音/.test(item.message)));
  assert.equal(statuses.some(item => /原录音仍保留|原件仍保留|原录音仍保存/.test(item.message)), false);
});
