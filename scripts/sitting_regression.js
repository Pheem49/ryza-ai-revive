/* 坐姿变体回归（官方 SittingSets / SittingMandatorySlots）。
 *
 * 官方数据事实（由本回归断言，防以后改动或读错字段）：
 *   SittingSets 是 {newId, previousId, weight} 四元组；
 *   **只有「保持当前坐姿」的对是 99999，所有「切换」对都是 0** ⇒ 官方不自动切换；
 *   SittingMandatorySlots 规定 sitting_agura 时 leg 槽必须被驱动。
 *
 * 用法: node scripts/sitting_regression.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GESTURE = path.join(ROOT, 'web/assets/spine/crf_chr_002/crf_skn_002_0001_01/crf_skn_002_0001_01_gesture.json');

let fail = 0;
function ok(c, n) { if (c) console.log('  PASS ' + n); else { fail++; console.log('  FAIL ' + n); } }
function eq(a, b, n) { ok(a === b, n + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ---- 只加载 avatar.js 需要的最小环境 ---- */
const store = {};
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Math, JSON, Date, Object, Array, String, Number,
  isFinite, parseInt, parseFloat, RegExp, Infinity, NaN, Error, Uint8Array, Float32Array,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; },
                  removeItem: k => { delete store[k]; } },
  document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add(){}, remove(){} }, appendChild(){}, setAttribute(){} }) },
  navigator: {},
  spine: { Physics: { none: 0, pose: 1, update: 2 }, Skeleton: function () {}, AnimationState: function () {} },
  Image: function () {}, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['util.js', 'config.js', 'avatar.js']) {
  if (f === 'config.js' || f === 'util.js') {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js', f), 'utf8'), sandbox, { filename: f });
  }
}
/* avatar.js 需要 Util；它自己从 window.Util 取，已在上下文里 */
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/avatar.js'), 'utf8'), sandbox, { filename: 'avatar.js' });
const Avatar = sandbox.Avatar;

console.log('# 1. 官方数据自检');
const g = JSON.parse(fs.readFileSync(GESTURE, 'utf8'));
const sets = g.emotionalGesture.SittingSets || [];
const mandatory = g.emotionalGesture.SittingMandatorySlots || [];
eq(sets.length, 4, 'SittingSets 有 4 条');
eq(mandatory.length, 1, 'SittingMandatorySlots 有 1 条');
const switchPairs = sets.filter(x => x.newId !== x.previousId);
ok(switchPairs.length === 2, '两条是切换对（normal→agura / agura→normal）');
ok(switchPairs.every(x => Number(x.weight) === 0),
  '官方把「切换」的权重全设成 0（作者禁用自动切换）');
const stayPairs = sets.filter(x => x.newId === x.previousId);
ok(stayPairs.every(x => Number(x.weight) > 0), '「保持」的权重都 > 0');
eq(mandatory[0].SittingId, 'sitting_agura', '强制槽位属于 sitting_agura');
eq(mandatory[0].SlotId, 'leg', '被强制的槽位是 leg');

console.log('\n# 2. 代码读到的是同一份数据');
Avatar.gesture = g;
eq(Avatar._sittingSets().length, 4, '_sittingSets 读到 4 条');
eq(Avatar._sittingMandatory().length, 1, '_sittingMandatory 读到 1 条');

console.log('\n# 3. 自动切换：官方数据下必须为空');
Avatar._sittingId = 'sitting_normal';
eq(Avatar.sittingAutoTargets().length, 0, 'normal 下没有自动切换目标（权重 0）');
Avatar._sittingId = 'sitting_agura';
eq(Avatar.sittingAutoTargets().length, 0, 'agura 下也没有');

console.log('\n# 4. 反向对照：把权重改成 >0，自动切换必须出现');
{
  const g2 = JSON.parse(JSON.stringify(g));
  g2.emotionalGesture.SittingSets.forEach(x => {
    if (x.newId !== x.previousId) x.weight = 5;
  });
  Avatar.gesture = g2;
  Avatar._sittingId = 'sitting_normal';
  const t = Avatar.sittingAutoTargets();
  eq(t.length, 1, '权重 >0 时出现 1 个自动切换目标');
  eq(t[0].id, 'sitting_agura', '目标是 agura');
  Avatar.gesture = g;   /* 还原 */
}

console.log('\n# 5. 强制槽位随坐姿变化');
Avatar._sittingId = 'sitting_normal';
Avatar._sitSlotCache = null;
eq(Avatar.sittingMandatorySlots().length, 0, 'normal 没有强制槽位');
Avatar.setSittingVariant('sitting_agura', function () {});
eq(Avatar.sittingMandatorySlots().join(','), 'leg', 'agura 强制 leg 槽');
Avatar.setSittingVariant('sitting_normal', function () {});
eq(Avatar.sittingMandatorySlots().length, 0, '切回 normal 后无强制');

