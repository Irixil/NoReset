const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const appSource=fs.readFileSync(require.resolve('../frontend/app.js'),'utf8');
const html=fs.readFileSync(require.resolve('../frontend/index.html'),'utf8');
const css=fs.readFileSync(require.resolve('../frontend/styles.css'),'utf8');
const start=appSource.indexOf('function setupBackupRestore(){');
const end=appSource.indexOf("\nif($('downloadBackupBtn'))",start);
const setupSource=start>=0&&end>start?appSource.slice(start,end):'';
const resetStart=appSource.indexOf('function resetHealthSubjectScope(){');
const resetEnd=appSource.indexOf('\nfunction handleLocalVaultState',resetStart);
const resetSource=resetStart>=0&&resetEnd>resetStart?appSource.slice(resetStart,resetEnd):'';

function makeHarness(overrides={}){
  const nodes=new Map(),calls=[],updates=[];
  const $=id=>{if(!nodes.has(id)){const classes=new Set(['restoreBackupForm','restoreBackupPreview'].includes(id)?['hidden']:[]);nodes.set(id,{id,value:'',textContent:'',hidden:false,disabled:false,files:[],classList:{add(name){classes.add(name)},remove(name){classes.delete(name)},toggle(name,force){if(force??!classes.has(name))classes.add(name);else classes.delete(name)},contains(name){return classes.has(name)}},onchange:null,oninput:null,onsubmit:null,onclick:null})}return nodes.get(id)};
  const api={previewBackup:async(file,passphrase)=>{calls.push(['preview',file,passphrase]);return {archive:{},eventCount:3,mediaCount:1,exportedAt:'2026-10-17T08:00:00Z'};},
    restoreBackup:async(preview,passphrase)=>{calls.push(['restore',preview,passphrase]);return {eventCount:3,mediaCount:1};},...overrides};
  const context=vm.createContext({$,HealthLocal:api,healthSubjectUiEpoch:0,healthSubjectsRequestId:0,healthSubjectsLoadPromise:{},healthSubjects:[],healthSubjectsVersion:7,activeHealthSubjectId:'subject_old',healthSubjectLoaded:true,healthSubjectChanged:true,healthSubjectSwitchBusy:true,clearHealthSubjectDisplays(){updates.push('clear')},
    loadHealthMemory:async()=>updates.push('memory'),loadEvents:async()=>updates.push('events'),
    prompt(){throw new Error('prompt() is not supported')},confirm(){throw new Error('confirm() is not supported')}});
  if(setupSource&&resetSource)vm.runInContext(`${resetSource}\n${setupSource}\nsetupBackupRestore();`,context);
  return {nodes,$,calls,updates,context};
}

