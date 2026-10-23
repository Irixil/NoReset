// Synthetic local API + real AES-GCM over MemoryDocumentStore. Every HTTP call
// is a strict in-process fixture; this is not a browser or model-order claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../frontend/local-store-core.js');
const safety = require('../frontend/safety.js');
const appSource = fs.readFileSync(require.resolve('../frontend/app.js'), 'utf8');
const password = 'synthetic pending questions vault only';
const questions = ['这几天有没有发热？', '这几天有没有气短？', '这几天有没有胸口不舒服？'];
const plain = value => JSON.parse(JSON.stringify(value));
const lines = conversation => conversation.report.sections.flatMap(section => section.lines);
const candidates = conversation => lines(conversation).filter(line => line.candidate_question === true);
const known = (summary, turn) => ({ status: 'known', summary, evidence_turn_ids: [turn.turn_id], context_ids: [] });

async function harness() {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, focus() {},
      classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  let response = () => { throw new Error('No synthetic reply registered'); };
  const context = vm.createContext({
    HealthLocalCore: { ...core, IndexedDbDocumentStore: core.MemoryDocumentStore },
    HealthSafety: safety, indexedDB: {}, crypto: webcrypto, FormData, Blob, URL,
    URLSearchParams, AbortController, setTimeout, clearTimeout, navigator: { storage: {} },
    document: { getElementById: element, querySelector: () => null },
    fetch: async (path, options = {}) => {
      assert.ok(['/api/app/session', '/api/ai/conversation-turn'].includes(path), 'Unexpected HTTP must fail closed');
      calls.push({ path, ...options });
      const body = path === '/api/app/session'
        ? { authenticated: true, csrf_token: 'synthetic-local-only' }
        : response(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/local-store.js'), 'utf8'), context);
  const api = context.HealthLocal;
  await api.vault.setup(password);
  const unlock = async () => {
    const ready = api.initialise();
    await new Promise(setImmediate);
    element('vaultPassphrase').value = password;
    await element('vaultForm').onsubmit({ preventDefault() {} });
    await ready;
  };
  await unlock();
  const request = async (path, body) => {
    const result = await api.request(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Idempotency-Key': webcrypto.randomUUID() }, body: JSON.stringify(body),
    });
    assert.equal(result.r.ok, true, JSON.stringify(result.j));
    return result.j;
  };
  const start = async () => (await request('/api/conversations/start', { mode: 'new', local_date: '2026-10-09' })).conversation;
  const say = async (c, text) => (await request(`/api/conversations/${c.conversation_id}/turns`, { text, expected_version: c.version })).conversation;
  const read = async c => (await request(`/api/conversations/${c.conversation_id}`)).conversation;
  return { api, calls, unlock, request, start, say, read, setResponse(fn) { response = fn; } };
}

function reply(payload, pending, action = 'ask', summary = null) {
  const last = payload.turns.at(-1);
  return {
    provider: 'SyntheticOfflineFixture', model_id: 'synthetic-local-fixture', action,
    assistant_text: action === 'ask' ? pending[0] : '原话已保留，未回答的问题留待核实。',
    question_category: action === 'ask' ? 'associated_symptoms' : null,
    controller: { ...payload.controller, followup_questions: [...questions] },
    completeness: { clinical_state: summary ? { associated_symptoms: known(summary, last) }
      : { associated_symptoms: { status: 'missing', summary: '', evidence_turn_ids: [], context_ids: [] } },
    pending_questions: pending, contradictions: [], relevant_context_ids: [] },
  };
}

async function twoPending(h) {
  h.setResponse(payload => reply(payload, questions));
  let c = await h.say(await h.start(), '纯虚构：咳嗽三天，晚上明显。');
  h.setResponse(payload => reply(payload, questions.slice(1), 'ask', '没有发热'));
  return h.say(c, '纯虚构：没有发热。');
}

function assertPending(c, expected) {
  assert.deepEqual(plain(c.completeness.pending_questions), expected);
  assert.deepEqual(plain(c.report.pending_questions), expected);
  assert.deepEqual(plain(candidates(c).map(line => line.text)), expected);
  for (const line of candidates(c)) {
    assert.equal(line.kind, 'check');
    assert.deepEqual(plain(line.tags), ['助手候选 · 待核实']);
    assert.match(line.source_label, /不是患者陈述/);
    assert.equal(line.source_turn_ids, undefined);
    assert.equal(line.source_context_ids, undefined);
    assert.equal(line.source_versions, undefined);
    assert.ok(c.report.sections.find(section => section.key === 'verification').lines.includes(line));
  }
}

test('a selected earlier assistant reply is bound as versioned context without entering the elder utterance', async () => {
  const h = await harness();
  h.setResponse(payload => reply(payload, questions, 'ask'));
  let c = await h.say(await h.start(), '纯虚构：咳嗽三天。');
  const assistants = c.turns.filter(turn => turn.role === 'assistant' && !turn.superseded);
  const target = assistants[0];
  assert.notEqual(target.turn_id, assistants.at(-1).turn_id, 'the selected reply is older than the latest assistant turn');
  const elderText = '我想追问刚才说的持续时间。';
  let sent;
  h.setResponse(payload => { sent = plain(payload); return reply(payload, questions, 'reply'); });
  const saved = (await h.request(`/api/conversations/${c.conversation_id}/turns`, {
    text: elderText, expected_version: c.version,
    responding_to: { turn_id: target.turn_id, version: target.version, text: target.text },
  })).conversation;
  const newElderTurn = saved.turns.filter(turn => turn.role === 'elder').at(-1);
  assert.equal(newElderTurn.text, elderText);
  assert.equal(newElderTurn.original_text, elderText);
  assert.deepEqual(plain(newElderTurn.responding_to), { turn_id: target.turn_id, text: target.text });
  assert.equal(newElderTurn.responding_to_version, target.version);
  assert.equal(sent.turns.at(-1).text, elderText);
  assert.equal(sent.turns.at(-1).responding_to.turn_id, target.turn_id);
  assert.equal(sent.turns.at(-1).responding_to.text, target.text);
  const event = (await h.request(`/api/events/${newElderTurn.record_id}`)).event;
  assert.equal(event.raw_text, elderText, 'the assistant quote is context only, not copied into the patient record');
});

test('a stale or context-invalidated selected reply is rejected before saving a new patient event', async () => {
  const h = await harness();
  h.setResponse(payload => reply(payload, questions, 'ask'));
  let c = await h.say(await h.start(), '纯虚构：咳嗽三天。');
  const target = c.turns.find(turn => turn.role === 'assistant' && !turn.superseded);
  const endpoint = `/api/conversations/${c.conversation_id}/turns`;
  const request = responding_to => h.api.request(endpoint, { method: 'POST',
    headers: { 'Idempotency-Key': webcrypto.randomUUID() },
    body: JSON.stringify({ text: '我想再问一次。', expected_version: c.version, responding_to }),
  });
  const modelCalls = h.calls.length;
  let result = await request({ turn_id: target.turn_id, version: target.version + 1, text: target.text });
  assert.equal(result.r.status, 409);
  assert.equal(result.j.error, 'followup_target_stale');
  assert.equal(h.calls.length, modelCalls, 'a stale target does not invoke model processing');
  await h.api.vault.put(`conversation:${c.conversation_id}`, { ...c, stale_responding_to_turn_ids: [target.turn_id] });
  result = await request({ turn_id: target.turn_id, version: target.version, text: target.text });
  assert.equal(result.r.status, 409);
  assert.equal(result.j.error, 'followup_target_context_changed');
  assert.equal(h.calls.length, modelCalls, 'an invalidated target is rejected before reply generation');
  const events = await h.api.request('/api/events');
  assert.equal(events.j.events.some(event => event.raw_text === '我想再问一次。'), false);
});

test('selected-reply metadata cannot enter private saved-audio or trial-controlled conversations', async () => {
  const h = await harness();
  h.setResponse(payload => reply(payload, questions, 'ask'));
  const c = await h.say(await h.start(), '纯虚构：咳嗽三天。');
  const target = c.turns.find(turn => turn.role === 'assistant' && !turn.superseded);
  const gated = { ...c, saved_audio_trial: { state: 'completed', grant_id: 'synthetic-private-trial' } };
  await h.api.vault.put(`conversation:${c.conversation_id}`, gated);
  const before = h.calls.length;
  const result = await h.api.request(`/api/conversations/${c.conversation_id}/turns`, { method: 'POST',
    headers: { 'Idempotency-Key': webcrypto.randomUUID() },
    body: JSON.stringify({ text: '不应进入单次试验的追问。', expected_version: c.version,
      responding_to: { turn_id: target.turn_id, version: target.version, text: target.text } }),
  });
  assert.equal(result.r.status, 409);
  assert.equal(result.j.error, 'followup_target_not_allowed');
  assert.equal(h.calls.length, before);
});

test('message actions keep assistant follow-up separate and make only the elder quote editable', () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', value: '', placeholder: '打字说，或者点麦克风',
      dataset: {}, focused: false, classList: { add() { this.added = true; }, remove() { this.removed = true; }, toggle() {} },
      focus() { this.focused = true; }, setSelectionRange(start, end) { this.selection = [start, end]; }, dispatchEvent() {} });
    return elements.get(id);
  };
  const conversation = { conversation_id: 'conversation_synthetic', subject_id: 'subject_self', selected_context_ids: [],
    health_context: [], turns: [
      { turn_id: 'assistant_old', role: 'assistant', action: 'reply', version: 2, text: '请告诉我咳嗽从什么时候开始？' },
      { turn_id: 'elder_old', role: 'elder', source_kind: 'elder', version: 1, text: '刚才说的原话。' },
      { turn_id: 'assistant_latest', role: 'assistant', action: 'reply', version: 1, text: '我已经记下了。' },
    ] };
  const context = vm.createContext({ activeConversation: conversation, pendingFollowupTarget: null, $: element, Event: class Event { constructor(type) { this.type = type; } },
    isMockContent: turn => turn?.is_mock === true, setVoiceComposerEnabled() {}, setVoiceStatus(text) { element('status').textContent = text; },
    escapeHtml: value => String(value), innerWidth: 800, innerHeight: 800,
    document: { addEventListener() {}, querySelector: () => null },
  });
  const start = appSource.indexOf('function closeVoiceTurnMenu('), end = appSource.indexOf('function openVoiceTurnMenu(', start);
  vm.runInContext(appSource.slice(start, end), context);
  assert.equal(vm.runInContext("selectVoiceFollowupTarget('assistant_old')", context), true);
  assert.equal(element('voiceTextInput').value, '', 'assistant wording is not inserted into patient input');
  assert.doesNotMatch(element('voiceFollowupReferenceText').textContent, /第 2 版/);
  assert.equal(vm.runInContext('pendingFollowupTarget.version', context), 2, 'the selected source version stays bound without a permanent label');
  assert.equal(element('voiceTextInput').focused, true);
  assert.equal(vm.runInContext("selectVoiceSupplement('elder_old')", context), true);
  assert.match(element('voiceTextInput').value, /补充我刚才说的原话：“刚才说的原话。”/);
  assert.doesNotMatch(element('voiceTextInput').value, /我已经记下了/);
  assert.equal(element('voiceFollowupReference').classList.added, true);
});

