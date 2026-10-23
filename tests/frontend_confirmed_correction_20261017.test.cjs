const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
const ui = source.slice(source.indexOf('function naturalCorrectionDetails('), source.indexOf('async function confirmNaturalCorrection('));
const context = vm.createContext({ localMode: true, isMockContent: item => item?.is_mock === true,
  escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c])) });
vm.runInContext(ui, context);
const legacyUi = source.slice(source.indexOf('function legacyReorganizationOutputCandidate('), source.indexOf('function conversationSafety('));
vm.runInContext(`function conversationTurnTime(){return ''};\n${legacyUi}`, context);
const old = { turn_id: 'old', role: 'elder', source_kind: 'elder', version: 1, text: '昨晚睡了3.5小时。早上还好。' };
const correction = { turn_id: 'correction', role: 'elder', source_kind: 'elder', version: 1,
  text: '更正一下，刚才说睡得还可以不准确，昨晚只睡了一会儿。' };
const conversation = { turns: [old, correction], completeness: { contradictions: [
  { text: '自然更正无法唯一定位旧原话，待核实。', evidence_turn_ids: ['correction'] },
] } };

test('older messages remain quotable but are not offered as rewrite targets', () => {
  const c = structuredClone(conversation);
  c.turns.unshift({...old, turn_id:'audio', source_kind:'audio_transcript'}, {...old, turn_id:'mock', is_mock:true},
    {...old, turn_id:'obsolete', superseded:true}, {...old, turn_id:'assistant', role:'assistant'});
  c.turns.push({...old, turn_id:'later'});
  const choices = context.naturalCorrectionTargets(c, correction);
  assert.deepEqual(Array.from(choices), []);
});

test('natural correction remains an appended message and has no older-turn rewrite control', () => {
  const targets = context.naturalCorrectionTargets(conversation, correction);
  const initial = context.naturalCorrectionReviewHtml(correction, targets, {turnId:'correction'});
  assert.match(initial, /更正已作为新原话保留/);
  assert.match(initial, /较早原话不会被回写/);
  assert.doesNotMatch(initial, /data-natural-correction-target|data-natural-correction-save|correction-target/);
});

test('unmatched format or truncated replacement cannot acquire a guessed correction', () => {
  assert.equal(context.naturalCorrectionDetails('好像刚才说错了'), null);
  assert.equal(context.naturalCorrectionDetails('更正一下，刚才说旧话不准确，' + '甲'.repeat(121)), null);
  assert.equal(context.pendingNaturalCorrection({...conversation, manual_corrections:[{correction_turn_id:'correction'}]}, correction), null);
});

test('natural correction review does not re-render or modify older source text', () => {
  const target = {...old, text:'<script>unsafe</script>。'};
  const c = {...conversation, turns:[target, correction]};
  const html = context.naturalCorrectionReviewHtml(correction, context.naturalCorrectionTargets(c, correction), {});
  assert.match(html, /较早原话不会被回写/);
  assert.doesNotMatch(html, /<script>|&lt;script&gt;/);
});

function legacyCandidateFixture(){
  const confirmedAt='2026-10-17T10:00:00.000Z';
  const target={turn_id:'target',role:'elder',source_kind:'elder',version:2,text:'更正后的原话。',edited_at:confirmedAt,created_at:'2026-10-17T09:00:00.000Z'};
  const correctionTurn={turn_id:'correction',role:'elder',source_kind:'elder',version:1,text:'刚才说错了。',created_at:'2026-10-17T09:59:00.000Z'};
  const reply={turn_id:'legacy-reply',role:'assistant',version:1,text:'这是旧版重新整理操作回复。',created_at:'2026-10-17T10:01:00.000Z'};
  return {conversation_id:'legacy-case',version:8,subject_id:'subject_self',turns:[target,correctionTurn,reply],
    manual_corrections:[{correction_turn_id:'correction',target_turn_id:'target',target_version_after:2,target_text_after:target.text,confirmed_at:confirmedAt}],
    manual_correction_reorganization:{state:'completed',scope_id:'a'.repeat(64),body_sha256:'b'.repeat(64)},
    last_ai_metadata:{trace_id:'legacy-trace',provider:'ActualProvider'}};
}

function legacyCandidateProjection(){
  const full=legacyCandidateFixture(),turn=full.turns[2];
  return {turn:{turn_id:turn.turn_id,version:turn.version,text:turn.text,created_at:turn.created_at},trace_id:'legacy-trace',
    provider:'ActualProvider',scope_id:'a'.repeat(64),body_sha256:'b'.repeat(64)};
}

test('archive UI consumes only the exact store-projected candidate, not a guessed correction position',()=>{
  const projected=legacyCandidateProjection();
  assert.equal(context.legacyReorganizationOutputCandidate({turns:[legacyCandidateFixture().turns[0]],
    legacy_reorganization_candidate:projected})?.turn.turn_id,'legacy-reply');
  assert.equal(context.legacyReorganizationOutputCandidate({turns:legacyCandidateFixture().turns,
    legacy_reorganization_candidate:null}),null);
  assert.equal(context.legacyReorganizationOutputCandidate({legacy_reorganization_candidate:{...projected,provider:''}}),null);
});

test('legacy output review presents complete text with unchecked confirmation and expandable history',()=>{
  const candidate=legacyCandidateProjection(),conversation={legacy_reorganization_history:[]};
  const collapsed=context.legacyReorganizationOutputReviewHtml(candidate,null);
  assert.match(collapsed,/查看并核对这条旧回复/);
  const review=context.legacyReorganizationOutputReviewHtml(candidate,{turnId:candidate.turn.turn_id,confirmed:false,busy:false,error:''});
  assert.match(review,new RegExp(candidate.turn.text));
  assert.match(review,/这是上次重新整理产生的旧回复，仅保留历史/);
  assert.doesNotMatch(review,/data-legacy-reorganization-confirm checked/);
  assert.match(review,/data-legacy-reorganization-save disabled/);
  conversation.legacy_reorganization_history=[{turn_id:candidate.turn.turn_id,text:candidate.turn.text,trace_id:candidate.trace_id,
    provider:candidate.provider,created_at:candidate.turn.created_at}];
  const history=context.legacyReorganizationOutputHistoryHtml(conversation);
  assert.match(history,/<details>/);assert.match(history,/历史整理操作回复/);assert.match(history,/保留作历史核对/);
});
