// Synthetic renderer contract; the native journey proves browser/print behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app.js'), 'utf8');
const renderer = source.slice(source.indexOf('function reportFactHtml('), source.indexOf('function syncConversation('));
const sectionRenderer = source.slice(source.indexOf('function reportSectionsHtml('), source.indexOf('function reportOriginalSourcesHtml('));
function render(line) {
  const context = vm.createContext({ line, escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) });
  return vm.runInContext(renderer + '\nreportFactHtml(line, 0)', context);
}
const fact = (version = 2) => ({ kind: 'summary', text: '合成当前摘要', source_label: '当前原话 1 · 本人未核对',
  source_turn_ids: ['turn_synthetic_a'], source_versions: [{ turn_id: 'turn_synthetic_a', version, quote: '合成第 ' + version + ' 版完整原话' }] });

test('doctor fact shows bound original version outside its collapsible full quote', () => {
  const html = render(fact());
  assert.match(html, /原话第 2 版 · 已修订/);
  assert.match(html, /details class="report-source-evidence"/);
  assert.ok(html.indexOf('原话第 2 版 · 已修订') < html.indexOf('<details'));
  assert.match(html, /查看对应原话/);
  assert.match(html, /合成第 2 版完整原话/);
});

test('first original version is explicit without claiming a revision', () => {
  const html = render(fact(1));
  assert.match(html, /原话第 1 版/);
  assert.doesNotMatch(html, /已修订/);
});

test('unbound legacy, invalid and foreign source metadata never invent a source version', () => {
  for (const source_versions of [undefined, [], [{ turn_id: 'turn_synthetic_a', version: 0, quote: 'invalid' }],
    [{ turn_id: 'turn_synthetic_a', version: 2.5, quote: 'invalid' }], [{ turn_id: 'foreign', version: 3, quote: 'foreign' }],
    [{ turn_id: 'turn_synthetic_a', version: 2, quote: '' }]]) {
    const html = render({ ...fact(), source_versions });
    assert.match(html, /当前原话 1/);
    assert.doesNotMatch(html, /原话第|report-source-evidence|foreign|invalid/);
  }
  for(const source_turn_ids of [undefined,null,'turn_synthetic_a',{},[null]]) {
    const html=render({...fact(),source_turn_ids});
    assert.doesNotMatch(html,/原话第|report-source-evidence/);
  }
  for(const turn_id of ['',null,{}]) {
    const html=render({...fact(),source_turn_ids:[turn_id],source_versions:[{turn_id,version:2,quote:'无效来源'}]});
    assert.doesNotMatch(html,/原话第|report-source-evidence/);
  }
});

test('each bound source keeps its own version and safely escaped full quote', () => {
  const html = render({ ...fact(), source_turn_ids: ['turn_synthetic_a', 'turn_synthetic_b'],
    source_versions: [{ turn_id: 'turn_synthetic_a', version: 2, quote: '<script>"synthetic" & unsafe</script>' },
      { turn_id: 'turn_synthetic_b', version: 3, quote: '另一条完整合成原话' }] });
  assert.match(html, /原话第 2 版 · 已修订/);
  assert.match(html, /原话第 3 版 · 已修订/);
  assert.equal((html.match(/report-source-evidence/g) || []).length, 2);
  assert.match(html, /&lt;script&gt;&quot;synthetic&quot; &amp; unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('saved legacy report sections pass through pure display normalization', () => {
  assert.match(sectionRenderer, /normalizeReportDisplay/);
  const original = { sections: [{ key: 'symptoms_impact', title: '症状特点与生活影响', lines: [{ kind: 'summary', text: '同源摘要' }] }] };
  const normalized = { sections: [{ ...original.sections[0], lines: [{ ...original.sections[0].lines[0], text: '同源摘要 · 只显示一次' }] }] };
  const context = vm.createContext({ report: original, globalThis: { HealthLocal: { normalizeReportDisplay: () => normalized } },
    isMockContent: () => false, mockText: () => false, escapeHtml: value => String(value) });
  const html = vm.runInContext(renderer + sectionRenderer + '\nreportSectionsHtml(report)', context);
  assert.match(html, /同源摘要 · 只显示一次/);
  assert.equal(JSON.stringify(original.sections[0].lines[0].text), JSON.stringify('同源摘要'));
});

test('report refresh explains that an unbound current source still needs conversation organization', async () => {
  const refreshHandler = source.slice(source.indexOf('let reportRefreshBusy=false;'), source.indexOf('function reportSubjectLabel('));
  const elements = new Map([['refreshConversationReportStatus', { textContent: '' }],
    ['refreshConversationReportBtn', { disabled: true, focus() {} }]]);
  const calls = [];
  const context = vm.createContext({ activeConversation: { conversation_id: 'conversation_synthetic', subject_id: 'subject_self', version: 4,
      report: { version: 2 } }, activeHealthSubjectId: 'subject_self', healthSubjectsVersion: 1,
    $: id => elements.get(id), renderConversationReport() {}, syncConversation() {},
    HealthLocal: { request: async (path, options) => {
      calls.push(path);
      if (path === '/api/health-memory') return { r: { ok: true }, j: { health_context: { version: 0 } } };
      assert.equal(options.method, 'POST');
      return { r: { ok: false, status: 409 }, j: { error: 'report_sources_not_current' } };
    } } });
  await vm.runInContext(`${refreshHandler}\nrefreshConversationReport()`, context);
  assert.deepEqual(calls, ['/api/health-memory', '/api/conversations/conversation_synthetic/refresh-report']);
  assert.equal(elements.get('refreshConversationReportStatus').textContent,
    '当前原话还没有对应的整理结果；原话和本机报告已保留。请先完成对话整理，再更新报告。');
});