function voiceFollowupUiHarness(){
  const elements=new Map(),apiCalls=[];
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',placeholder:'打字说，或者点麦克风',dataset:{},style:{},
      classList:{hidden:id==='voiceFollowupReference',add(name){if(name==='hidden')this.hidden=true},remove(name){if(name==='hidden')this.hidden=false},toggle(name,force){this.hidden=force}},
      focus(){},setSelectionRange(){},dispatchEvent(){}});
    return elements.get(id);
  };
  const oldReply={turn_id:'assistant_old',role:'assistant',action:'ask',version:2,text:'旧回复：请告诉我持续了几天？',model_context_ids:[]};
  const currentReply={turn_id:'assistant_current',role:'assistant',action:'reply',version:1,text:'新回复：我记下了。',model_context_ids:[]};
  const elderMessage={turn_id:'elder_old',role:'elder',source_kind:'elder',version:1,text:'我这几天不舒服。'};
  const initial={conversation_id:'conversation_followup_ui',subject_id:'subject_self',version:4,status:'active',
    selected_context_ids:['context_keep'],health_context:[{context_id:'context_keep'}],turns:[oldReply,currentReply,elderMessage]};
  const context=vm.createContext({activeConversation:initial,pendingFollowupTarget:null,activeHealthSubjectId:'subject_self',
    healthSubjectSwitchBusy:false,healthSubjectChanged:false,healthSubjectUiEpoch:0,saveBusy:false,pendingConversationTurn:null,window:{dispatchEvent(){}},
    pendingCorrectionReview:null,pendingMediaRetry:null,conversationEditingTurnId:null,voicePermissionGeneration:0,lastSpokenTurnId:null,
    crypto:webcrypto,speechSynthesis:{cancel(){}},setTimeout,clearTimeout,$ : element,
    document:{querySelector:()=>null},Event:class Event{constructor(type){this.type=type}},
    isMockContent:turn=>turn?.is_mock===true,renderVoiceConversation(){},renderConversationReport(){},updateHealthContextButton(){},
    setVoiceComposerEnabled(){},updateHealthSubjectLabels(){},speakAssistant(){},setVoiceStatus(text){element('voiceConversationStatus').textContent=text},
    async loadEvents(){},async api(path,options={}){
      apiCalls.push({path,options,body:options.body?JSON.parse(options.body):null});
      const saved={...context.activeConversation,version:context.activeConversation.version+1,
        turns:[...context.activeConversation.turns,{turn_id:'elder_sent',role:'elder',text:context.activeConversationDraft||'',version:1},
          {turn_id:'assistant_after_send',role:'assistant',action:'reply',text:'已收到。',version:1}]};
      return {r:{ok:true,status:200},j:{conversation:saved,ai_failed:false}};
    },
  });
  const followupStart=appSource.indexOf('function followupTargetTurn('),followupEnd=appSource.indexOf('function openVoiceTurnMenu(',followupStart);
  vm.runInContext(appSource.slice(followupStart,followupEnd),context);
  const syncStart=appSource.indexOf('function syncConversation('),syncEnd=appSource.indexOf('function conversationHasPendingReply(',syncStart);
  vm.runInContext(appSource.slice(syncStart,syncEnd),context);
  const sendStart=appSource.indexOf('async function submitConversationText('),sendEnd=appSource.indexOf('function escapeHtml(',sendStart);
  vm.runInContext(appSource.slice(sendStart,sendEnd),context);
  return {context,elements,apiCalls,initial,oldReply,currentReply,elderMessage};
}

