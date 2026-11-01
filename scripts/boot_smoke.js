/* Boot smoke: run the real App.init() against a fake DOM whose element ids
   come from the actual index.html, with real config/i18n/game/quests/daily
   and stubbed Avatar/Sound/Onboarding. Catches wiring typos (an id in JS
   that index.html does not ship, a method that no longer exists) that the
   pure-logic regression cannot see.  Run: node scripts/boot_smoke.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };

/* The boot wiring runs inside an async chain, so a throw inside it becomes an
   unhandled rejection: the app keeps looking alive while every port after the
   throwing line is left unconnected — which is exactly how this suite reported
   ALL PASS for as long as Avatar.setNotice was missing from the stub below. */
process.on('unhandledRejection', (e) => {
  bad('unhandled rejection during boot: ' + (e && e.stack ? e.stack : e));
});
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };

/* ids actually present in index.html */
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const IDS = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) IDS.add(m[1]);

function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, style: {},
    src: '', title: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, removeChild() {}, remove() {}, focus() {},
    querySelector(sel) { return makeEl(id + sel); },
    querySelectorAll() { return []; },
    /* Listeners are recorded instead of dropped so the audio failure paths can
       be driven from the test: an <audio> that fails to load fires `error` and
       never `ended`, and that is exactly the case that used to wedge the turn. */
    _ls: {},
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
    removeEventListener(t, f) {
      const a = this._ls[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1);
    },
    _fire(t) { (this._ls[t] || []).slice().forEach((f) => f({ type: t })); },
    play() { return this._playResult || Promise.resolve(); }, pause() {},
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0 }; },
    getContext() {
      /* swallow-all 2d context so fx.js can draw against nothing */
      return new Proxy({ canvas: this }, {
        get(t, k) { if (k in t) return t[k]; return function () {}; },
        set(t, k, v) { t[k] = v; return true; }
      });
    }
  };
  return el;
}
const elCache = new Map();
const document = {
  getElementById(id) {
    if (!IDS.has(id)) return null;
    if (!elCache.has(id)) elCache.set(id, makeEl(id));
    return elCache.get(id);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement(t) { return makeEl('dyn-' + t); },
  addEventListener() {},
  /* app.js toggles classes on <body> (side menu, panel, the right-hand button
     column) — the stub used to have no body at all, so binding the quick
     buttons threw before any assertion ran. */
  body: makeEl('body'),
  hidden: false
};

const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; }
};

const FIXTURES = {
  'config/providers.json': null,
  'assets/_index/world_hierarchy.json': { areas: [{ id: 'area_01', name: 'クーケン島周辺地域',
    fields: [{ id: 'field_01_001', name: 'クーケン島',
      stages: [{ id: 'stage_01_001_04', name: 'ライザの家' }] }] }] },
  'assets/_index/npc_placement.json': { npcs: [] },
  'assets/_index/stage_background_map.json': { stage_01_001_04: 'stage_01_001_04' },
  'assets/_index/scenes.json': { stage_01_001_04: { aft: 'x' } },
  'assets/_index/ambient.json': ['amb_001_day.m4a'],
  'assets/_index/tap_voice.json': [],
  'assets/_index/se.json': [],
  'assets/_index/voice_bank.json': { ja: { normal: { goodMorning: { daytime: ['a.m4a'] }, wellDone: { daytime: ['b.m4a'] } } } },
  'assets/_index/skins.json': [{ id: 'crf_skn_002_0001_01', hasSpine: true, preview: 'p.png' }],
  'assets/_index/prologue.json': []
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  RegExp, Promise, Set, Map, Infinity, NaN
};
sandbox.performance = { now: () => Date.now() };
sandbox.window = sandbox;
sandbox.document = document;
sandbox.localStorage = localStorage;
sandbox.navigator = {};
sandbox.location = { origin: 'http://127.0.0.1:8765', reload() {} };
sandbox.fetch = (url) => {
  const key = String(url).replace(/^\.\//, '');
  if (key in FIXTURES) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(FIXTURES[key]) });
  }
  return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('404 ' + key)) });
};
sandbox.XMLHttpRequest = function () {};
sandbox.Audio = function () { return makeEl('audio'); };
/* Stand-in for the Android shell's RyzaAlarm JavascriptInterface. It has to be
   present BEFORE App.init for the native path to be the one under test. */
