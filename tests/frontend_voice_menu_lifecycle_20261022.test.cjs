const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');

function harness() {
  const turns = [
    { turn_id: 'elder_old', role: 'elder', source_kind: 'elder', text: '旧消息', version: 1 },
    { turn_id: 'elder_new', role: 'elder', source_kind: 'elder', text: '新消息', version: 1 },
  ];
  const timers = new Map(), callbacks = new Map();
  let nextTimer = 1, visible = false, focusCalls = 0;
  const nodeFor = turn => {
    const listeners = new Map();
    return {
      dataset: { voiceTurn: turn.turn_id }, isConnected: true, listeners,
      addEventListener(type, listener, options) { const list = listeners.get(type)||[];list.push({listener,options});listeners.set(type,list); },
      dispatch(type, event) { for (const item of listeners.get(type)||[]) item.listener(event); },
      focus() { focusCalls++; }, getBoundingClientRect: () => ({ left: 20, bottom: 180 }),
    };
  };
  const menu = {
    style: {}, classList: {
      add() { visible = false; }, remove() { visible = true; }, contains() { return !visible; },
    },
    replaceChildren() {}, getBoundingClientRect: () => ({ width: 260, height: 180 }),
    querySelectorAll: () => [], querySelector: () => ({ focus() {} }),
  };
  let nodes = turns.map(nodeFor), html = '';
  const testViews=['voiceView','homeView'].map(id=>({id,classList:{toggle(){}},setAttribute(){},querySelector:()=>null}));
  const box = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      nodes.forEach(node => { node.isConnected = false; });
      nodes = turns.map(nodeFor);
    },
    insertAdjacentHTML(position, value) { assert.equal(position,'beforeend');html+=value; },
    querySelectorAll(selector) { return selector === '[data-voice-turn]' ? nodes : []; },
    querySelector() { return null; },
  };
  const conversation = { conversation_id: 'conversation_test', turns };
  const context = vm.createContext({
    activeConversation: conversation, pendingConversationTurn: null, conversationLoadSequence: 0, conversationLoading: false,
    viewNavigationSerial: 0, pendingConversationDetailOpen: null,
    pendingAudioReviewCandidates: [], pendingAudioReview: null, saveBusy: false,
    conversationEditingTurnId: null, activeHealthSubjectId: 'subject_self',
    $: id => id === 'voiceTurnMenu' ? menu : id === 'voiceConversationTurns' ? box : id === 'voiceConversation' ? { scrollHeight: 0, scrollTo() {} } : null,
    turnById: id => turns.find(turn => turn.turn_id === id), isMockContent: () => false,
    legacyAudioNeedsExplicitRecovery: () => false, voiceTurnHtml: turn => `<article>${turn.text}${turn.quote_context_valid===false?'<small>原消息已变化，引用已失效。</small>':''}</article>`,
    voiceAudioMessageHtml:()=>'',trialVoiceMessage:()=>'',bindConversationSourceActions() {}, escapeHtml: value => String(value), reducedMotion: () => true,
    document: { addEventListener() {}, querySelector: selector => selector==='.view.active'?testViews.find(view=>view.id==='voiceView'):selector==='.app-shell'?{classList:{toggle(){}}}:null, querySelectorAll:()=>[] },
    window: { requestAnimationFrame: fn => fn(), scrollTo() {} },
    views: testViews,
    mediaRecorder: null, voicePermissionPending: false, voiceUploadPending: false,
    pauseConversation() {}, clearRecordPanels() {}, renderHome() {}, loadEvents() {},
    innerWidth: 390, innerHeight: 844,
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); callbacks.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const start = appSource.indexOf('let voiceTurnMenuFocus=');
  const end = appSource.indexOf('async function retryPendingAudioReply(', start);
  const helperStart=appSource.indexOf('function latestEditableOwnTurn('),helperEnd=appSource.indexOf('\nasync function speakAssistant(',helperStart);
  vm.runInContext(appSource.slice(helperStart,helperEnd),context);
  vm.runInContext(appSource.slice(start, end), context);
  const showStart = appSource.indexOf('function showView('), showEnd = appSource.indexOf('\n}\n', showStart)+2;
  vm.runInContext(appSource.slice(showStart, showEnd), context);
  context.bindVoiceTurnMenus(box);
  const touch = (x=30,y=60) => ({ target: { closest: () => null }, touches: [{ clientX: x, clientY: y }] });
  return {
    context, box, menu, timers, callbacks,
    node(id) { return nodes.find(node => node.dataset.voiceTurn === id); },
    replaceTurns(next) { turns.splice(0,turns.length,...next); },
    touch, fireTimer(id) { timers.delete(id); callbacks.get(id)(); },
    get visible() { return visible; }, get focusCalls() { return focusCalls; },
  };
}