test('same-conversation sync preserves invalid reply references and repeated sends make no request',async t=>{
  const changes={
    superseded(conversation,target){target.superseded=true},
    version_changed(conversation,target){target.version++},
    background_revoked(conversation,target){target.model_context_ids=['context_keep'];conversation.selected_context_ids=[];conversation.health_context=[]},
  };
  for(const [name,change] of Object.entries(changes))await t.test(name,async()=>{
    const h=voiceFollowupUiHarness(),draft='我想追问：还会不会咳？';
    assert.equal(h.context.selectVoiceFollowupTarget(h.oldReply.turn_id),true);
    h.elements.get('voiceTextInput').value=draft;
    const updated=plain(h.initial);change(updated,updated.turns[0]);updated.version++;
    assert.equal(h.context.syncConversation(updated,{speak:false}),true);
    assert.equal(h.context.pendingFollowupTarget.invalid,true,'target stays bound but becomes invalid');
    assert.equal(h.elements.get('voiceFollowupReference').classList.hidden,false);
    assert.match(h.elements.get('voiceFollowupReferenceText').textContent,/原话已变化/);
    assert.equal(h.elements.get('voiceTextInput').value,draft,'assistant wording never enters patient draft');
    await h.context.saveVoiceSupplement();
    await h.context.saveVoiceSupplement();
    assert.equal(h.apiCalls.length,0,'two consecutive send attempts are stopped before any request');
    assert.equal(h.elements.get('voiceTextInput').value,draft);
    assert.equal(h.context.pendingFollowupTarget.invalid,true);
  });
});

