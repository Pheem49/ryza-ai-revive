/* Dialogue Session headless regression: verifies turn lifecycle, cancellation
   epochs, stamina deductions, history tracking, and error paths through Session
   without a DOM. Run: node scripts/dialogue_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

let failures = 0;
function bad(msg) { failures++; console.log('  FAIL ' + msg); }
function ok(cond, name) { if (cond) console.log('  PASS ' + name); else bad(name); }
function eq(actual, expected, name) {
  if (actual === expected) console.log('  PASS ' + name);
  else bad(name + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Date: Date,
  Math: Math,
  String: String,
  Number: Number,
  Array: Array,
  Object: Object,
  RegExp: RegExp,
  Promise: Promise,
  JSON: JSON,
  localStorage: {
    _s: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem(k, v) { this._s[k] = String(v); },
    removeItem(k) { delete this._s[k]; },
    clear() { this._s = {}; }
  }
};
sandbox.window = sandbox;
sandbox.global = sandbox;

vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'),
                                   sandbox, { filename: f });

for (const f of ['util.js', 'config.js', 'i18n.js', 'api.js', 'providers.js', 'turn.js',
                 'game.js', 'quests.js', 'daily.js', 'world.js', 'npc.js', 'nsfw.js',
                 'session.js']) {
  try { load(f); } catch (e) { bad('load ' + f + ': ' + e.message); }
}

sandbox.Game.load();

(async () => {
  console.log('\n=== A. Session initialization & state ===');
  const S = sandbox.Session;
  ok(!!S, 'Session module loaded');
  eq(S.isBusy(), false, 'Session starts idle');
  eq(S.getHistory().length, 0, 'Session starts with empty history');

  console.log('\n=== B. Pre-flight guard assertions ===');
  // 1. Missing API key
  sandbox.Config.set('llm.apiKey', '');
  let errKey = null;
  try {
    await S.say('hello');
  } catch (e) {
    errKey = e;
  }
  ok(!!errKey && errKey.message === 'NO_KEY', 'Rejects immediately if API key is missing');
  eq(S.isBusy(), false, 'Session remains idle on pre-flight rejection');

  // Set API key
  sandbox.Config.set('llm.apiKey', 'test-key-xyz');

  // 2. Stamina exhaustion
  sandbox.Game.s.stamina = 0;
  sandbox.Game.save();
  let errStamina = null;
  try {
    await S.say('hello again');
  } catch (e) {
    errStamina = e;
  }
  ok(!!errStamina && errStamina.message === 'STAMINA_OUT', 'Rejects if player has fainted or lacks stamina');

  console.log('\n=== C. Successful turn execution & side effects ===');
  sandbox.Game.refill();
  const staminaBefore = sandbox.Game.s.stamina;

  // Mock Api.chat
  const origChat = sandbox.Api.chat;
  let chatCalledWith = null;
  sandbox.Api.chat = function (history, text, opts) {
    chatCalledWith = { history: history.slice(), text: text, opts: opts };
    return Promise.resolve({
      text: '「ライザだよ！」',
      emotion: 'happy',
      attitude: 'agree',
      state: { stamina: 10 }
    });
  };

  const events = [];
  S.on('start', (d) => events.push({ type: 'start', data: d }));
  S.on('reply', (d) => events.push({ type: 'reply', data: d }));

  const reply = await S.say('やあ、ライザ！');
  ok(!!reply, 'say() resolves with reply object');
  eq(reply.text, '「ライザだよ！」', 'reply text preserved');
  eq(S.isBusy(), false, 'Session is idle after turn completion');

  eq(events.length, 2, 'emitted start and reply events');
  eq(events[0].type, 'start', 'start event came first');
  eq(events[1].type, 'reply', 'reply event came second');

  // History assertion
  const hist = S.getHistory();
  eq(hist.length, 2, 'history contains user and assistant entries');
  eq(hist[0].role, 'user', 'first entry is user');
  eq(hist[0].content, 'やあ、ライザ！', 'user content matches');
  eq(hist[1].role, 'assistant', 'second entry is assistant');
  ok(hist[1].content.indexOf('ライザだよ') >= 0, 'assistant content matches');

  // Game state & stamina
  ok(sandbox.Game.s.stamina < staminaBefore, 'stamina was spent for talk');

  console.log('\n=== D. Cancellation, Interrupt & Epoch Protection ===');
  // 1. Interrupt during in-flight chat
  let resolveSlow = null;
  sandbox.Api.chat = function () {
    return new Promise((res) => { resolveSlow = res; });
  };

  const p1 = S.say('Slow message');
  ok(S.isBusy(), 'Session busy during in-flight chat');

  // Explicit Session.interrupt()
  let interruptedEventFired = false;
  S.on('interrupt', () => { interruptedEventFired = true; });
  S.interrupt('user_cut_in');
  eq(S.isBusy(), false, 'Session is immediately not busy after interrupt()');
  ok(interruptedEventFired, 'Session emitted interrupt event');

  // Resolving the slow promise after interrupt must NOT land in history
  resolveSlow({ text: 'I am obsolete!', state: null });
  await p1;

  const obsoleteInHist = S.getHistory().some((h) => h.content === 'I am obsolete!');
  ok(!obsoleteInHist, 'Stale reply from interrupted turn does not land in history');

  console.log('\n=== E. Multi-speaker reply handling ===');
  sandbox.Api.chat = function () {
    return Promise.resolve({
      text: 'ボオス「ライザ、何してるんだ？」\nライザ「錬金術の材料を探してるの！」',
      emotion: 'happy'
    });
  };

  let multiReply = null;
  S.on('reply', (ev) => { multiReply = ev.reply; });
  await S.say('誰か来た？');
  ok(!!multiReply, 'Multi-speaker reply received');
  const beats = sandbox.Npc.split(multiReply.text);
  eq(beats.length, 2, 'Two speaker beats split');
  ok(beats[0].text.indexOf('何してるんだ') >= 0, 'First beat is NPC');
  ok(beats[1].text.indexOf('錬金術の材料') >= 0, 'Second beat is Ryza');

  console.log('\n=== F. Reset & clear ===');
  S.clearHistory();
  eq(S.getHistory().length, 0, 'clearHistory resets conversation history');

  // Restore Api.chat
  sandbox.Api.chat = origChat;

  console.log('\n--- Dialogue Regression Results ---');
  if (failures === 0) {
    console.log('ALL PASS: All dialogue regression checks passed');
    process.exit(0);
  } else {
    console.log('FAILED: ' + failures + ' errors');
    process.exit(1);
  }
})();
