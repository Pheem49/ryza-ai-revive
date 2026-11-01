/* 长期记忆回归（longterm.js）。
 *
 * 断言重点
 * --------
 *   · 条目/摘要两层各自的作用，以及**受保护条目不静默丢弃**
 *   · 相关度挑选确实按关键词/日期命中加分（不是全量注入）
 *   · 归纳失败（模型返回垃圾）时记忆仍然前进，而不是卡住
 *   · 存储上限生效，且溢出内容是**折进 digest** 而不是删除
 *
 * 用法: node scripts/longterm_regression.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let fail = 0;
function ok(c, n) { if (c) console.log('  PASS ' + n); else { fail++; console.log('  FAIL ' + n); } }
function eq(a, b, n) { ok(a === b, n + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

const store = {};
const sandbox = {
  console, Promise, Math, JSON, Date, Object, Array, String, Number, RegExp, parseInt, isFinite, Error,
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/longterm.js'), 'utf8'), sandbox, { filename: 'longterm.js' });
const LT = sandbox.LongTerm;

/* 固定时钟，回归才可复现 */
LT.setClock(() => ({ iso: '2026-09-20T12:00:00', day: '2026-09-20' }));

(async () => {
  console.log('# 1. 基本累积与提示词块');
  LT._reset();
  LT.note('user', '我昨天钓到一条很大的鱼');
  LT.note('assistant', '真厉害呀，晚上要不要炖了？');
  eq(LT.pendingTurns(), 2, '两轮待归纳');
  eq(LT.promptBlock(''), '', '还没有条目时提示词块为空');

  console.log('# 2. 条目 + 摘要两层');
  LT.add('玩家钓到一条大鱼', { date: '2026-09-19', category: 'general', importance: 2, keywords: ['鱼', '钓'] });
  LT.add('莱莎答应下次带玩家去灯塔', { date: '2026-09-20', category: 'promise', importance: 5, keywords: ['灯塔', '约定'] });
  eq(LT.list().length, 2, '两条条目');
  eq(LT.digest(), '', '还没 digest');
  {
    const blk = LT.promptBlock('');
    ok(/出来事/.test(blk), '提示词块含条目段');
    ok(/灯塔/.test(blk), '条目内容进了提示词');
  }

  console.log('# 3. 相关度挑选（不是全量注入）');
  for (let i = 0; i < 20; i++) {
    LT.add('普通日常第 ' + i + ' 条', { date: '2026-08-0' + ((i % 9) + 1), importance: 1 });
  }
  {
    const picked = LT._select('灯塔的事', 3);
    eq(picked.length, 3, '按 limit 挑选');
    ok(picked.some(e => /灯塔/.test(e.summary)), '命中关键词的条目被选中');
    const high = LT._select('', 1);
    ok(high[0].importance >= 5 || LT._isProtected(high[0]), '空提示词时优先高重要度/受保护');
  }

  console.log('# 4. 受保护条目不静默丢弃');
  {
    const P = LT.LIMITS.ENTRY_LIMIT;
    for (let i = 0; i < P + 20; i++) {
      LT.add('填充条目 ' + i, { date: '2026-07-01', importance: 3 });
    }
    const kept = LT.list();
    ok(kept.length <= P + 1, '条目数受上限约束 (got ' + kept.length + ', limit ' + P + ')');
    ok(kept.some(e => e.category === 'promise'), '受保护类别（promise）仍在');
    ok(LT.protectedEntries().length >= 1, '受保护条目可单列');
    ok(LT.digest().length > 0, '被折出的内容进了 digest（不是删除）');
  }

  console.log('# 5. 归纳：正常返回');
  LT._reset();
  LT.setClock(() => ({ iso: '2026-09-21T09:00:00', day: '2026-09-21' }));
  LT.note('user', '我们说好下周去海边');
  let calls = 0;
  LT.setLLM(function (sys, body) {
    calls++;
    ok(/JSON/.test(sys), '系统提示要求 JSON');
    ok(body.indexOf('dialogue') !== -1, '请求体带对话');
    return Promise.resolve(JSON.stringify({
      digest: '最近聊到去海边',
      entries: [{ date: '2026-09-21', category: 'promise', importance: 5,
                  summary: '约定下周去海边', keywords: ['海边', '约定'] }]
    }));
  });
  const obj = await LT.consolidate();
  ok(!!obj, '归纳返回对象');
  eq(calls, 1, '模型被调用一次');
  eq(LT.list().length, 1, '新增一条条目');
  ok(/海边/.test(LT.digest()), 'digest 被更新');
  eq(LT.pendingTurns(), 0, '待归纳清空');

  console.log('# 6. 归纳失败（模型给垃圾）时记忆继续前进');
  LT.note('user', '今天下雨了');
  LT.setLLM(function () { return Promise.resolve('这不是 JSON，只是一句话'); });
  const r6 = await LT.consolidate();
  eq(r6, null, '垃圾返回 -> null');
  eq(LT.pendingTurns(), 0, '待归纳仍然清空（不卡住）');
  ok(/下雨了/.test(LT.digest()), '内容被折进 digest');

  console.log('# 7. 归纳抛错也不影响对话');
  LT.setLLM(function () { return Promise.reject(new Error('网络挂了')); });
  LT.note('user', '她今天有点累');
  const r7 = await LT.consolidate();
  eq(r7, null, '异常 -> null');
  ok(true, '没有把异常抛给调用方');

  console.log('# 8. 去重：同一天同一件事更新而不是新增');
  LT._reset();
  LT._merge({ entries: [{ date: '2026-09-21', category: 'general', importance: 3,
                          summary: '莱莎学会了新配方' }] });
  LT._merge({ entries: [{ date: '2026-09-21', category: 'general', importance: 4,
                          summary: '莱莎学会了新配方！' }] });
  eq(LT.list().length, 1, '重复的相似条目只留一条');
  eq(LT.list()[0].importance, 4, '重要度取较高值');

  console.log('# 9. 导出 / 导入');
  const dump = LT.export();
  LT._reset();
  eq(LT.list().length, 0, '重置后为空');
  ok(LT.import(dump), '导入成功');
  eq(LT.list().length, 1, '条目数恢复');

  console.log('# 10. 受保护条目在「写进存储」这一步也不能被切掉（#14）');
  {
    const P = LT.LIMITS.ENTRY_LIMIT;
    LT._reset();
    for (let i = 0; i < P + 3; i++) {
      LT.add('不能忘的约定 ' + i, { date: '2026-09-02', category: 'promise', importance: 5 });
    }
    eq(LT.list().length, P + 3, 'enforceLimit 把超额的受保护条目全留在内存里');
    LT.load();                                   /* 从 localStorage 重读 */
    eq(LT.list().length, P + 3, '持久化后受保护条目一条不少');
    ok(LT.list().every(e => e.category === 'promise'), '回来的确实都是受保护条目');
  }

  console.log('# 11. 存档槽用的 snapshot / restore（替换语义，脏数据不猜）');
  {
    LT._reset();
    LT.add('存档那一刻的事实', { date: '2026-09-20', category: 'general', importance: 3 });
    const snap = LT.snapshot();
    LT.add('存档之后的新事', { date: '2026-09-25', category: 'general', importance: 3 });
    eq(LT.list().length, 2, '（前置）读档前两条');
    ok(LT.restore(snap) === true, 'restore 接受快照');
    eq(LT.list().length, 1, 'restore 是替换而不是追加');
    eq(LT.list()[0].summary, '存档那一刻的事实', '恢复的是快照里的那条');
    ok(LT.restore('not json{') === false, '脏快照返回 false');
    eq(LT.list().length, 1, '脏快照不改变现有记忆');
    ok(LT.restore(undefined) === false, '缺字段的旧存档返回 false');
  }

  console.log((fail === 0 ? 'ALL PASS' : 'FAILED ' + fail));
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
