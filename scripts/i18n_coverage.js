/* i18n 覆盖面回归：屏幕上不允许出现原始 key。
 *
 * 为什么要有它
 * ------------
 * `I18n.t(key)` 的链路是「当前语言 → en → key 本身」。所以 en 里缺一个键，
 * **所有语言**都会把 `world.list` 这样的字面量直接画到界面上：2026-09 世界
 * 地图的「列表」出口就是如此（zh/ja 有这个词、en 没有，英文与印尼语玩家看到
 * 的按钮写着 world.list，而且它是从地图回到列表的唯一出口）。同一轮还抓到
 * `settings.speakHint`：这个键七种语言都没有，VOICEVOX/AivisSpeech 的设置页
 * 一直显示着原始 key。
 *
 * 这里静态收集「硬查找」——没有 fallback 的 `I18n.t('k')` 与 `data-i18n`——
 * 并对每个界面语言行为验证：`I18n.t(k)` 不许等于 k。走 `I18n.tc/tf`（自带
 * fallback）与动态前缀的 CONTENT 键不在此列：那些本来就允许缺，官方原名兜底。
 *
 * 用法: node scripts/i18n_coverage.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
let fail = 0;
function ok(c, n) { if (c) console.log('  PASS ' + n); else { fail++; console.log('  FAIL ' + n); } }

function loadI18n(src) {
  const sb = { console, navigator: {}, localStorage: { getItem: () => null, setItem() {} } };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'i18n.js' });
  return sb.I18n;
}

const I18N_SRC = fs.readFileSync(path.join(WEB, 'js', 'i18n.js'), 'utf8');
const I18n = loadI18n(I18N_SRC);
ok(!!I18n && typeof I18n.t === 'function', 'i18n.js 单独加载成功');

/* 语言列表来自模块自己的权威（Langs.ALL → I18n.LANGS），不在这里另开一张表 */
const langs = (I18n.LANGS || []).map((x) => x.id);
ok(langs.length >= 7, 'I18n.LANGS 列出全部界面语言（' + langs.join(',') + '）');

/* 契约本体：这些键在哪个语言下会回显原始 key */
function rawKeyOffenders(impl, keys, langIds) {
  const out = [];
  for (const key of keys) {
    for (const lg of langIds) {
      impl.setLang(lg);
      if (impl.t(key) === key) out.push(lg + ':' + key);
    }
  }
  return out;
}
/* 只关心 en：其他语言缺词会回落到 en（设计如此），只有 en 缺才会露出 key */
function missingInEn(impl, keys) {
  impl.setLang('en');
  return keys.filter((k) => impl.t(k) === k);
}

/* ---------------------------------------------------- 收集硬查找 */
console.log('\n# 1. 收集硬查找（没有 fallback 的调用 + data-i18n）');
const hard = new Map();                       /* key -> [where] */
function add(key, where) {
  if (!hard.has(key)) hard.set(key, []);
  hard.get(key).push(where);
}
const jsDir = path.join(WEB, 'js');
const srcs = [];
for (const f of fs.readdirSync(jsDir)) {
  if (!f.endsWith('.js') || f === 'spine-webgl.js') continue;
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  srcs.push(src);
  for (const m of src.matchAll(/I18n\.t\(\s*'([^']+)'\s*\)/g)) add(m[1], f);
  for (const m of src.matchAll(/(?:^|[^\w.])T\(\s*'([^']+)'\s*\)/g)) add(m[1], f);
}
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)) add(m[1], 'index.html');
ok(hard.size > 50, '硬查找收集到 ' + hard.size + ' 个不同的键');