test('cancel or reselect explicitly releases an invalid reply reference before sending',async()=>{
  const cancelled=voiceFollowupUiHarness(),cancelDraft='我想补充这句。';
  assert.equal(cancelled.context.selectVoiceFollowupTarget(cancelled.oldReply.turn_id),true);
  cancelled.elements.get('voiceTextInput').value=cancelDraft;
  const stale=plain(cancelled.initial);stale.turns[0].superseded=true;stale.version++;
  cancelled.context.syncConversation(stale,{speak:false});
  await cancelled.context.saveVoiceSupplement();
  assert.equal(cancelled.apiCalls.length,0);
  cancelled.context.clearVoiceFollowupTarget();
  assert.equal(cancelled.context.pendingFollowupTarget,null);
  await cancelled.context.saveVoiceSupplement();
  assert.equal(cancelled.apiCalls.length,1,'explicit cancellation permits an ordinary send');
  assert.equal(cancelled.apiCalls[0].body.quote_ref,undefined);
  assert.equal(cancelled.apiCalls[0].body.text,cancelDraft);

  const reselected=voiceFollowupUiHarness(),reselectedDraft='我想继续追问新回复。';
  assert.equal(reselected.context.selectVoiceFollowupTarget(reselected.oldReply.turn_id),true);
  reselected.elements.get('voiceTextInput').value=reselectedDraft;
  const refreshed=plain(reselected.initial);refreshed.turns[0].version++;refreshed.version++;
  reselected.context.syncConversation(refreshed,{speak:false});
  await reselected.context.saveVoiceSupplement();
  assert.equal(reselected.apiCalls.length,0);
  assert.equal(reselected.context.selectVoiceFollowupTarget(reselected.currentReply.turn_id),true);
  assert.equal(reselected.elements.get('voiceTextInput').value,reselectedDraft);
  assert.equal(reselected.elements.get('voiceTextInput').value.includes(reselected.oldReply.text),false);
  await reselected.context.saveVoiceSupplement();
  assert.equal(reselected.apiCalls.length,1,'explicit re-selection permits a bound follow-up');
  assert.deepEqual(plain(reselected.apiCalls[0].body.quote_ref),{
    turn_id:reselected.currentReply.turn_id,version:reselected.currentReply.version,
  });
  assert.equal(reselected.apiCalls[0].body.text,reselectedDraft);
});

