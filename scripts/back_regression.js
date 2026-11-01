/* Back-button bridge regression: RyzaShell.handleBack() must close the
   topmost DOM layer instead of letting the Activity exit the app.
   Run: node scripts/back_regression.js

   Mirrors boot_smoke.js: the real index.html ids drive the fake DOM, real
   modules run, Avatar/Sound/Onboarding are stubbed. handleBack() is exercised
   against each layer kind in stacking order. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };

/* ids + initial classes actually present in index.html. Seeding the classes
   matters: #overlay-title ships visible and #view-talk ships .view.active, so
   a DOM that starts every element empty sees a phantom open layer. */
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const IDS = new Map();
for (const m of html.matchAll(/<([a-zA-Z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
  const cm = /class="([^"]*)"/.exec(m[0]);
  IDS.set(m[2], cm ? cm[1].split(/\s+/).filter(Boolean) : []);
}
const idList = [...IDS.keys()];

function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, style: {},
    src: '', title: '',
    classList: {
      _s: new Set(IDS.get(id) || []),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute() {}, getAttribute() { return null; },
    /* index.html ships btn-title-start disabled; App.init enables it, so the
       seeded element must start enabled for the title-screen back path to
       be reachable in the test */
    disabled: false,
    appendChild(c) { (this._kids = this._kids || []).push(c); }, removeChild() {}, remove() {}, focus() {},
    querySelector(sel) { return makeEl(id + sel); },
    querySelectorAll() { return []; },
    /* Fx._drawConfetti/_drawFire/_drawVoice read host.clientWidth off
       c.parentElement; without this the rAF tick started by Fx.init throws
       inside App.init's promise chain and the boot never reaches
       Onboarding.showTitle (the title-screen button stays disabled) */
    get parentElement() {
      /* fx.js line 151 reads host.clientWidth off c.parentElement without
         re-guarding it; give it a real element so the rAF tick it drives
         does not throw inside App.init's promise chain. The chain is what
         wires the title-screen start button, so this is load-bearing. */
      return document.getElementById('phone') || document.body || makeEl('body');
      },
      get clientWidth() { return 420; },
      get clientHeight() { return 860; },
    addEventListener() {},
    play() { return Promise.resolve(); }, pause() {},
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0 }; },
    click() { if (typeof this.onclick === 'function') this.onclick(); },
    getContext() {
      return new Proxy({ canvas: this }, {
        get(t, k) { if (k in t) return t[k]; return function () {}; },
        set(t, k, v) { t[k] = v; return true; }
      });
    },
    /* fx.js:151 dereferences host.clientWidth where host = c.parentElement,
       with only a truthiness guard at line 147; mock elements have no
       parentElement at all, and that throw lands inside App.init's promise
       chain — which is what wires the title-screen start button. Returning a
       real element here keeps the rAF tick Fx.init starts from throwing. */
    get parentElement() { return document.getElementById('phone') || makeEl('body'); },
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
  querySelector(sel) {
    /* boot_smoke returns null here; we need .view.active discovery.
       querySelector walks real elements only — dynamic makeEl('dyn-x')
       elements have no entry in IDS and are skipped. */
    const m = /^\.([a-z-]+)(?:\.([a-z-]+))?$/.exec(sel);
    if (!m) return null;
    for (const id of idList) {
      const el = document.getElementById(id);
      if (el.classList.contains(m[1]) && (!m[2] || el.classList.contains(m[2]))) {
        return el;
      }
    }
    return null;
  },
  querySelectorAll(sel) {
    /* App.showView toggles .view.active across ALL .view elements; returning
       [] here makes it a no-op, so every other view stays .active and
       querySelector('.view.active') keeps finding view-talk (first in
       index.html) instead of the view the test just opened */
    const m = /^\.([a-z-]+)$/.exec(sel);
    if (!m) return [];
    return idList.map((id) => document.getElementById(id))
                 .filter((el) => el.classList.contains(m[1]));
  },
  createElement(t) { return makeEl('dyn-' + t); },
  /* back.js wires Esc here; keep the listeners so the test can fire it */
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); },
  hidden: false
};
/* Onboarding.showTitle does document.body.classList.add('boot') before wiring
   the start button; without body the boot chain throws there and the title
   screen stays open with a dead button for the rest of the suite */