const alarmBridge = {
  calls: [], items: '[]',
  isSupported: () => true,
  schedule(json) { this.calls.push(json); return '{"ok":true,"scheduled":1,"exact":true}'; },
  list() { return this.items; },
  cancel: () => true, cancelAll: () => true, snooze: () => true,
  canScheduleExact: () => true, requestExactPermission: () => true
};
sandbox.RyzaAlarm = alarmBridge;
sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
sandbox.requestAnimationFrame = () => 0;
sandbox.cancelAnimationFrame = () => {};

/* module stubs that would need real GL / network */
const variantCalls = [];
const Avatar = {
  _initCb: null,
  init(cb) { this._initCb = cb; setTimeout(cb, 0); },
  resize() {}, onModeChange() {}, setHidden() {}, setEmotion() {}, setTalking() {},
  setTalkingEnvelope() {}, loadScene(id, tod, cb) { cb && cb(null); },
  loadSkin(id, cb) { cb && cb(); }, postureKey() { return 'posture_sitting'; },
  supportsBothPostures() { return false; }, hitPartAt() { return null; },
  poke() { return null; }, outfitOf(id) { return String(id).replace(/_(01|99)$/, ''); },
  setAtlasVariant(name) { variantCalls.push(name); }, variantPageUrls() { return []; },
  /* The two ports avatar.js exposes as *consumers* (S1), plus the public getters
     app.js reads. They must all exist: the boot chain calls Avatar.setNotice and
     App._syncPanelFrac() unconditionally, and while setNotice was missing here
     the chain threw at that line and every port after it — memory, quests, turn,
     voice — was silently left unconnected while this suite reported ALL PASS.
     `_bootError` below is the gate that now makes that impossible. */
  setNotice() {}, setVoiceSource() {},
  _panelFrac: 0,
  panelFraction() { return this._panelFrac; },
  setPanelFraction(f) { this._panelFrac = Number(f) || 0; },
  isHidden() { return false; }, cssZoom() { return 1; },
  currentEmotion() { return ''; }, currentAttitude() { return ''; },
  screenState() { return { emotion: '', attitude: '' }; }
};
sandbox.Avatar = Avatar;
sandbox.Onboarding = {
  showTitle(cb) { cb(); }, isDone() { return true; }, start() {},
  skip() {}, next() {}, prologueNext() {}, tutorialAdvance() { return false; }
};
sandbox.alert = () => {}; sandbox.confirm = () => true; sandbox.prompt = () => null;
/* The window object itself has listeners and a size in a real browser; the boot
   chain registers `resize` and `visibilitychange`, so they must exist here or
   the chain dies part-way (which is what the _bootError gate below detects). */
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.innerWidth = 420; sandbox.innerHeight = 860;

vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'),
                                   sandbox, { filename: f });

for (const f of ['util.js', 'config.js', 'i18n.js', 'api.js', 'providers.js', 'turn.js', 'echo.js', 'voice.js', 'memory.js',
                 'game.js', 'quests.js', 'daily.js', 'world.js', 'npc.js', 'audio.js',
                 'alarm.js', 'fx.js', 'nsfw.js', 'settings.js', 'session.js', 'app.js']) {
  try { load(f); console.log('  loaded ' + f); }
  catch (e) { bad('load ' + f + ': ' + e.message); }
}