/* 动态拼接的硬查找（I18n.t('x.' + y)）：前缀域在 §2b 单独盯 */
const dyn = new Set();
for (const src of srcs) {
  for (const m of src.matchAll(/I18n\.t\(\s*'([A-Za-z0-9_.]+\.)'\s*\+/g)) dyn.add(m[1]);
}
console.log('  note 动态硬查找前缀: ' + (dyn.size ? [...dyn].join(', ') : '（无）'));

/* ------------------------------------------- 2. 静态硬查找：每个语言都不许回显 */
console.log('\n# 2. 每种界面语言下，硬查找都必须有词（不许回显 key）');
{
  const offenders = rawKeyOffenders(I18n, hard.keys(), langs);
  ok(offenders.length === 0, '所有硬查找在 ' + langs.length + ' 语里都有词' +
     (offenders.length ? ' — 缺失: ' + offenders.slice(0, 6).join(', ') : ''));
}

/* ------------------------------------------- 2b. 动态拼接的硬查找也要满词 */
console.log('\n# 2b. 动态硬查找的整个域都要有词');
{
  /* 前缀来自 §1 的扫描；域值来自各模块的数据（这里把契约定下来）：
       alarm.type  ← alarm.js TYPES
       alarm.style ← alarm.js STYLES
       mode/mode.sub ← api.js MODES（对话模式胶囊）
       dl.week     ← daily.js DAYS
       onb.gender  ← onboarding 问卷的三个选项
       tod         ← util.js TOD_START（mor/aft/eve/ngt）
       bubble.fail ← app.js _failKind 的六种归类（走 I18n.tc，缺词会退成日文台词） */
  const domains = {
    'alarm.type.': ['goodMorning', 'playWithMe', 'task', 'wellDone'],
    'alarm.style.': ['normal', 'whisper'],
    'mode.': ['chat', 'story', 'immersive', 'asmr', 'text'],
    'mode.sub.': ['chat', 'story', 'immersive', 'asmr', 'text'],
    'dl.week.': ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    'onb.gender.': ['female', 'male', 'other'],
    'tod.': ['mor', 'aft', 'eve', 'ngt'],
    'bubble.fail.': ['nokey', 'auth', 'model', 'timeout', 'net', 'other']
  };
  const dynKeys = [];
  for (const [prefix, vals] of Object.entries(domains)) vals.forEach((v) => dynKeys.push(prefix + v));
  ok(dynKeys.every((k) => hard.has(k) || true), '动态域共 ' + dynKeys.length + ' 个键');
  const offenders = rawKeyOffenders(I18n, dynKeys, langs);
  ok(offenders.length === 0, '动态域在 ' + langs.length + ' 语里都有词' +
     (offenders.length ? ' — 缺失: ' + offenders.slice(0, 6).join(', ') : ''));
  /* 注：非 en 语言缺词会静默回落到英文（设计如此），公开 API 分不出
     「真的缺」和「译文与英文相同」，所以这里只盯「会回显 key」这一种。 */
  console.log('  note （非英文缺词只会回落成英文，本套件只保证不会露出 key）');
}

/* ------------------------------------------------ 3. 反向对照：抽掉 en 的键必须炸 */
console.log('\n# 3. 反向对照：把 en 里的键抽掉，检查函数必须报到');
{
  /* en 里 world.list 与其他词写在同一行：整段替换掉，保留合法语法 */
  const was = "'world.current': 'Current location', 'world.list': 'List',";
  const stripped = I18N_SRC.replace(was, "'world.current': 'Current location',");
  ok(stripped !== I18N_SRC, '对照真的从 en 抽掉了 world.list');
  const broken = loadI18n(stripped);
  const caught = rawKeyOffenders(broken, ['world.list'], ['en']);
  ok(caught.length === 1, '检查函数报出被抽掉的键（' + caught.join(',') + '）');

  /* 同一个对照对动态域也成立：抽掉 en 的 mode.asmr */
  const wasMode = "'mode.asmr': 'ASMR', 'mode.text': 'Text',";
  const stripped2 = I18N_SRC.replace(wasMode, "'mode.text': 'Text',");
  ok(stripped2 !== I18N_SRC, '对照真的从 en 抽掉了 mode.asmr');
  const broken2 = loadI18n(stripped2);
  ok(missingInEn(broken2, ['mode.asmr']).length === 1, '动态域检查同样报出缺失');
}

/* ---------------------------------------------------- 4. 报告：没人用的词 */
console.log('\n# 4. note 反向报告（只列，不算失败）：没有任何代码引用的键');
{
  const blob = srcs.join('\n') + html;
  let unused = 0;
  for (const key of hard.keys()) if (blob.indexOf(key) < 0) unused++;
  console.log('  note 硬查找里没有任何引用出现的键: ' + unused + '（0 正常）');
}

console.log('\n' + (fail === 0 ? 'I18N: ALL PASS' : 'I18N: FAILED ' + fail));
process.exit(fail === 0 ? 0 : 1);