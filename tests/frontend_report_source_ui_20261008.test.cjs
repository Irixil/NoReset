// Synthetic renderer contract; the native journey proves browser/print behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../frontend/app.js'), 'utf8');
const renderer = source.slice(source.indexOf('function reportFactHtml('), source.indexOf('function syncConversation('));
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