console.log('\n# 6. 非法坐姿被拒');
{
  let err = null;
  Avatar.setSittingVariant('no_such_sitting', function (e) { err = e; });
  ok(!!err, '未知坐姿被拒绝');
  eq(Avatar._sittingId, 'sitting_normal', '拒绝后坐姿不变');
}

/* 7. #13：盘腿要有玩家可点的入口（官方权重把自动切换关掉了，只读数据永远
   看不到 agura）。这里钉住「数据驱动 + 能记住 + 站姿不显示」三件事。 */
console.log('\n# 7. 坐姿变体的可切换性（#13 盘腿）');
{
  Avatar.gesture = g;
  Avatar._loadedSkelId = 'crf_skn_002_0001_01';
  eq(Avatar.sittingVariants().join(','), 'sitting_normal,sitting_agura',
     '官方坐装有两个坐姿变体');
  eq(Avatar.sittingSwitchable(), true, '坐着时盘腿切换键可用');

  Avatar.setSittingVariant('sitting_agura');
  eq(Avatar.currentSittingVariant(), 'sitting_agura', '点了之后是盘腿');
  eq(sandbox.Config.section('state').sittingVariant, 'sitting_agura',
     '坐姿变体写进存档（setEmotion 每轮都会重设 _sittingId）');
  eq(Avatar._sittingFromPosture(), 'sitting_agura',
     '_sittingFromPosture 会读回玩家选的盘腿');

  /* 站着时不显示，也不把盘腿算进来 */
  Avatar._loadedSkelId = 'crf_skn_002_0001_99';
  eq(Avatar.sittingSwitchable(), false, '站着时不显示盘腿键');
  eq(Avatar._sittingFromPosture(), 'sitting_normal', '站姿下不保留坐姿变体');

  /* 旧存档里的脏值必须回落，而不是把 _sittingId 设成不存在的 id */
  Avatar._loadedSkelId = 'crf_skn_002_0001_01';
  sandbox.Config.set('state.sittingVariant', 'sitting_bogus');
  eq(Avatar._sittingFromPosture(), 'sitting_normal', '未知的存档值回落普通坐姿');
  sandbox.Config.set('state.sittingVariant', '');
}

console.log('\n# 8. 反向对照：只有一种坐姿的服装不出现切换键');
{
  const g3 = JSON.parse(JSON.stringify(g));
  g3.emotionalGesture.SittingSets = g3.emotionalGesture.SittingSets
    .filter(x => x.newId === 'sitting_normal' && x.previousId === 'sitting_normal');
  Avatar.gesture = g3;
  Avatar._loadedSkelId = 'crf_skn_002_0001_01';
  eq(Avatar.sittingVariants().join(','), 'sitting_normal', '单变体只列一个 id');
  eq(Avatar.sittingSwitchable(), false, '单变体不显示切换键');
  let err = null;
  Avatar.setSittingVariant('sitting_agura', function (e) { err = e; });
  ok(!!err, '数据里没有的坐姿被拒（导入 ZIP 也一样）');
  Avatar.gesture = g;   /* 还原 */
}

/* 9. UI 入口与文案：数据能切，还得有人能点到它（#13 的原始问题是「怎么激活」）。 */
console.log('\n# 9. 盘腿键的 UI 与文案');
{
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  ok(/id="btn-sit-variant"/.test(html), 'index.html 有盘腿键');
  const appjs = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
  ok(/btn-sit-variant/.test(appjs) && /sittingSwitchable/.test(appjs),
     'app.js 按 sittingSwitchable 显示它');
  ok(/posture\.aguraTip/.test(appjs) && /posture\.sitNormal/.test(appjs),
     '标签用动作语义（点下去会发生什么），不是当前状态');
  const i18n = fs.readFileSync(path.join(ROOT, 'web/js/i18n.js'), 'utf8');
  ['posture.agura', 'posture.aguraTip', 'posture.sitNormal', 'posture.sitNormalTip']
    .forEach(k => {
      const n = (i18n.match(new RegExp("'" + k.replace('.', '\\.') + "'\\s*:", 'g')) || []).length;
      ok(n >= 4, k + ' 在 zh/ja/en/id 四语里都有词（找到 ' + n + ' 处）');
    });
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED ' + fail));
process.exit(fail === 0 ? 0 : 1);