document.body = makeEl('body');

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
  'assets/_index/world_hierarchy.json': { areas: [{ id: 'area_01',
    fields: [{ id: 'field_01_001', stages: [{ id: 'stage_01_001_04' }] }] }] },
  'assets/_index/npc_placement.json': { npcs: [] },
  'assets/_index/stage_background_map.json': { stage_01_001_04: 'stage_01_001_04' },
  'assets/_index/scenes.json': { stage_01_001_04: { aft: 'x' } },
  'assets/_index/ambient.json': ['amb_001_day.m4a'],
  'assets/_index/tap_voice.json': [], 'assets/_index/se.json': [],
  'assets/_index/voice_bank.json': { ja: { normal: { goodMorning: { daytime: ['a.m4a'] },
    wellDone: { daytime: ['b.m4a'] } } } },
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
/* _fitUi reads window.innerWidth/innerHeight first; without them it dereferences
   a missing element and rejects the App.init boot chain before showTitle runs */
sandbox.innerWidth = 420;
sandbox.innerHeight = 860;
/* App.init registers a resize listener at the end of the boot chain; the
   onboarding title screen is wired after it, so a missing addEventListener
   aborts the boot before the start button gets its handler */
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.document = document;
sandbox.localStorage = localStorage;
sandbox.navigator = {};
sandbox.location = { origin: 'http://127.0.0.1:8765', reload() {} };
sandbox.fetch = (url) => {
  const key = String(url).replace(/^\.\/$/, '');
  if (key in FIXTURES) return Promise.resolve({ ok: true, json: () => Promise.resolve(FIXTURES[key]) });
  return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('404 ' + key)) });
};
sandbox.XMLHttpRequest = function () {};
sandbox.Audio = function () { return makeEl('audio'); };
sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
sandbox.requestAnimationFrame = () => 0;
sandbox.cancelAnimationFrame = () => {};

let alarmDismissed = 0, onboardingSkipped = 0, prologueNexted = 0;
const Avatar = {
  init(cb) { setTimeout(cb, 0); }, resize() {}, onModeChange() {}, setHidden() {},
  setEmotion() {}, setTalking() {}, setTalkingEnvelope() {},
  loadScene(id, tod, cb) { cb && cb(null); }, loadSkin(id, cb) { cb && cb(); },
  postureKey() { return 'posture_sitting'; }, supportsBothPostures() { return false; },
  hitPartAt() { return null; }, poke() { return null; },
  outfitOf(id) { return String(id).replace(/_(01|99)$/, ''); },
  setAtlasVariant() {}, variantPageUrls() { return []; },
  /* The ports avatar.js exposes as *consumers*, plus the public getters app.js
     reads. App.init calls Avatar.setNotice unconditionally, so a stub without
     it makes the whole boot chain throw here — and this suite then reported a
     wall of downstream failures that had nothing to do with the back key.
     boot_smoke.js keeps the same list; they must not drift apart. */
  setNotice() {}, setVoiceSource() {},
  _panelFrac: 0,
  panelFraction() { return this._panelFrac; },
  setPanelFraction(f) { this._panelFrac = Number(f) || 0; },
  isHidden() { return false; }, cssZoom() { return 1; },
  currentEmotion() { return ''; }, currentAttitude() { return ''; },
  screenState() { return { emotion: '', attitude: '' }; }
};
sandbox.Avatar = Avatar;
sandbox.Sound = {
  se() {}, tapVoice() {}, setRoute() {}, setPlace() {}, setCatalog() {},
  unlock() {}
};
sandbox.Onboarding = {
  showTitle(cb) { cb(); }, isDone() { return true; }, start() {},
  skip() { onboardingSkipped++; }, next() {}, prologueNext() { prologueNexted++; },
  tutorialAdvance() { return false; }
};
sandbox.alert = () => {}; sandbox.confirm = () => true; sandbox.prompt = () => null;

vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'),
                                   sandbox, { filename: f });

/* The load list has to track web/index.html: these are the real modules, and a
   missing one does not fail loudly — it aborts App.init's promise chain, which
   is what wires the title screen, and every layer assertion below then reads a
   phantom overlay. settings.js is the one that bit: app.js delegates
   buildSettings() to it since the split, so the chain threw `Settings is not
   defined` and the whole suite looked like a back-key bug. */
for (const f of ['util.js', 'config.js', 'i18n.js', 'api.js', 'providers.js',
                 'turn.js', 'echo.js', 'voice.js', 'memory.js',
                 'game.js', 'quests.js', 'daily.js', 'world.js', 'npc.js', 'audio.js',
                 'alarm.js', 'fx.js', 'nsfw.js', 'settings.js', 'onboarding.js',
                 'back.js', 'app.js']) {
  try { load(f); } catch (e) { bad('load ' + f + ': ' + e.message); }
}

/* onboarding.js (loaded above) replaces sandbox.Onboarding, so the
   skip/prologueNext counters in the stub never fire. The real skip() writes
   Config.set('state.onboardingDone', true) — the durable "finished" flag the
   app persists — so the assertions read it through this spy. Must be installed
   AFTER the load loop: sandbox.Config does not exist until config.js runs. */
sandbox.Config_set_calls = 0;
if (sandbox.Config && sandbox.Config.set) {
  const orig = sandbox.Config.set;
  sandbox.Config.set = (k, v) => { if (k === 'state.onboardingDone') sandbox.Config_set_calls++; return orig(k, v); };
}

const R = sandbox.RyzaShell;