(async () => {
  try {
    await sandbox.App.init();
    await new Promise((r) => setTimeout(r, 50));   // let the init chain settle
    ok(true, 'App.init completed without throwing');
    if (sandbox.App._bootError) {
      bad('silent half-boot (the chain threw and the rest of the boot was skipped):\n' +
          sandbox.App._bootError.stack);
    } else {
      ok(true, 'the asset-loading chain ran to the end');
    }

    const g = sandbox.Game, q = g.s.quest;
    ok(!!q && q.no === 1, 'quest chain started (no=' + (q && q.no) + ')');
    ok(g.s.stamina > 0, 'game state initialized');
    ok(document.getElementById('hud-stamina').innerHTML.indexOf('apple') >= 0 ||
       document.getElementById('hud-stamina').innerHTML === '',
       'HUD stamina chip rendered after boot');
    ok(sandbox.Daily.available(), 'daily claim available on fresh boot');

    /* the right-hand quick column: bound at boot, state applied from Config */
    const qt = document.getElementById('btn-quick-toggle');
    ok(!!qt && qt.textContent === '\u2715' &&
       !document.body.classList.contains('quick-collapsed'),
       'quick buttons start expanded and the collapse key says so');
    sandbox.App.setQuickCollapsed(true);
    ok(document.body.classList.contains('quick-collapsed') && qt.textContent === '\u22ef' &&
       sandbox.Config.section('app').quickCollapsed === true,
       'collapsing hides the column, flips the key and is remembered');
    sandbox.App.setQuickCollapsed(false);
    ok(!document.body.classList.contains('quick-collapsed') && qt.textContent === '\u2715',
       'and it expands again');

    /* exercise the reducer end-to-end through App events */
    g.applyDelta({ exp_delta: 400, money_delta: 100, quest: { step_add: 4 } });
    ok(sandbox.Quests.pendingAdvance(), 'quest1 cleared via reducer path');
    sandbox.Quests.takeNext();
    ok(g.s.quest.no === 2, 'chain advanced to quest2');

    /* render surfaces that index.html wires */
    sandbox.Quests.render(document.getElementById('quest-list'), {});
    sandbox.Daily.render(document.getElementById('daily-body'));
    sandbox.App.renderStatus();
    sandbox.App.renderInv();
    sandbox.App.buildSettings();
    sandbox.App.buildCharaForm();
    sandbox.App.updateHud();
    ok(true, 'render surfaces + settings form built');
    ok(!!sandbox.Memory && sandbox.Memory.promptBlock() === '', 'Memory module boots empty');
    sandbox.App.renderMemory();
    ok(!sandbox.App._lastText, 'no stale retry text');

    /* per-mode TTS voice direction: base hint + mode layer, overridable */
    const A = sandbox.Api, C = sandbox.Config;
    const base = C.section('tts').styleHint.trim();
    ok(A.ttsStyleFor('chat') === base, 'chat TTS = base hint only');
    const asmr = A.ttsStyleFor('asmr');
    ok(asmr.indexOf(base) === 0 && asmr.length > base.length &&
       /ささや/i.test(asmr), 'asmr TTS layers whisper direction');
    C.set('tts.modeHints', { asmr: '自定义耳语' });
    ok(A.ttsStyleFor('asmr') === base + ' 自定义耳语', 'tts.modeHints overrides the mode layer');
    C.set('tts.modeHints', {});
    ok(A.MODE_PLAY_FX.asmr.rate < 1 && A.MODE_PLAY_FX.asmr.gain < 1,
       'asmr playback shaping present');
    ok(A.isPlaceholderModel('tts-model') && !A.isPlaceholderModel('mimo-audio'),
       'placeholder-model check centralized');
    const nsfwTag = A.parseTaggedReply('[emotion:shy|attitude:agree|undress:on]\nhi');
    ok(nsfwTag.nsfw === true && nsfwTag.emotion === 'shy', 'undress:on parses with extra pipes');
    const spacedNsfw = A.parseTaggedReply('[emotion: shy | undress: on]\nhi');
    ok(spacedNsfw.nsfw === true && spacedNsfw.emotion === 'shy',
       'spaced undress:on still parses');
    const omitFace = A.parseTaggedReply('タグなし');
    ok(omitFace.emotion == null && omitFace.attitude == null,
       'missed emotion tag is omit, not a reset to neutral');
    ok(sandbox.Nsfw && /着ている/.test(sandbox.Nsfw.screenFact()),
       'prompt tells the LLM she is dressed');
    sandbox.Nsfw.onTurn({ nsfw: null });
    ok(!sandbox.Nsfw.active(), 'omitted tag does not strip');
    sandbox.Nsfw.onTurn(nsfwTag);
    ok(!sandbox.Nsfw.active(), 'disabled setting blocks llm nsfw:on');
    sandbox.Nsfw.setEnabled(true);
    ok(sandbox.Nsfw.active(), 'settings toggle enables nsfw');
    ok(/肌が見えている/.test(sandbox.Nsfw.screenFact()),
       'prompt tells the LLM she is undressed');
    sandbox.Nsfw.setEnabled(false);
    ok(!sandbox.Nsfw.active(), 'settings toggle dresses and blocks nsfw');
    sandbox.Nsfw.onTurn(nsfwTag);
    ok(!sandbox.Nsfw.active(), 'disabled setting continues blocking llm nsfw:on');
    sandbox.Nsfw.reset();
    ok(!sandbox.Nsfw.active(), 'reset clears nsfw');

    sandbox.Config.set('app.timeMode', 'real');
    sandbox.Config.set('state.tod', 'aft');
    sandbox.Config.set('state.stage', 'stage_01_001_04');
    sandbox.App._applySceneDelta({ tod: 'ngt' });
    ok(sandbox.Config.section('state').tod === 'aft', 'real mode ignores LLM tod');
    sandbox.Config.set('app.timeMode', 'manual');
    sandbox.App._applySceneDelta({ tod: 'ngt' });
    ok(sandbox.Config.section('state').tod === 'aft', 'manual mode ignores LLM tod');
    sandbox.Config.set('app.timeMode', 'flow');
    sandbox.Config.set('state.gameHour', 12);
    sandbox.Config.set('state.gameClockAt', Date.now());
    sandbox.App._applySceneDelta({ tod: 'ngt' });
    ok(sandbox.Config.section('state').tod === 'ngt', 'flow mode applies LLM tod');
    sandbox.Config.set('state.tod', 'aft');
    sandbox.Config.set('state.gameHour', 14);
    sandbox.Config.set('state.gameClockAt', Date.now());
    sandbox.App._applySceneDelta({ tod: 'aft' });
    ok(Math.abs(Number(sandbox.Config.section('state').gameHour) - 14) < 0.05,
       'echoing current tod does not rewind to band start');
    sandbox.Config.set('app.timeMode', 'real');
    sandbox.Config.set('state.tod', 'aft');
    function tagLine(sys) {
      var m = String(sys).match(/^\[emotion:.+\]$/m);
      return m ? m[0] : '';
    }
    ok(/undress:off/.test(tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext()))) &&
       /stage:stage_01_001_04/.test(tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext()))) &&
       tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext())).indexOf('tod:') === -1,
       'real 出力形式 fills undress+stage, no tod slot');
    sandbox.Config.set('app.timeMode', 'flow');
    ok(/tod:/.test(tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext()))),
       'flow 出力形式 includes current tod');
    sandbox.Config.set('app.timeMode', 'real');
    sandbox.Config.set('state.tod', 'aft');
    const sleptTod = sandbox.Config.section('state').tod;
    sandbox.App._sleepHome();
    ok(sandbox.Config.section('state').tod === sleptTod,
       'real sleep refills stamina without jumping the wall-clock band');
    ok(sandbox.Config.section('state').stage === 'stage_01_001_04', 'sleep still sends her home');

    sandbox.Config.set('state.mode', 'asmr');
    ok(!sandbox.App._rpgContext(), 'asmr skips numeric RPG block');
    ok(/stage_01_001_04/.test(sandbox.App._sceneContext()),
       'asmr still gets place catalog (marionette scene.*)');
    sandbox.Config.set('state.mode', 'chat');

    /* log-panel lifecycle (2026-09-07 UI pass): the panel is persistent —
       showBubble pushes a page + renders dots, nothing self-hides anymore,
       and a second typeBubble chain supersedes the first via the gen token */
    sandbox.App.showBubble('テスト');
    ok(sandbox.App._pages[sandbox.App._pages.length - 1] === 'テスト',
       'showBubble pushes the line into the log pages');
    ok(!sandbox.App._bubbleTimer, 'the panel no longer arms an auto-hide timer');
    sandbox.App.showBubble('テスト');
    ok(sandbox.App._pages.filter((x) => x === 'テスト').length === 1,
       'back-to-back identical lines do not stack duplicate dots');
    sandbox.App.typeBubble('一二三', null);
    const genAfterStart = sandbox.App._typeGen;
    sandbox.App.typeBubble('abc', null);
    ok(sandbox.App._typeGen === genAfterStart + 1, 'second type chain bumps the gen token');

    /* ---- the two render-layer ports (wired in App.init, asserted here) ---- */
    /* Permission is the gate, so grant it first: this block is about the port,
       not about the gate (the gate itself is asserted further up). */
    sandbox.Nsfw.setEnabled(true);
    ok(sandbox.Nsfw.onTurn({ nsfw: true }) === undefined && sandbox.Nsfw.active(),
       'nsfw port: the tag still reaches the module');
    ok(variantCalls.indexOf('nsfw') >= 0,
       'nsfw port: the injected sink is what switches the atlas (core never names Avatar)');
    sandbox.Nsfw.reset();
    ok(variantCalls[variantCalls.length - 1] === 'default',
       'nsfw port: reset routes through the same sink');
    sandbox.Nsfw.setEnabled(false);   /* leave the sandbox as we found it */

    Avatar.screenState = () => ({ emotion: 'shy', attitude: 'deny' });
    ok(/emotion:shy/.test(sandbox.Api.screenTagLine()) &&
       /attitude:deny/.test(sandbox.Api.screenTagLine()),
       'screen-state port: the tag line follows the on-screen face');
    Avatar.screenState = () => ({ emotion: '', attitude: '' });
    ok(/emotion:happy/.test(sandbox.Api.screenTagLine()),
       'screen-state port: unknown values fall back to the fillable default');

    /* ---- playback must always settle -------------------------------------
       Turn stays in SPEAKING until its player promise resolves, and Voice
       gates the microphone on Turn.isSpeaking(): a promise that never settles
       means a permanently deaf microphone, not just a stuck line. A failed
       load fires `error` (never `ended`), and a rejected play() fires nothing
       at all — both must release the turn. */
    const audioEl = sandbox.App.audio;
    let errSettled = false;
    sandbox.App.playSpeech('blob:err', null, null).then(() => { errSettled = true; });
    await new Promise((r) => setTimeout(r, 0));
    audioEl._fire('error');
    await new Promise((r) => setTimeout(r, 0));
    ok(errSettled, 'playSpeech settles when the audio element errors');

    let rejSettled = false;
    audioEl._playResult = Promise.reject(new Error('NotAllowedError'));
    sandbox.App.playSpeech('blob:rej', null, null).then(() => { rejSettled = true; });
    await new Promise((r) => setTimeout(r, 0));
    ok(rejSettled, 'playSpeech settles when play() is rejected (autoplay policy)');
    audioEl._playResult = null;
    /* ---- single owners (each of these replaced a duplicated literal) ---- */
    /* Text speed: callers used to coerce to 28, which is not in the table. */
    const sped = sandbox.Config.textSpeed();
    ok(sandbox.Config.TEXT_SPEEDS.some((s2) => s2.v === sped),
       'the resolved text speed is a real step of the one table');
    /* Language picker: labels and membership derive from LANG_NAMES + Langs.ALL. */
    ok(sandbox.I18n.LANGS.every((l) => sandbox.I18n.LANG_NAMES[l.id] === l.label),
       'every language-picker label comes from the one name table');
    ok(sandbox.I18n.LANGS.length === sandbox.Langs.ALL.length - 1 &&
       !sandbox.I18n.LANGS.some((l) => l.id === 'auto'),
       'the UI-language picker is Langs.ALL minus auto (one membership list)');
    /* Effort picker: options and validation come from Api.EFFORT_UI, and every
       level must have a label — a level added there without one would render
       blank rather than fail. */
    ok(sandbox.Api.EFFORT_UI.length > 0 &&
       sandbox.Api.EFFORT_UI.every((v) =>
         sandbox.I18n.t('settings.thinkingEffort.' + v) !== 'settings.thinkingEffort.' + v),
       'every effort level in the registry has a settings label');
    /* Item catalogue readers live with the catalogue. */
    ok(typeof sandbox.Game.itemName === 'function' &&
       typeof sandbox.Game.itemValue === 'function' &&
       sandbox.Game.itemName('bottle') ===
         sandbox.I18n.tc('item.bottle', '回復のボトル'),
       'Game owns item naming (the bag list now localizes like every other line)');
    /* ---- the Android alarm bridge (android/.../RyzaAlarm.java contract) ----
       When the shell can schedule alarms in the system, native becomes the
       firing authority: the in-page interval must stand down or every alarm
       rings twice, and the list must actually be handed over — an alarm the
       system never received is an alarm that does not ring. */
    ok(!!sandbox.RyzaAlarmNative && typeof sandbox.RyzaAlarmNative.onFire === 'function',
       'the native fire hook is defined before the schedule is handed over');
    ok(alarmBridge.calls.length >= 1, 'the alarm list is pushed to the native scheduler');
    ok(sandbox.Alarm._timer === null,
       'with native scheduling the in-page tick stands down (no double fire)');
    sandbox.Alarm.add({ time: '07:30', days: [1, 3], type: 'goodMorning', style: 'whisper' });
    ok(alarmBridge.calls.length >= 2, 'a mutation pushes the new schedule');
    const pushedAlarms = JSON.parse(alarmBridge.calls[alarmBridge.calls.length - 1]);
    const pushedOne = pushedAlarms[pushedAlarms.length - 1] || {};
    ok(pushedOne.time === '07:30' && pushedOne.enabled === true &&
       pushedOne.snoozeMin === 5 && Array.isArray(pushedOne.days) && pushedOne.days.length === 2,
       'the pushed alarm carries the fields the native contract documents');
    ok(typeof pushedOne.audio === 'string',
       'and the clip to play (native has no voice-bank index of its own)');
    ok(sandbox.Alarm._nativeFire({ id: 'nope' }) === false,
       'a native fire for an unknown id does not ring');
    ok(sandbox.Api.EMOTIONS === sandbox.Util.EMOTIONS,
       'one emotion vocabulary (core), used by both the protocol and the face');
    /* ---- failure classification (the toast/panel line must name the cause) ----
       Transport failures arrive as {code}, because their wording is localized
       now and prose matching stopped working when it stopped being Chinese. */
    ok(sandbox.App._failKind({ code: 'timeout', message: 'Timed out' }) === 'timeout',
       'a timed-out turn is classified as timeout');
    ok(sandbox.App._failKind({ code: 'net', message: 'unreachable' }) === 'net',
       'an unreachable host is classified as net');
    ok(sandbox.App._failKind('401 Unauthorized') === 'auth',
       'HTTP prose still classifies (the old string call keeps working)');
    ok(sandbox.App._failKind('model not found') === 'model',
       'a rejected model name still classifies');
    ok(sandbox.App._failKind('') === 'other', 'anything else falls through to other');
  } catch (e) {
    bad('runtime: ' + (e && e.stack || e));
  }
  console.log(failures ? '\nBOOT SMOKE: ' + failures + ' FAILURES' : '\nBOOT SMOKE: ALL PASS');
  process.exit(failures ? 1 : 0);
})();