test('long-press timers cannot outlive message redraw or close by stealing focus', () => {
  const h = harness(), oldNode = h.node('elder_old'), currentNode = h.node('elder_new');
  h.context.bindVoiceTurnMenus(h.box);
  assert.equal(typeof oldNode.ontouchstart,'undefined','touch is registered as a listener rather than a plain property');
  assert.equal(oldNode.listeners.get('touchstart').length,1,'duplicate binding does not register duplicate touch handlers');
  assert.equal(oldNode.listeners.get('touchstart')[0].options.passive,true);
  oldNode.dispatch('touchstart',h.touch());
  const oldTimer = [...h.timers.keys()][0];
  currentNode.dispatch('touchstart',h.touch());
  const currentTimer = [...h.timers.keys()][0];
  assert.notEqual(currentTimer, oldTimer);
  assert.equal(h.timers.has(oldTimer), false, 'the next long-press clears the previous timer');

  h.callbacks.get(oldTimer)();
  assert.equal(h.visible, false, 'a queued stale callback cannot open the menu');
  assert.equal(h.timers.has(currentTimer), true, 'a stale callback cannot overwrite the new timer');
  h.fireTimer(currentTimer);
  assert.equal(h.visible, true, 'a stationary hold still opens the menu');

  h.context.closeVoiceTurnMenu(false);
  currentNode.dispatch('touchstart',h.touch());
  const movingTimer = [...h.timers.keys()][0];
  currentNode.dispatch('touchmove',h.touch(45,60));
  assert.equal(h.timers.has(movingTimer),false,'movement over 10px cancels the hold');
  h.callbacks.get(movingTimer)();
  assert.equal(h.visible,false);
  currentNode.dispatch('touchstart',h.touch());
  const endedTimer=[...h.timers.keys()][0];
  currentNode.dispatch('touchend',h.touch());
  assert.equal(h.timers.has(endedTimer),false,'ending touch cancels the hold');
  h.callbacks.get(endedTimer)();
  assert.equal(h.visible,false);

  currentNode.oncontextmenu({preventDefault(){},clientX:30,clientY:60});
  currentNode.dispatch('touchstart',h.touch());
  const redrawTimer = [...h.timers.keys()][0];
  const focusBeforeRedraw = h.focusCalls;
  h.context.renderVoiceConversation();
  assert.equal(oldNode.isConnected, false);
  assert.equal(currentNode.isConnected, false);
  assert.equal(h.timers.has(redrawTimer), false, 'redrawing cancels the pending long-press');
  assert.equal(h.visible, false, 'redrawing closes the menu for the removed message');
  assert.equal(h.focusCalls, focusBeforeRedraw, 'redraw does not restore focus to the removed node');

  h.callbacks.get(redrawTimer)();
  assert.equal(h.visible, false, 'a delayed callback for a detached node stays closed');
  assert.equal(h.focusCalls, focusBeforeRedraw);

  const replacement=h.node('elder_old');
  replacement.oncontextmenu({preventDefault(){},clientX:30,clientY:60});
  replacement.dispatch('touchstart',h.touch());
  const switchTimer=[...h.timers.keys()][0];
  const focusBeforeSwitch=h.focusCalls;
  assert.equal(h.context.showView('homeView'),true);
  assert.equal(h.timers.has(switchTimer),false,'changing views cancels the active hold');
  assert.equal(h.visible,false,'changing views closes the menu');
  assert.equal(h.focusCalls,focusBeforeSwitch,'changing views does not restore focus to a stale message');
});

test('appending auxiliary conversation cards preserves the original message menu handlers', () => {
  const h=harness(),audioTurn={turn_id:'elder_audio',role:'elder',source_kind:'audio_transcript',audio_source_status:'machine_transcribed',
    text:'合成音频原话',version:1,quote_context:{turn_id:'assistant_old',role:'assistant',version:1,text:'旧回复'},quote_context_valid:true};
  h.replaceTurns([audioTurn]);
  h.context.activeConversation.manual_correction_analysis_pending=true;
  h.context.pendingAudioReviewCandidates=[{conversation_id:'conversation_test',media_id:'media_fixture',recovery_text:'合成恢复文字',version:1}];
  h.context.pendingAudioReview={conversation_id:'conversation_test',text:'合成待核对文字',played:false,reviewed:false,busy:false,confirmed:false};
  h.context.activeConversation.trial_control={state:'review_required'};
  h.context.renderVoiceConversation();
  const node=h.node('elder_audio');
  assert.equal(node.isConnected,true);
  assert.equal(typeof node.oncontextmenu,'function','right-click and keyboard menu handler survives appended cards');
  assert.equal(node.listeners.get('touchstart')?.length,1,'long-press menu handler survives appended cards');
  assert.match(h.box.innerHTML,/data-audio-explicit-retry/,'valid current quote retains its explicit reply action');
});

test('a machine-transcribed elder turn with an invalid quote has no explicit reply retry', () => {
  const h=harness(),audioTurn={turn_id:'elder_audio_invalid_quote',role:'elder',source_kind:'audio_transcript',audio_source_status:'user_edited',
    text:'合成音频原话',version:1,quote_context:{turn_id:'assistant_superseded',role:'assistant',version:1,text:'已失效的旧回复'},quote_context_valid:false};
  h.replaceTurns([audioTurn]);
  h.context.renderVoiceConversation();
  assert.match(h.box.innerHTML,/原消息已变化，引用已失效。/,'the existing invalid-reference display remains visible');
  assert.doesNotMatch(h.box.innerHTML,/data-audio-explicit-retry|继续请求一次回复/,'the invalid quote cannot be sent again');
});

