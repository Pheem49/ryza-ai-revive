/* Save slots: the three rows at the bottom of the character form.

   Why this file exists
   --------------------
   The slots were dead in three shipped releases (1.2.19 / 1.2.20 / 1.2.21) and
   nothing noticed. When the forms moved out of app.js (0daec22) the *uses* of
   `SAVE_KEY` came to settings.js and the *declaration* stayed in app.js's
   closure — so both helpers threw `ReferenceError` inside `catch (e) {}`. The
   list always rendered "Empty", every write vanished, and the toast still said
   "Saved". A bug that cannot be seen from the UI and cannot be heard from the
   console is exactly what this suite is for.

   It also guards the two things that made the bug unreportable:
     * a swallowed write must be surfaced, not reported as success;
     * the slot strings must exist in every locale (the reporter's screenshot
       was an Indonesian UI with two hardcoded Chinese buttons).
   Run: node scripts/save_slot_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const SLOT_KEY = 'ryza.saves.v1';

let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };
const eq = (got, want, name) => {
  if (got === want) console.log('  PASS ' + name);
  else bad(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')');
};

/* ---------------------------------------------------------------- harness */

function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, type: '',
    className: '', style: {}, _kids: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(k) { this._kids.push(k); return k; },
    insertBefore(k) { this._kids.push(k); return k; },
    removeChild(k) { const i = this._kids.indexOf(k); if (i >= 0) this._kids.splice(i, 1); },
    remove() {}, focus() {}, blur() {}, click() {}, scrollIntoView() {},
    closest() { return null; }, dataset: {}, children: [],
    querySelector(sel) { return makeEl(this.id + ' ' + sel); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}
  };
  return el;
}

/* A fresh world: real modules, stubbed view layer. `opts.settingsSrc` lets the
   reverse control feed a broken copy of settings.js. */
function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  let throwOn = opts.throwOn || null;      /* key whose setItem must fail */
  const toasts = [];
  const calls = [];
  const elCache = new Map();
  const document = {
    getElementById(id) {
      if (!elCache.has(id)) elCache.set(id, makeEl(id));
      return elCache.get(id);
    },
    createElement(t) { return makeEl('dyn-' + t); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: makeEl('body'),
    hidden: false
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      if (throwOn && k === throwOn) {
        const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
      }
      store[k] = String(v);
    },
    removeItem: (k) => { delete store[k]; },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; }
  };

  const FIXTURES = {
    'config/providers.json': null,
    'assets/_index/world_hierarchy.json': { areas: [{ id: 'area_01', name: 'region', fields: [
      { id: 'field_01_001', name: 'island', stages: [{ id: 'stage_01_001_04', name: 'home' }] }] }] },
    'assets/_index/npc_placement.json': { npcs: [] },
    'assets/_index/stage_background_map.json': {},
    'assets/_index/scenes.json': {},
    'assets/_index/ambient.json': [],
    'assets/_index/skins.json': [{ id: 'crf_skn_002_0001_01', hasSpine: true, preview: 'p.png' }]
  };

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    Math, JSON, Date, Object, Array, String, Number, Boolean, isFinite, parseInt, parseFloat,
    RegExp, Promise, Set, Map, Infinity, NaN, Error,
    document, localStorage,
    navigator: {}, location: { origin: 'http://127.0.0.1:8765', reload() {} },
    XMLHttpRequest: function () {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    innerWidth: 420, innerHeight: 860,
    fetch: (url) => {
      const key = String(url).replace(/^\.\//, '');
      if (key in FIXTURES) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(FIXTURES[key]) });
      }
      return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('404 ' + key)) });
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  /* The view layer and the orchestrator are stubbed: this suite owns the slot
     machinery in settings.js, and every App call it makes is recorded instead.
     Avatar/Sound need GL and audio, so they never load here. */
  sandbox.App = {
    history: [{ role: 'user', content: 'halo' }],
    memory: [{ k: 'note' }],
    _llmModels: [],
    toast(msg, isErr) { toasts.push({ msg: String(msg), isErr: !!isErr }); },
    showView(name) { calls.push('showView:' + name); },
    saveMemory() { calls.push('saveMemory'); },
    updateHud() { calls.push('updateHud'); },
    renderWorld() { calls.push('renderWorld'); },
    renderMemory() { calls.push('renderMemory'); },
    renderSkins() { calls.push('renderSkins'); },
    applyI18n() { calls.push('applyI18n'); },
    _loadSceneFor() { calls.push('loadScene'); },
    _title(w, t) { /* form primitive: not under test */ },
    _field(w, label, val, cb) { (w._fields = w._fields || []).push(label); },
    _select() {}, _switch() {}, _range() {}
  };
  sandbox.Avatar = { loadSkin() {}, setNotice() {} };
  sandbox.Sound = { setPlace() {}, setRoute() {}, unlock() {} };
  vm.createContext(sandbox);

  const load = (f) => {
    let src = fs.readFileSync(path.join(WEB, 'js', f), 'utf8');
    if (f === 'settings.js' && opts.settingsSrc) src = opts.settingsSrc(src);
    vm.runInContext(src, sandbox, { filename: f });
  };
  for (const f of ['util.js', 'config.js', 'i18n.js', 'api.js', 'providers.js', 'turn.js',
                   'echo.js', 'voice.js', 'memory.js', 'longterm.js', 'game.js', 'quests.js',
                   'daily.js', 'world.js', 'alarm.js', 'nsfw.js', 'settings.js']) load(f);

  /* The same lines App.init runs before any slot button can exist (app.js:132).
     Without them Game.s is null and the restore path has nothing to restore on. */
  sandbox.Game.load();
  sandbox.Daily.load();
  sandbox.Quests.ensure();
  sandbox.Memory.load();
  sandbox.Alarm.load();

  return { sandbox, store, toasts, calls, throwOn: (k) => { throwOn = k; }, localStorage };
}