test('switching conversation or owner clears the prior reply reference',()=>{
  const h=voiceFollowupUiHarness();
  assert.equal(h.context.selectVoiceFollowupTarget(h.oldReply.turn_id),true);
  const other=plain(h.initial);other.conversation_id='conversation_other';other.version++;
  h.context.syncConversation(other,{speak:false});
  assert.equal(h.context.pendingFollowupTarget,null);
  assert.equal(h.elements.get('voiceFollowupReference').classList.hidden,true);
  assert.equal(h.context.selectVoiceFollowupTarget(h.oldReply.turn_id),true);
  const differentOwner=plain(other);differentOwner.subject_id='subject_family';
  h.context.syncConversation(differentOwner,{speak:false});
  assert.equal(h.context.pendingFollowupTarget,null);
  assert.equal(h.elements.get('voiceFollowupReference').classList.hidden,true);
});

test('own and assistant messages can be quoted without putting quoted text in the draft or legacy answer binding',async()=>{
  const h=voiceFollowupUiHarness(),draft='我想问这句话是什么意思。';
  assert.equal(h.apiCalls.length,0);
  assert.equal(h.context.selectVoiceFollowupTarget('elder_old'),true,'the elder message can be quoted');
  assert.equal(h.elements.get('voiceTextInput').value,'','selecting a quote does not edit the draft');
  h.elements.get('voiceTextInput').value=draft;h.context.activeConversationDraft=draft;
  await h.context.saveVoiceSupplement();
  assert.equal(h.apiCalls.length,1);
  assert.deepEqual(plain(h.apiCalls[0].body.quote_ref),{turn_id:'elder_old',version:1});
  assert.equal(h.apiCalls[0].body.responding_to,undefined);
  assert.equal(h.apiCalls[0].body.text,draft);

  const shortcut=voiceFollowupUiHarness();
  assert.equal(shortcut.context.selectVoiceFollowupTarget(shortcut.oldReply.turn_id),true);
  assert.equal(shortcut.apiCalls.length,0,'selecting the quote alone never calls the model');
  shortcut.elements.get('voiceTextInput').value='我还没发送的草稿';
  await shortcut.context.sendVoiceQuoteShortcut('解释一下');
  assert.equal(shortcut.apiCalls.length,1,'the explicit shortcut click sends exactly once');
  assert.deepEqual(plain(shortcut.apiCalls[0].body.quote_ref),{turn_id:shortcut.oldReply.turn_id,version:shortcut.oldReply.version});
  assert.equal(shortcut.apiCalls[0].body.text,'解释一下');
  assert.equal(shortcut.elements.get('voiceTextInput').value,'我还没发送的草稿','sending a shortcut preserves the separate unsent draft');
});

