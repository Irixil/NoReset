// Previously saved actual N01/N03 results, all explicitly synthetic.
// Offline rendering is not a new ASR/model success.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const fixtures = require('./fixtures/noreset-saved-memory-report.synthetic.json');
const source = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
const helpers = source.slice(source.indexOf('function liveArchiveTurns('), source.indexOf('function conversationLinkedRecordIds('));
function summary(conversation) {
  const context = vm.createContext({ conversation, isMockContent: item => item?.is_mock === true, mockText: text => /\[模拟\]/.test(text) });
  return vm.runInContext(helpers + '\nconversationSummary(conversation)', context);
}
test('saved actual N03 current episode and dated history remain visibly separate in compact summaries', () => {
  const c = fixtures.N03.conversation, text = summary(c);
  assert.match(text, /^上腹这两天不舒服；既往（2022-04-12）：/);
  assert.ok(text.length <= 128);
  assert.equal(text.split('既往').length, 2);
});
test('saved N01 corrected current course excludes old two-day duration from compact synopsis', () => {
  const text = summary(fixtures.N01.conversation);
  assert.match(text, /三天/); assert.doesNotMatch(text, /两天/);
  assert.ok(fixtures.N01.conversation.report.transcript.some(turn => turn.text === '我咳嗽两天了，晚上明显些。'));
});
test('long current wording cannot hide the historical date or convert an unknown date to a recording date', () => {
  const c = structuredClone(fixtures.N03.conversation);
  c.report.sections[0].lines[0].text = '当前完整合成原话'.repeat(30);
  assert.match(summary(c), /既往（2022-04-12）：/);
  const entry = c.report.sections.find(section => section.key === 'background_actions').lines.find(line => line.kind === 'context').source_context;
  entry.occurred_on = null; entry.recorded_at = '2026-10-10T00:00:00Z';
  assert.match(summary(c), /既往（发生日期未提供）：/);
  assert.doesNotMatch(summary(c), /2026-10-10/);
});
test('current and uncertain backgrounds retain distinct time labels', () => {
  const c = structuredClone(fixtures.N03.conversation);
  const entry = c.report.sections.find(section => section.key === 'background_actions').lines.find(line => line.kind === 'context').source_context;
  entry.temporal_status = 'current'; assert.match(summary(c), /已确认背景（2022-04-12）：/);
  entry.temporal_status = 'uncertain'; assert.match(summary(c), /背景时间未核对（2022-04-12）：/);
});
test('unstructured chronological originals are labelled as history, and mock background is excluded', () => {
  const c = structuredClone(fixtures.N01.conversation); c.report = null;
  assert.match(summary(c), /^原话历史：/);
  const n = structuredClone(fixtures.N03.conversation);
  n.report.sections.find(section => section.key === 'background_actions').lines.forEach(line => { line.is_mock = true; });
  assert.doesNotMatch(summary(n), /2022-04-12|既往/);
});