/* The three slot rows, as the real form builds them. */
function renderRows(env) {
  const wrap = makeEl('slot-wrap');
  env.sandbox.Settings._renderSlots(wrap);
  return wrap._kids.map((row) => ({
    row,
    info: row._kids.find((k) => k.className === 'slot-info'),
    save: row._kids.find((k) => k.textContent === env.sandbox.I18n.t('slot.save')),
    load: row._kids.find((k) => k.textContent === env.sandbox.I18n.t('slot.load'))
  }));
}

/* ------------------------------------------------- 1. the round trip works */
console.log('\n# 1. 按下「保存到此槽」必须真的写进 localStorage');
{
  const env = makeEnv();
  const S = env.sandbox.Settings, C = env.sandbox.Config;
  C.set('profile.name', 'Ryza-player');
  C.set('state.stage', 'stage_01_001_04');
  env.sandbox.App.history = [{ role: 'user', content: 'halo' }];

  let rows = renderRows(env);
  eq(rows.length, 3, 'three slot rows are rendered');
  ok(rows.every((r) => r.info.textContent.indexOf(env.sandbox.I18n.t('slot.empty')) >= 0),
     'a fresh install shows three empty slots');
  ok(rows.every((r) => r.load.disabled === true), 'an empty slot cannot be loaded');

  rows[0].save.onclick();
  ok(env.store[SLOT_KEY] !== undefined, 'the save key was written at all');
  const written = JSON.parse(env.store[SLOT_KEY] || '[]');
  ok(!!written[0], 'slot 1 holds a snapshot');
  ok(!!written[0] && !!written[0].settings, 'the snapshot carries settings');
  ok(typeof written[0].label === 'string' && written[0].label.length > 0,
     'the snapshot is labelled with where the player was');
  eq(env.toasts.filter((t) => t.isErr).length, 0, 'a successful save raises no error');
  ok(env.toasts.some((t) => t.msg === env.sandbox.I18n.t('toast.saved')), 'save toasts 已保存');

  rows = renderRows(env);
  ok(rows[0].info.textContent.indexOf('Ryza-player') < 0,
     'the row is re-rendered from storage, not from memory');
  ok(rows[0].info.textContent.indexOf(env.sandbox.I18n.t('slot.empty')) < 0,
     'slot 1 no longer reads "Empty"');
  eq(rows[0].load.disabled, false, 'slot 1 can now be loaded');
  eq(rows[1].load.disabled, true, 'slot 2 still cannot');

  /* three slots coexist; a later save must not clobber the others */
  C.set('profile.name', 'second');
  rows[1].save.onclick();
  const two = JSON.parse(env.store[SLOT_KEY]);
  ok(!!two[0] && !!two[1], 'both slots survive');
  eq(two[1].settings.profile.name, 'second', 'slot 2 holds the later state');

  /* ---- the load path ---- */
  C.set('profile.name', 'wiped by the player');
  env.sandbox.App.history = [];
  env.toasts.length = 0;
  const before = renderRows(env);
  before[0].load.onclick();
  eq(C.section('profile').name, 'Ryza-player', 'loading slot 1 restores the profile');
  eq(env.sandbox.App.history.length, 1, 'loading restores the chat history');
  ok(env.calls.indexOf('showView:talk') >= 0, 'loading returns the player to the chat');
  eq(env.toasts.filter((t) => t.isErr).length, 0, 'a successful load raises no error');
}