test('the existing select-text menu action still selects the message text without restoring focus', async () => {
  const turn = { turn_id: 'elder_select', role: 'elder', source_kind: 'elder', text: '要选取的原话', version: 1 };
  let selectedNode = null, addedRange = null, removedRanges = 0, focusCalls = 0, actions = [];
  const textNode = {};
  const node = { dataset: { voiceTurn: turn.turn_id }, isConnected: true, querySelector: () => textNode,
    focus() { focusCalls++; } };
  const button = action => ({ dataset: { turnMenuAction: action }, focus() {}, onclick: null });
  const menu = { style: {}, classList: { add() {}, remove() {}, contains: () => false }, replaceChildren() { actions = []; },
    getBoundingClientRect: () => ({ width: 200, height: 100 }), querySelectorAll: () => actions,
    querySelector: () => ({ focus() {} }),
  };
  Object.defineProperty(menu, 'innerHTML', { set(value) {
    actions = [...value.matchAll(/data-turn-menu-action="([^"]+)"/g)].map(match => button(match[1]));
  } });
  const range = { selectNodeContents(value) { selectedNode = value; } };
  const selection = { removeAllRanges() { removedRanges++; }, addRange(value) { addedRange = value; } };
  const context = vm.createContext({ activeConversation: { turns: [turn] }, $: id => id === 'voiceTurnMenu' ? menu : null,
    turnById: id => id === turn.turn_id ? turn : null, isMockContent: () => false, innerWidth: 800, innerHeight: 800,
    document: { createRange: () => range }, window: { getSelection: () => selection }, escapeHtml: String });
  const helperStart=appSource.indexOf('function latestEditableOwnTurn('),helperEnd=appSource.indexOf('\nasync function speakAssistant(',helperStart);
  vm.runInContext(appSource.slice(helperStart,helperEnd),context);
  const start = appSource.indexOf('let voiceTurnMenuFocus='), end = appSource.indexOf('function renderVoiceConversation(', start);
  vm.runInContext(appSource.slice(start, end), context);
  context.openVoiceTurnMenu(node, 20, 20);
  await actions.find(item => item.dataset.turnMenuAction === 'select').onclick();
  assert.equal(selectedNode, textNode);
  assert.equal(removedRanges, 1);
  assert.equal(addedRange, range);
  assert.equal(focusCalls, 0, 'selection keeps the existing focus behavior');
});

test('older own messages do not show an edit action, while the newest own message does', () => {
  const turns=[
    {turn_id:'elder_old',role:'elder',source_kind:'elder',text:'较早原话',version:1},
    {turn_id:'assistant_reply',role:'assistant',text:'合成回复',action:'reply',version:1},
    {turn_id:'elder_new',role:'elder',source_kind:'elder',text:'最新原话',version:1},
  ];
  const conversation={turns};
  const getActions=turn=>{
    let actions=[];
    const node={dataset:{voiceTurn:turn.turn_id},isConnected:true,focus(){}};
    const button=action=>({dataset:{turnMenuAction:action},focus(){},onclick:null});
    const menu={style:{},classList:{add(){},remove(){},contains:()=>false},replaceChildren(){actions=[]},
      getBoundingClientRect:()=>({width:200,height:100}),querySelectorAll:()=>actions,querySelector:()=>({focus(){}})};
    Object.defineProperty(menu,'innerHTML',{set(value){actions=[...value.matchAll(/data-turn-menu-action="([^"]+)"/g)].map(match=>button(match[1]))}});
    const context=vm.createContext({activeConversation:conversation,$:id=>id==='voiceTurnMenu'?menu:null,
      turnById:id=>turns.find(item=>item.turn_id===id),isMockContent:()=>false,innerWidth:800,innerHeight:800,
      document:{},window:{},escapeHtml:String});
    const helperStart=appSource.indexOf('function latestEditableOwnTurn('),helperEnd=appSource.indexOf('\nasync function speakAssistant(',helperStart);
    vm.runInContext(appSource.slice(helperStart,helperEnd),context);
    const start=appSource.indexOf('let voiceTurnMenuFocus='),end=appSource.indexOf('function renderVoiceConversation(',start);
    vm.runInContext(appSource.slice(start,end),context);
    context.openVoiceTurnMenu(node,20,20);
    return actions.map(item=>item.dataset.turnMenuAction);
  };
  assert.equal(getActions(turns[0]).includes('edit'),false);
  assert.equal(getActions(turns[2]).includes('edit'),true);
});

test('the fixed message menu lives outside the overflow-clipped application shell', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../frontend/styles.css'), 'utf8');
  const shellStart = markup.indexOf('<div class="app-shell">');
  const shellEnd = markup.indexOf('</nav>\n  </div>', shellStart);
  const menu = markup.indexOf('<div id="voiceTurnMenu"');
  assert.ok(shellStart >= 0 && shellEnd > shellStart && menu > shellEnd, 'the menu is a body-level sibling after the app shell');
  assert.match(styles, /\.voice-turn-menu\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*1200/);
});