(async () => {
  ok(!!R && typeof R.handleBack === 'function', 'RyzaShell.handleBack present');

  /* boot the app for real: App.init is what wires the title-screen start
     button (Onboarding.showTitle), so without it #overlay-title is visible
     with a dead button and every later layer assertion sees a phantom open
     overlay. boot_smoke does the same. */
  try { await sandbox.App.init(); } catch (e) { bad('App.init threw: ' + e.message); }
  const P = (ms) => new Promise((res) => setTimeout(res, ms));
  const flush = async () => { for (let i = 0; i < 12; i++) await P(0); };
  await flush();
  /* the boot's title-start callback runs enterGame, which starts the onboarding
     questionnaire unless state.onboardingDone is already true. The suite below
     tests back on each layer in isolation, so mark onboarding done here and
     let section 6 verify back on a forcibly-opened onboarding overlay. */
  if (sandbox.Config && sandbox.Config.set) sandbox.Config.set('state.onboardingDone', true);
  await flush();
  ok(document.getElementById('overlay-title').classList.contains('hidden') === false,
     'booted: title screen is showing (DOM seeded from index.html)');

  /* base state: index.html ships #overlay-title visible (the Start screen)
     and every other layer hidden. The title screen counts as an open layer:
     back starts the game rather than quitting. */
  ok(R.handleBack() === true, 'title screen: back starts the game instead of quitting');
  ok(document.getElementById('overlay-title').classList.contains('hidden'),
     'title screen closed by back');
  /* the title start callback runs enterGame, which schedules _dailyNudge on
     a setTimeout; flush so it lands before the "nothing open" check below,
     otherwise the pending open layer makes back return true */
  await flush();
  /* make sure no leftover layer from the boot/nudge chain is open */
  const openLeftover = ['view-welcome', 'view-daily']
    .filter((id) => document.getElementById(id).classList.contains('active'));
  for (const id of openLeftover) document.getElementById(id).classList.remove('active');
  ok(R.handleBack() === false, 'nothing else open: back exits the app');

  /* 1. modal — opened through the real App.openModal, so the cancel wiring
     under test is the app's own, not a stub */
  let cancelFired = false;
  const scrim = document.getElementById('modal-scrim');
  sandbox.App.openModal({
    title: 'test', build() {},
    onCancel() { cancelFired = true; }
  });
  ok(!scrim.classList.contains('hidden'), 'openModal really shows the scrim');
  ok(R.handleBack() === true, 'open modal: back consumed (does not exit)');
  ok(scrim.classList.contains('hidden'), 'modal scrim hidden after back');
  ok(cancelFired, 'modal cancel handler ran (form cleanup fires)');
  ok(R.handleBack() === false, 'after modal close: back exits again');

  /* 2. side menu */
  const side = document.getElementById('side-menu');
  side.classList.add('open');
  ok(R.handleBack() === true, 'open side menu: back consumed');
  ok(!side.classList.contains('open'), 'side menu closed');
  ok(R.handleBack() === false, 'after side menu close: back exits again');

  /* 3. bottom sheets */
  const sheets = ['sheet-mode', 'sheet-inv', 'sheet-status', 'sheet-npc', 'sheet-lang'];
  for (const id of sheets) {
    const el = document.getElementById(id);
    el.classList.remove('hidden');
    ok(R.handleBack() === true, id + ' open: back consumed');
    ok(el.classList.contains('hidden'), id + ' closed by back');
  }

  /* 3b. desktop/browser: Esc and the × close a sheet (the status sheet had
     no closer at all off Android). Esc never "starts" the title screen. */
  const esc = () => {
    const ev = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    (document._listeners.keydown || []).forEach((fn) => fn(ev));
    return ev;
  };
  const stSheet = document.getElementById('sheet-status');
  const title = document.getElementById('overlay-title');
  stSheet.classList.remove('hidden');
  title.classList.remove('hidden');
  esc();
  ok(!stSheet.classList.contains('hidden') && !title.classList.contains('hidden'),
     'Esc on the title screen does nothing (reverse check)');
  title.classList.add('hidden');
  ok(esc().defaultPrevented && stSheet.classList.contains('hidden'), 'Esc closes the status sheet');
  for (const id of sheets) {
    const el = document.getElementById(id);
    const x = (el._kids || []).find((k) => k.className === 'sheet-close');
    el.classList.remove('hidden');
    if (x) x.click();
    ok(x && el.classList.contains('hidden'), id + ' has a working ×');
  }

  /* 4. full-screen views: back returns to talk, never exits.
     Opened through App.showView rather than a raw class flip: showView is the
     app's only path in and out of views, and it toggles .view.active across
     ALL views. Adding 'active' by hand would leave two views active and
     querySelector('.view.active') would keep finding view-talk (first in
     index.html), making handleBack think the base layer was on top. */
  const views = ['view-settings', 'view-world', 'view-quest', 'view-daily',
                 'view-chara', 'view-skin', 'view-memory'];
  for (const id of views) {
    sandbox.App.showView(id.replace(/^view-/, ''));
    const before = sandbox.Config.section('state').stage;
    ok(R.handleBack() === true, id + ' active: back consumed');
    ok(document.getElementById('view-talk').classList.contains('active'),
       id + ' → back lands on talk screen');
    ok(sandbox.Config.section('state').stage === before,
       'returning to talk does not move the player');
  }
  /* talk itself is the base layer: back must fall through to exit. The
     showView loop toggles active by equality, so leaving view-* active on
     would make querySelector keep finding them instead of view-talk. */
  for (const id of views) document.getElementById(id).classList.remove('active');
  document.getElementById('view-talk').classList.add('active');
  ok(document.querySelector('.view.active').id === 'view-talk',
     'only view-talk is active before the exit test');
  ok(R.handleBack() === false, 'talk screen: back exits (no infinite loop)');

  /* 5. overlays — alarm goes through _dismissAlarm so the audio stops */
  const alarm = document.getElementById('overlay-alarm');
  sandbox.App._ringAlarm = { id: 'x' };
  /* _dismissAlarm pauses App.audio; a play()-less stub would make it throw
     and the catch-all in handleBack turn the back key into a no-op */
  sandbox.App.audio = { pause() { alarmDismissed++; }, play() { return Promise.resolve(); } };
  alarm.classList.remove('hidden');
  ok(R.handleBack() === true, 'alarm ring: back consumed');
  ok(alarm.classList.contains('hidden'), 'alarm overlay hidden');
  ok(alarmDismissed === 1, 'alarm audio paused via _dismissAlarm');
  ok(sandbox.App._ringAlarm === null, 'alarm cleared');

  /* faint / quest-clear are plain hides */
  const faint = document.getElementById('overlay-faint');
  faint.classList.remove('hidden');
  ok(R.handleBack() === true, 'faint overlay: back consumed');
  ok(faint.classList.contains('hidden'), 'faint overlay hidden');

  const qc = document.getElementById('overlay-quest-clear');
  qc.classList.remove('hidden');
  ok(R.handleBack() === true, 'quest-clear overlay: back consumed');
  ok(qc.classList.contains('hidden'), 'quest-clear overlay hidden');

  /* 6. onboarding overlays route to their own dismiss, not a raw class flip */
  onboardingSkipped = 0; prologueNexted = 0; sandbox.Config_set_calls = 0;
  document.getElementById('overlay-onboard').classList.remove('hidden');
  ok(R.handleBack() === true, 'onboarding overlay: back consumed');
  ok(sandbox.Config_set_calls === 1,
     'back calls Onboarding.skip (marks onboarding done)');

  document.getElementById('overlay-prologue').classList.remove('hidden');
  ok(R.handleBack() === true, 'prologue overlay: back consumed');
  await flush();
  /* prologueNext calls _playPrologue, which routes audio through App.playFile
     and then advances to the next step (or _tutorial at the end) — it never
     marks onboarding done, unlike skip() */
  ok(sandbox.Config_set_calls === 1,
     'back advances the prologue rather than skipping it');
  /* the prologue advance plays the next line through App.audio; make sure
     that did not leave the overlay open or trigger a follow-up layer */
  document.getElementById('overlay-prologue').classList.add('hidden');

  /* 7. stacking: the topmost layer closes first, one press at a time */
  sandbox.App.showView('settings');
  side.classList.add('open');
  document.getElementById('sheet-inv').classList.remove('hidden');
  scrim.classList.remove('hidden');
  ok(R.handleBack() === true && !scrim.classList.contains('hidden') === false &&
     document.getElementById('sheet-inv').classList.contains('hidden') === false,
     'stacked: back closes only the modal, sheets/menu/view stay');
  ok(R.handleBack() === true &&
     document.getElementById('sheet-inv').classList.contains('hidden'),
     'stacked: next back closes the sheet');
  ok(R.handleBack() === true && !side.classList.contains('open'),
     'stacked: next back closes the side menu');
  ok(R.handleBack() === true &&
     document.getElementById('view-talk').classList.contains('active'),
     'stacked: final back returns to talk');
  ok(R.handleBack() === false, 'stacked: nothing left, back exits');

  /* 8. a layer that throws must not trap the user in the app */
  sandbox.Onboarding.skip = () => { throw new Error('boom'); };
  document.getElementById('overlay-onboard').classList.remove('hidden');
  ok(R.handleBack() === false, 'broken layer falls through to exit, never traps');

  console.log(failures ? '\nBACK REGRESSION: ' + failures + ' FAILURES'
                       : '\nBACK REGRESSION: ALL PASS');
  process.exit(failures ? 1 : 0);
})();