test('copy and replay restore focus to the originating message after the menu closes', async () => {
  for (const action of ['copy', 'replay']) {
    let menuActions = [], copied = 0, replayed = 0, focused = 0;
    const turn = { turn_id: 'assistant_focus', role: 'assistant', action: 'reply', text: '请告诉我持续了几天？', version: 1 };
    const node = { dataset: { voiceTurn: turn.turn_id }, isConnected: true, focus() { focused++; } };
    const button = turnAction => ({ dataset: { turnMenuAction: turnAction }, focus() {}, onclick: null });
    const menu = { classList: { add() {}, remove() {}, contains: () => false }, style: {},
      replaceChildren() { menuActions = []; }, getBoundingClientRect: () => ({ width: 100, height: 60 }),
      querySelectorAll: () => menuActions, querySelector: () => ({ focus() {} }) };
    Object.defineProperty(menu, 'innerHTML', { set(value) {
      menuActions = [...value.matchAll(/data-turn-menu-action="([^"]+)"/g)].map(match => button(match[1]));
    } });
    const context = vm.createContext({ activeConversation: { turns: [turn] }, pendingFollowupTarget: null,
      voiceTurnMenuFocus: null, $: id => id === 'voiceTurnMenu' ? menu : null,
      turnById: id => id === turn.turn_id ? turn : null, isMockContent: () => false,
      followupTargetTurn: () => turn, voiceSupplementTurn: () => false,
      innerWidth: 800, innerHeight: 800, navigator: { clipboard: { writeText: async () => { copied++; } } },
      toast() {}, speakAssistant: () => { replayed++; }, document: {} });
    const start = appSource.indexOf('function closeVoiceTurnMenu('), end = appSource.indexOf('function bindVoiceTurnMenus(', start);
    vm.runInContext(appSource.slice(start, end), context);
    context.openVoiceTurnMenu(node, 20, 20);
    await menuActions.find(item => item.dataset.turnMenuAction === action).onclick();
    assert.equal(focused, 1, `${action} restores focus to the original message`);
    assert.equal(copied, action === 'copy' ? 1 : 0);
    assert.equal(replayed, action === 'replay' ? 1 : 0);
  }
});

test('candidate history persists and transfers while doctor pending questions decrease 2 → 1 → 0', async () => {
  const h = await harness();
  let c = await twoPending(h);
  assertPending(c, questions.slice(1));
  assert.equal(lines(c).some(line => line.kind === 'summary' && /气短|胸口/.test(line.text)), false);
  assert.ok(lines(c).some(line => line.kind === 'summary' && line.text === '没有发热'));
  const originalSources = plain(c.analysis_sources);
  const calls = h.calls.length;
  const saved = await h.read(c);
  assertPending(saved, questions.slice(1));
  assert.deepEqual(plain(saved.controller.followup_questions), questions);
  assert.deepEqual(plain(saved.analysis_sources), originalSources);
  assert.equal(h.calls.length, calls, 'GET does not call the model');

  h.setResponse(payload => {
    assert.deepEqual(payload.controller.followup_questions, questions);
    assert.equal(payload.turns.at(-1).responding_to.text, questions[1]);
    return reply(payload, questions.slice(2), 'ask', '没有气短');
  });
  c = await h.say(c, '纯虚构：没有气短。');
  assertPending(c, questions.slice(2));
  h.setResponse(payload => {
    assert.equal(payload.turns.at(-1).responding_to.text, questions[2]);
    return reply(payload, [], 'finish', '没有胸口不舒服');
  });
  c = await h.say(c, '纯虚构：没有胸口不舒服，先这样。');
  assertPending(c, []);
  assert.deepEqual(plain(c.controller.followup_questions), questions, 'Answered candidates remain candidate history');
  assert.equal(c.turns.at(-1).action, 'finish');
  assert.equal(c.turns.filter(turn => turn.role === 'elder').length, 4);
});

