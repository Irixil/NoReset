// Former native N02 failure: a saved unknown turn omitted from section facts
// must still have its current source/version/full quote in the report.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../frontend/app.js'),'utf8');
const code=app.slice(app.indexOf('function reportOriginalSourcesHtml('),app.indexOf('function syncConversation('));
function render(report){return vm.runInNewContext(code+'\nreportOriginalSourcesHtml(report)',{report,isMockContent:x=>!!x?.is_mock,mockText:x=>/^\s*\[Mock (?:ASR|OCR)\]/i.test(x),escapeHtml:x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))})}
const raw={turn_id:'natural_unknown',version:1,quote:'不是天天都有，几次我记不清了。'};
test('unextracted unknown remains current raw evidence without becoming a clinical fact',()=>{
  const report={source_turn_ids:[raw.turn_id],source_versions:[raw],sections:[]};const before=JSON.stringify(report),html=render(report);
  assert.match(html,/data-source-turn-id="natural_unknown"/);assert.match(html,/原话第 1 版/);assert.match(html,/不是天天都有，几次我记不清了。/);
  assert.match(html,/尚未整理进摘要/);assert.match(html,/本人未核对/);assert.equal(JSON.stringify(report),before);
  assert.ok(html.indexOf(raw.quote)<html.indexOf('<details'),'full current raw quote prints even when details is closed');
});
test('corrected source points to v2 and safely escapes full quote',()=>{
  const html=render({source_turn_ids:[raw.turn_id],source_versions:[{...raw,version:2,quote:'<script>不是无症状 & 未核对</script>'}]});
  assert.match(html,/原话第 2 版 · 已修订/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/原话第 1 版/);
});
test('unbound, malformed, ambiguous and mock sources never invent current source evidence',()=>{
  for(const report of [{},{source_turn_ids:null,source_versions:[raw]},{source_turn_ids:[raw.turn_id],source_versions:[{...raw,version:0}]},{source_turn_ids:[raw.turn_id],source_versions:[{...raw,version:2.5}]},{source_turn_ids:[raw.turn_id],source_versions:[raw,{...raw,version:2}]},{source_turn_ids:[raw.turn_id],source_versions:[{...raw,is_mock:true}]},{source_turn_ids:[raw.turn_id],source_versions:[{...raw,quote:'[Mock ASR] 不作患者事实'}]}])assert.equal(render(report),'');
});