test('backup restore uses a normal password and confirmation form, never native prompt or confirm',()=>{
  assert.ok(setupSource,'a directly testable setupBackupRestore flow is required');
  for(const id of ['restoreBackupForm','restoreBackupPassphrase','restoreBackupPreview','restoreBackupConfirm','restoreBackupCancel'])
    assert.match(html,new RegExp(`id="${id}"`),`${id} must be present in the page`);
  const formTag=html.match(/<form id="restoreBackupForm"[^>]*>/)?.[0]||'';
  const previewTag=html.match(/<div id="restoreBackupPreview"[^>]*>/)?.[0]||'';
  assert.match(formTag,/class="[^"]*\bhidden\b/,'the form must start with the project hidden class');
  assert.match(previewTag,/class="[^"]*\bhidden\b/,'the preview must start with the project hidden class');
  assert.match(css,/\.hidden\s*\{\s*display:\s*none\s*!important/,'the shared hidden class must win against component display rules');
  assert.match(css,/\.backup-restore-form\s*\{\s*display:\s*grid/,'the form has its own grid display rule');
  assert.match(css,/\.backup-restore-preview\s*\{\s*display:\s*grid/,'the preview has its own grid display rule');
  assert.match(setupSource,/form\.classList\.toggle\('hidden',!selectedFile\)/,'file selection must remove the actual CSS hiding class');
  assert.match(setupSource,/previewPanel\.classList\.remove\('hidden'\)/,'successful preview must remove the actual CSS hiding class');
  assert.doesNotMatch(setupSource,/\b(?:prompt|confirm)\s*\(/,'backup restore must not invoke unsupported browser-native dialogs');
});

test('explicit preview then confirm restores once and refreshes local views',async()=>{
  const h=makeHarness(),file={name:'fictional-backup.bingli',size:128,text:async()=>'{ }'},form=h.$('restoreBackupForm');
  h.$('restoreBackupInput').files=[file];h.$('restoreBackupInput').onchange({target:h.$('restoreBackupInput')});
  assert.equal(form.classList.contains('hidden'),false);assert.match(h.$('restoreBackupFileName').textContent,/fictional-backup\.bingli/);
  h.$('restoreBackupPassphrase').value='fictional original recovery phrase';
  await form.onsubmit({preventDefault(){}});
  assert.deepEqual(h.calls.map(call=>call[0]),['preview']);
  assert.equal(h.$('restoreBackupPreview').classList.contains('hidden'),false);
  assert.equal(h.$('restoreBackupConfirm').disabled,false);
  assert.match(h.$('restoreBackupPreviewSummary').textContent,/3.*1.*2026/);
  await h.$('restoreBackupConfirm').onclick();
  assert.deepEqual(h.calls.map(call=>call[0]),['preview','restore']);
  assert.deepEqual(h.updates,['clear','memory','events']);
  assert.equal(h.context.activeHealthSubjectId,'subject_self');assert.equal(h.context.healthSubjectsVersion,0);
  assert.equal(h.context.healthSubjectLoaded,false);assert.equal(h.context.healthSubjectUiEpoch,1);
  assert.equal(h.$('restoreBackupPassphrase').value,'');assert.equal(form.classList.contains('hidden'),true);
  assert.match(h.$('backupStatus').textContent,/恢复完成/);
});

test('successful restore does not claim refreshed lists when memory reread returns false or throws',async()=>{
  for(const mode of ['false','throw']){
    const h=makeHarness();h.context.loadHealthMemory=async()=>{h.updates.push('memory');if(mode==='throw')throw new Error('read unavailable');return false;};
    const input=h.$('restoreBackupInput'),form=h.$('restoreBackupForm');
    input.files=[{name:'fictional-backup.bingli',size:1}];input.onchange({target:input});
    h.$('restoreBackupPassphrase').value='fictional recovery phrase';await form.onsubmit({preventDefault(){}});
    await h.$('restoreBackupConfirm').onclick();
    assert.equal(h.calls.filter(call=>call[0]==='restore').length,1,mode);
    assert.deepEqual(h.updates,['clear','memory','events'],mode);
    assert.match(h.$('backupStatus').textContent,/已恢复.*重新打开设置读取/,mode);
    assert.doesNotMatch(h.$('backupStatus').textContent,/记录已重新读取/,mode);
  }
});

test('cancel and file change discard the prior password and preview',async()=>{
  const h=makeHarness(),input=h.$('restoreBackupInput'),form=h.$('restoreBackupForm'),pass=h.$('restoreBackupPassphrase');
  input.files=[{name:'first.bingli',size:1}];input.onchange({target:input});pass.value='fictional secret';
  await form.onsubmit({preventDefault(){}});assert.equal(h.$('restoreBackupConfirm').disabled,false);
  input.files=[{name:'second.bingli',size:1}];input.onchange({target:input});
  assert.equal(pass.value,'');assert.equal(h.$('restoreBackupPreview').classList.contains('hidden'),true);
  assert.equal(h.$('restoreBackupConfirm').disabled,true);assert.match(h.$('restoreBackupFileName').textContent,/second\.bingli/);
  await h.$('restoreBackupConfirm').onclick();assert.equal(h.calls.filter(call=>call[0]==='restore').length,0);
  h.$('restoreBackupCancel').onclick();
  assert.equal(form.classList.contains('hidden'),true);assert.equal(pass.value,'');assert.equal(input.value,'');
  assert.equal(h.$('restoreBackupConfirm').disabled,true);
  assert.equal(h.calls.filter(call=>call[0]==='restore').length,0);
});

test('invalid or damaged preview never restores; password can be re-entered',async()=>{
  let attempts=0;const h=makeHarness({previewBackup:async(file,passphrase)=>{h.calls.push(['preview',file,passphrase]);
    attempts++;if(attempts===1)throw new Error('wrong_passphrase');if(attempts===2)throw new Error('invalid_backup');
    return {archive:{},eventCount:0,mediaCount:0,exportedAt:null};}});
  const input=h.$('restoreBackupInput'),form=h.$('restoreBackupForm'),pass=h.$('restoreBackupPassphrase');
  input.files=[{name:'possibly-damaged.bingli',size:1}];input.onchange({target:input});pass.value='fictional wrong phrase';
  await form.onsubmit({preventDefault(){}});assert.equal(h.calls.filter(call=>call[0]==='restore').length,0);
  assert.equal(pass.value,'');assert.equal(h.$('restoreBackupConfirm').disabled,true);
  pass.value='fictional retry phrase';await form.onsubmit({preventDefault(){}});
  assert.equal(h.calls.filter(call=>call[0]==='restore').length,0);assert.equal(pass.value,'');
  pass.value='fictional retry phrase';await form.onsubmit({preventDefault(){}});
  assert.equal(h.$('restoreBackupConfirm').disabled,false);
  assert.equal(h.calls.filter(call=>call[0]==='restore').length,0);
});

test('restore is single-flight and a failed atomic restore can be retried',async()=>{
  let rejectFirst;const h=makeHarness({restoreBackup:async(preview,passphrase)=>{h.calls.push(['restore',preview,passphrase]);
    if(h.calls.filter(call=>call[0]==='restore').length===1)await new Promise((_,reject)=>{rejectFirst=reject;});
    return {eventCount:3,mediaCount:1};}});
  const input=h.$('restoreBackupInput'),form=h.$('restoreBackupForm'),pass=h.$('restoreBackupPassphrase'),confirm=h.$('restoreBackupConfirm');
  input.files=[{name:'retry.bingli',size:1}];input.onchange({target:input});pass.value='fictional restore phrase';
  await form.onsubmit({preventDefault(){}});
  const first=confirm.onclick();assert.equal(confirm.disabled,true);await confirm.onclick();
  assert.equal(h.calls.filter(call=>call[0]==='restore').length,1);
  rejectFirst(new Error('local_operations_busy'));await first;
  assert.match(h.$('backupStatus').textContent,/正在保存|没有被替换/);
  assert.equal(pass.value,'');assert.equal(confirm.disabled,true);assert.deepEqual(h.updates,[]);
  pass.value='fictional restore phrase';await form.onsubmit({preventDefault(){}});await confirm.onclick();
  assert.equal(h.calls.filter(call=>call[0]==='restore').length,2);assert.deepEqual(h.updates,['clear','memory','events']);
});