test('pending candidates survive lock/unlock and encrypted backup restore into an empty vault', async () => {
  const h = await harness(), c = await twoPending(h), calls = h.calls.length;
  const expected = plain(c);
  const docs = await h.api.vault.driver.listDocs();
  assert.equal(JSON.stringify(docs).includes(questions[1]), false, 'No plaintext candidate in encrypted documents');
  h.api.lock();
  await assert.rejects(h.api.vault.get('conversation:' + c.conversation_id), /vault_locked/);
  await h.unlock();
  assert.deepEqual(plain(await h.read(c)), expected);
  assert.equal(h.calls.length, calls);
  const archive = await h.api.vault.exportArchive();
  assert.equal(JSON.stringify(archive).includes(questions[1]), false);
  const fresh = await harness();
  assert.deepEqual(await fresh.api.vault.list('conversation:'), []);
  const file = new Blob([JSON.stringify(archive)]);
  const preview = await fresh.api.previewBackup(file, password);
  await fresh.api.restoreBackup(preview, password);
  const restored = await fresh.read(c);
  assert.deepEqual(plain(restored), expected);
  assertPending(restored, questions.slice(1));
  assert.equal(fresh.calls.length, 0, 'Fresh restore and GET use no network');
  const handoff = (await fresh.request('/api/handoffs', { record_ids: c.turns.filter(turn => turn.role === 'elder').map(turn => turn.record_id) })).handoff;
  assertPending({ ...restored, report: handoff.conversation_reports[0].report }, questions.slice(1));
  assert.deepEqual(plain(handoff.conversation_reports[0].completeness.pending_questions), questions.slice(1));
  assert.equal(fresh.calls.length, 0, 'Handoff uses no network');
});

test('unknown at explicit finish retains candidates as unanswered and never invents a denial', async () => {
  const h = await harness();
  h.setResponse(payload => reply(payload, questions));
  let c = await h.say(await h.start(), '纯虚构：咳嗽三天。');
  h.setResponse(payload => reply(payload, questions, 'finish'));
  c = await h.say(c, '纯虚构：我不清楚，先这样。');
  assertPending(c, questions);
  assert.equal(c.turns.at(-1).action, 'finish');
  assert.equal(c.completeness.clinical_state.associated_symptoms.status, 'missing');
  assert.equal(lines(c).some(line => line.kind === 'summary'), false);
  const patientFacts = lines(c).filter(line => !line.candidate_question).map(line => line.text)
    .concat(c.report.transcript.filter(turn => turn.role === 'elder').map(turn => turn.text)).join('\n');
  assert.doesNotMatch(patientFacts, /没有发热|没有气短|没有胸口|一切正常|信息已完整/);
  assert.ok(c.report.transcript.some(turn => turn.text === '纯虚构：我不清楚，先这样。'));
});

test('pending-only changes and legacy or mistagged candidate caches rebuild locally without changing sources', async () => {
  const h = await harness(), c = await twoPending(h), calls = h.calls.length;
  const key = 'conversation:' + c.conversation_id;
  const changed = plain(c);
  changed.completeness.pending_questions = questions.slice(2);
  await h.api.vault.put(key, changed);
  const reduced = await h.read(c);
  assertPending(reduced, questions.slice(2));
  assert.equal(reduced.report.report_id, c.report.report_id);
  assert.equal(reduced.report.version, c.report.version + 1);
  assert.deepEqual(plain(reduced.analysis_sources), plain(c.analysis_sources));
  assert.deepEqual(plain(reduced.turns), plain(c.turns));
  const legacy = plain(reduced);
  delete legacy.report.pending_questions;
  legacy.report.sections.forEach(section => { section.lines = section.lines.filter(line => !line.candidate_question); });
  await h.api.vault.put(key, legacy);
  const migrated = await h.read(c);
  assertPending(migrated, questions.slice(2));
  const mislabeled = plain(migrated);
  candidates(mislabeled)[0].tags = ['患者阳性'];
  await h.api.vault.put(key, mislabeled);
  const repaired = await h.read(c);
  assertPending(repaired, questions.slice(2));
  assert.doesNotMatch(repaired.report.body, /患者阳性/);
  const misplaced = plain(repaired);
  const candidate = candidates(misplaced)[0];
  misplaced.report.sections.find(section => section.key === 'verification').lines =
    misplaced.report.sections.find(section => section.key === 'verification').lines.filter(line => !line.candidate_question);
  misplaced.report.sections.unshift({ key: 'chief_complaint', title: '主要不适', lines: [
    { ...candidate, source_turn_ids: [c.turns.find(turn => turn.role === 'elder').turn_id] },
  ] });
  await h.api.vault.put(key, misplaced);
  const confined = await h.read(c);
  assertPending(confined, questions.slice(2));
  assert.deepEqual(plain(confined.turns), plain(c.turns));
  await h.api.vault.put(key, confined);
  assert.equal((await h.read(c)).report.version, confined.report.version, 'Current pending cache is reused');
  assert.equal(h.calls.length, calls);
});