/* ------------------------------------- 1b. 长期记忆随存档回滚（旧档不清空） */
console.log('\n# 1b. 长期记忆（longterm）跟着存档走，缺字段的旧存档不动它');
{
  const env = makeEnv();
  const LT = env.sandbox.LongTerm;
  LT.add('钓到一条大鱼', { date: '2026-09-19', category: 'general', importance: 2 });
  const rows = renderRows(env);
  rows[0].save.onclick();
  const snap = JSON.parse(env.store[SLOT_KEY])[0];
  ok(typeof snap.longterm === 'string' && snap.longterm.indexOf('钓到一条大鱼') >= 0,
     '快照里带着长期记忆');

  /* 存档后她又记了新东西，读档应当回到存档那一刻 */
  LT.add('忘不掉的新事', { date: '2026-09-25', category: 'promise', importance: 5 });
  eq(LT.list().length, 2, '（前置）读档前有两条');
  rows[0].load.onclick();
  eq(LT.list().length, 1, '读档把长期记忆回滚到存档那一刻');
  eq(LT.list()[0].summary, '钓到一条大鱼', '恢复的是存档里的那条');

  /* 旧存档（1.2.22 之前写的，没有 longterm 字段）不能把现在的记忆清空 */
  const legacy = JSON.parse(env.store[SLOT_KEY])[0];
  delete legacy.longterm;
  const keep = LT.list().length;
  eq(env.sandbox.Settings._applySnapshot(legacy), true, '旧存档仍然能读');
  eq(LT.list().length, keep, '缺 longterm 的旧存档不动长期记忆');
}

/* ------------------------------------- 2. a write that fails must be loud */
console.log('\n# 2. 写不进去的时候不能说「已保存」');
{
  const env = makeEnv();
  const rows = renderRows(env);
  env.throwOn('ryza.saves.v1');          /* quota, private mode, a full disk */
  env.toasts.length = 0;
  rows[0].save.onclick();
  eq(env.toasts.filter((t) => t.msg === env.sandbox.I18n.t('toast.saved')).length, 0,
     'no "Saved" toast is raised for a save that did not happen');
  ok(env.toasts.some((t) => t.isErr && t.msg === env.sandbox.I18n.t('slot.saveFail')),
     'the failure is shown as an error toast');
  ok(renderRows(env).every((r) => r.load.disabled === true),
     'nothing pretends to be saved in the list');
}

/* ------------------------------------------- 3. a broken snapshot is refused */
console.log('\n# 3. 读不出来的存档要说明，不能静默返回');
{
  const env = makeEnv({
    store: { [SLOT_KEY]: JSON.stringify([{ notASnapshot: true }, null, null]) }
  });
  const rows = renderRows(env);
  eq(rows[0].load.disabled, false, 'a slot with content is loadable on the face of it');
  env.toasts.length = 0;
  const applied = env.sandbox.Settings._applySnapshot({ notASnapshot: true });
  eq(applied, false, '_applySnapshot reports the refusal');
  ok(env.toasts.some((t) => t.isErr && t.msg === env.sandbox.I18n.t('slot.loadFail')),
     'the player is told the save could not be read');
  eq(env.sandbox.Settings._applySnapshot(null), false, 'a missing snapshot is refused too');
}

/* ------------------------------------------ 4. the bug class, statically */
console.log('\n# 4. 反向对照：把 SAVE_KEY 的声明拿掉，第 1 段必须炸');
{
  const broken = makeEnv({
    settingsSrc: (src) => src.replace(/^\s*var SAVE_KEY = .*$/m, '  /* declaration removed */')
  });
  ok(!/^\s*var SAVE_KEY = /m.test(fs.readFileSync(path.join(WEB, 'js', 'settings.js'), 'utf8')
      .replace(/^\s*var SAVE_KEY = .*$/m, '')),
     'the control really does strip the declaration');
  const rows = renderRows(broken);
  broken.sandbox.App.history = [{ role: 'user', content: 'x' }];
  rows[0].save.onclick();
  eq(broken.store[SLOT_KEY], undefined,
     'without the declaration nothing is written — this is what 1.2.19 shipped');
  ok(!broken.toasts.some((t) => t.msg === broken.sandbox.I18n.t('toast.saved')),
     'and the player is no longer told "Saved"');
  ok(broken.toasts.some((t) => t.isErr),
     'the hardening turns that silent death into a visible error');
}

console.log('\n# 5. 存储键必须和使用它的模块在同一个文件里声明');
{
  /* The split-leftover class in one rule: a module may read and write a
     localStorage key, but the name it uses has to be declared in that file.
     (A closure-local `var` in another module is invisible at runtime.) */
  const dir = path.join(WEB, 'js');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'spine-webgl.js') continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const declared = new Set();
    for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    /* 函数参数也是同一个文件里的声明（例：memory.js 的 readKey(key)）。
       不把参数算进来的话，「跨文件常量」和「本地参数」分不开。 */
    for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
      m[1].split(',').forEach((p) => {
        const n = p.trim().split(/[=\s]/)[0];
        if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
      });
    }
    for (const m of code.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*([A-Za-z_$][\w$]*)/g)) {
      if (!declared.has(m[1])) offenders.push(f + ' uses ' + m[1]);
    }
  }
  eq(offenders.length, 0, 'every storage-key identifier is local to its module' +
     (offenders.length ? ' — offenders: ' + offenders.join(', ') : ''));
  const appSrc = fs.readFileSync(path.join(WEB, 'js', 'app.js'), 'utf8');
  ok(!/\bvar SAVE_KEY\b/.test(appSrc),
     'app.js keeps no second copy of the slot key (one owner)');
}

/* --------------------------------------------------- 6. every locale speaks */
console.log('\n# 6. 存档槽与角色页的按钮在七种语言里都有词');
{
  const env = makeEnv();
  const I = env.sandbox.I18n;
  const keys = ['chara.saveBack', 'chara.clearMemory', 'chara.clearMemory.confirm',
                'chara.clearMemory.done', 'slot.title', 'slot.empty', 'slot.save',
                'slot.load', 'slot.saveFail', 'slot.loadFail'];
  const locales = I.LANGS.map((l) => l.id);
  eq(locales.length, 7, 'seven UI locales');
  const live = I.lang;
  for (const lg of locales) {
    I.setLang(lg);
    eq(I.lang, lg, lg + ': the locale exists');
    const missing = keys.filter((k) => I.t(k) === k);
    eq(missing.length, 0, lg + ': every slot/button key resolves' +
       (missing.length ? ' — missing ' + missing.join(', ') : ''));
  }
  /* The report that started this came from an Indonesian UI whose two bottom
     buttons were Chinese literals. zh/ja may contain CJK; id must not. */
  I.setLang('id');
  const cjk = /[\u3040-\u30ff\u4e00-\u9fff]/;
  ok(!cjk.test(I.t('chara.saveBack')), 'id: 「Save & back to chat」 is not Chinese');
  ok(!cjk.test(I.t('chara.clearMemory')), 'id: 「Clear chat memory」 is not Chinese');
  ok(!cjk.test(I.t('slot.saveFail')), 'id: the storage-full message is not Chinese');
  I.setLang(live);
}

console.log(failures ? '\nSAVE_SLOTS: ' + failures + ' FAILURES' : '\nSAVE_SLOTS: ALL PASS');
process.exit(failures ? 1 : 0);