test('edited source versions invalidate clinical analysis while independent candidate history remains explicitly scoped', async () => {
  const h = await harness(), c = await twoPending(h), calls = h.calls.length;
  const key = 'conversation:' + c.conversation_id;
  for (const change of ['version', 'quote', 'missing-binding']) {
    const changed = plain(c);
    const elder = changed.turns.find(turn => turn.role === 'elder');
    if (change === 'version') elder.version += 1;
    if (change === 'quote') elder.text = '纯虚构：头晕，原说法已纠正。';
    if (change === 'missing-binding') delete changed.analysis_sources;
    await h.api.vault.put(key, changed);
    const current = await h.read(c);
    assert.equal(current.completeness, null, change);
    const expected = change === 'missing-binding' ? questions.slice(1) : questions;
    assert.deepEqual(plain(current.report.pending_questions), expected, change);
    assert.equal(candidates(current).length, expected.length, change);
    assert.equal(lines(current).some(line => line.kind === 'summary'), false, 'Old clinical summary cannot survive');
    assert.equal(current.report.question_coverage.kind, 'assistant_question_coverage_not_clinical_facts');
    if (change !== 'missing-binding') {
      assert.deepEqual(plain(current.report.question_coverage.historical_scope_questions), questions);
      assert.ok(candidates(current).every(line => /历史.*重新核实/.test(line.tags[0])
        && /未确认与当前主诉相关/.test(line.source_label)));
    } else assert.deepEqual(plain(current.report.question_coverage.resolved_questions.map(item => item.question)), [questions[0]],
      'Missing clinical binding does not erase an actual literal answer');
    assert.deepEqual(plain(current.controller.followup_questions), questions, 'Stored candidate history is not a current patient fact');
    assert.ok(current.report.transcript.some(turn => turn.text === elder.text && turn.version === elder.version));
  }
  assert.equal(h.calls.length, calls);
});

test('a selected background version change invalidates clinical analysis and marks retained candidates historical', async () => {
  const h = await harness();
  const entry = (await h.request('/api/health-context', { fields: { conditions: ['纯虚构：已确认旧背景'] } })).health_context.entries[0];
  let c = await h.start();
  c = (await h.request(`/api/conversations/${c.conversation_id}/context`, { context_ids: [entry.context_id] })).conversation;
  h.setResponse(payload => reply(payload, questions));
  c = await h.say(c, '纯虚构：咳嗽三天。');
  assertPending(c, questions);
  const calls = h.calls.length;
  await h.request('/api/health-context', { fields: { conditions: ['纯虚构：已确认新背景'] } });
  const changed = await h.read(c);
  assert.equal(changed.completeness, null);
  assert.equal(candidates(changed).length, questions.length);
  assert.deepEqual(plain(changed.report.pending_questions), questions);
  assert.deepEqual(plain(changed.report.question_coverage.historical_scope_questions), questions);
  assert.ok(candidates(changed).every(line => /历史.*重新核实/.test(line.tags[0])
    && /未确认与当前主诉相关/.test(line.source_label)));
  assert.equal(lines(changed).some(line => line.kind === 'summary'), false);
  assert.equal(h.calls.length, calls);
});

test('untrusted candidate strings are bounded, deduplicated and confined to unanswered metadata', async () => {
  const h = await harness(), safe = '是否记得上次描述的时间？';
  const invalid = [null, { text: questions[1] }, '<script>alert(1)</script>？', '第一项？第二项？',
    '您应该服用两片药吗？', 'x'.repeat(160) + '？', '是否\u0000记得？', '是否\u200b记得？', '无问号'];
  h.setResponse(payload => ({ ...reply(payload, [], 'finish'),
    completeness: { clinical_state: {}, pending_questions: [safe, safe, ...invalid], contradictions: [] } }));
  let c = await h.say(await h.start(), '纯虚构：今天不舒服，情况待核对。');
  assert.deepEqual(plain(c.report.pending_questions), [safe]);
  assert.deepEqual(plain(candidates(c).map(line => line.text)), [safe]);
  assert.doesNotMatch(c.report.body, /<script>|服用两片|第一项|患者阳性/);
  const source = plain(c);
  source.completeness.pending_questions = Array(13).fill(safe);
  await h.api.vault.put('conversation:' + c.conversation_id, source);
  c = await h.read(c);
  assert.deepEqual(plain(c.report.pending_questions), [], 'Oversized metadata fails closed');
  assert.equal(candidates(c).length, 0);
});
