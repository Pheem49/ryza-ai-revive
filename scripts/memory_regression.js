/* Two-layer memory + LLM packing helpers.
   Run: node scripts/memory_regression.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };

const store = {};
const sandbox = {
  console, Math, JSON, String, Array, RegExp, Object, Date, Number, isFinite,
  parseInt, parseFloat, Infinity, NaN, Set, Map, Promise,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = { getElementById() { return null; } };
sandbox.XMLHttpRequest = function () {};
sandbox.location = { origin: 'http://127.0.0.1:8765' };
vm.createContext(sandbox);

function load(f) {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'), sandbox, { filename: f });
}
load('util.js');
load('config.js');
load('api.js');
load('memory.js');

const { Memory, Api, Config } = sandbox;

Config.set('memory.enabled', true);
Config.set('memory.turnsPerSession', 2);
Config.set('memory.sessionCap', 2);
Config.set('memory.summaryCap', 3);
Memory.setSummarizer(function (items, kind) {
  return 'SUM:' + kind + ':' + items.length;
});
Memory.reset();

ok(!!Memory && typeof Memory.ingest === 'function', 'Memory exported');
ok(Memory.promptBlock() === '', 'empty store → no prompt block');

Memory.add('session-a', 'session');
Memory.add('session-b', 'session');

(async () => {
  await Memory.flushNow();
  let bag = Memory.list();
  ok(bag.sessions.length === 0 && bag.summaries.length === 1,
     'session cap folds all sessions into one summary');
  ok(bag.summaries[0].text === 'SUM:sessions:2', 'session fold uses summarizer');

  Memory.add('s1', 'session');
  await Memory.flushNow();
  bag = Memory.list();
  ok(bag.sessions.length === 1 && bag.summaries.length === 1,
     'a new session stays until the cap');

  const id = bag.summaries[0].id;
  ok(Memory.update(id, 'edited by player'), 'single card can be edited');
  ok(Memory.get(id).text === 'edited by player', 'edit persists');
  ok(Memory.remove(id), 'single card can be deleted');
  ok(!Memory.get(id), 'deleted card is gone');
  bag = Memory.list();
  ok(bag.summaries.length === 0 && bag.sessions.length === 1,
     'deleting a summary does not wipe sessions');

  Memory.reset();
  Memory.add('A', 'summary');
  Memory.add('B', 'summary');
  Memory.add('C', 'summary');
  await Memory.flushNow();
  bag = Memory.list();
  ok(bag.summaries.length === 1 && bag.summaries[0].text === 'SUM:summaries:3',
     'full summary layer folds into one same-layer card');

  Config.set('memory.sessionCap', 8);
  Config.set('memory.summaryCap', 8);
  Memory.reset();
  Memory.add('old-sum', 'summary');
  Memory.add('old-sess', 'session');
  Memory.add('new-sess', 'session');
  const block = Memory.promptBlock();
  const iSum = block.indexOf('old-sum');
  const iOld = block.indexOf('old-sess');
  const iNew = block.indexOf('new-sess');
  ok(iSum >= 0 && iOld >= 0 && iNew >= 0 && iSum < iOld && iOld < iNew,
     'prompt lists summaries first, newest session last (prefix cache)');

  Memory.reset();
  Memory.ingest('hello', 'やあ');
  Memory.ingest('again', 'うん');
  await Memory.flushNow();
  bag = Memory.list();
  ok(bag.pending.length === 0 && bag.sessions.length === 1,
     'two exchanges at turnsPerSession=2 flush into one session');

  /* --- packing / models --- */
  ok(Api.guessContext('gpt-4o-mini') === 128000, 'guess gpt-4o context');
  ok(Api.guessContext('unknown-local') === 0, 'unknown model has no guess');
  const or = Api.parseModelEntry({
    id: 'or/qwen', context_length: 40960,
    supported_parameters: ['reasoning', 'tools']
  });
  ok(or.context === 40960 && or.thinking === true, 'OpenRouter-style model meta');
  const bodyOff = Api.attachThinking({ model: 'x' }, { thinking: 'off' }, null);
  ok(!bodyOff.reasoning_effort && !bodyOff.enable_thinking && !bodyOff.reasoning,
     'thinking off + unknown protocol sends no extra fields');
  const bodyOai = Api.attachThinking({ model: 'o3' },
    { thinking: 'on', thinkingStyle: 'openai', thinkingEffort: 'high' }, null);
  ok(bodyOai.reasoning_effort === 'high', 'openai thinking style');
  const bodyNone = Api.attachThinking({ model: 'gpt-4o-mini' },
    { thinking: 'auto', thinkingStyle: 'auto', baseUrl: 'https://example.test/v1' }, null);
  ok(!bodyNone.reasoning_effort && !bodyNone.enable_thinking,
     'auto + unknown host does not send thinking fields');
  ok(Api.normalizeEffort('none') === 'off' && Api.normalizeEffort('xhigh') === 'xhigh',
     'effort aliases: none→off, xhigh kept for mapping');
  ok(Api.mapEffort('default', ['none', 'low', 'medium', 'high', 'xhigh']) == null,
     'default maps to omit');
  ok(Api.mapEffort('off', ['none', 'low', 'medium', 'high', 'xhigh']) === 'none',
     'off → OpenAI none');
  ok(Api.mapEffort('max', ['none', 'low', 'medium', 'high', 'xhigh']) === 'xhigh',
     'max → OpenAI xhigh');
  ok(Api.mapEffort('medium', ['low', 'high', 'max']) === 'high',
     'medium → GLM high (no mid rung, round up)');
  ok(Api.mapEffort('off', ['low', 'high', 'max']) === 'low',
     'off → GLM low (cannot disable)');
  ok(Api.mapEffort('high', ['max']) === 'max',
     'only-max model: any on-rung → max');
  const bodyDef = Api.attachThinking({ model: 'o3' },
    { thinking: 'on', thinkingStyle: 'openai', thinkingEffort: 'default' }, null);
  ok(!bodyDef.reasoning_effort, 'openai + default omits intensity');
  const bodyOffOai = Api.attachThinking({ model: 'o3' },
    { thinking: 'off', thinkingStyle: 'openai' }, null);
  ok(bodyOffOai.reasoning_effort === 'none', 'openai + thinking off sends none');
  const bodyMax = Api.attachThinking({ model: 'gpt-5.6-luna' },
    { thinking: 'on', thinkingStyle: 'openai', thinkingEffort: 'max' }, null);
  ok(bodyMax.reasoning_effort === 'xhigh', 'openai max wires as xhigh');
  const bodyGlm = Api.attachThinking({ model: 'glm-5.3' },
    { thinking: 'on', thinkingStyle: 'auto', thinkingEffort: 'medium',
      baseUrl: 'https://example.test/v1' }, null);
  ok(bodyGlm.thinking && bodyGlm.thinking.type === 'enabled' &&
     bodyGlm.reasoning_effort === 'high',
     'glm-5 id auto-detects and maps medium→high');
  const bodyGlmDef = Api.attachThinking({ model: 'glm-5.3' },
    { thinking: 'on', thinkingStyle: 'glm', thinkingEffort: 'default' }, null);
  ok(bodyGlmDef.thinking && bodyGlmDef.thinking.type === 'enabled' &&
     !bodyGlmDef.reasoning_effort,
     'glm + default enables thinking but leaves native intensity');
  const bodyQwenDef = Api.attachThinking({ model: 'qwen' },
    { thinking: 'on', thinkingStyle: 'qwen', thinkingEffort: 'default' }, null);
  ok(bodyQwenDef.enable_thinking === true && bodyQwenDef.thinking_budget == null,
     'qwen + default enables without budget');
  const metaLimit = Api.parseModelEntry({
    id: 'kimi-k3', limit: { context: 1048576 },
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['max'] }]
  });
  ok(metaLimit.context === 1048576 && metaLimit.thinking === true &&
     metaLimit.efforts[0] === 'max',
     'parses limit.context + reasoning_options when a URL actually sends them');
  ok(Api.estTokens('あいう') >= 3, 'CJK token estimate is at least char count-ish');

  const sys = Api.buildSystemPrompt('chat', 'voice', '', 'ja', 'いまの画面：普段の服を着ている。');
  const memLine = '## 長期記憶（下ほど新しい。事実だけ参照）\n- old fact';
  const sysM = Api.buildSystemPrompt('chat', 'voice', '', 'ja', 'いまの画面：普段の服を着ている。',
                                     '', memLine);
  ok(sysM.indexOf(memLine) > 0 &&
     sysM.indexOf(memLine) < sysM.indexOf('いまの画面'),
     'memory sits after static protocol, before per-turn screen facts');
  ok(/undress:off/.test(sys) && /on=脱いだ/.test(sys), 'tag protocol still present');

  /* --- #14：持久化不得静默丢卡片 --- */
  console.log('\n# 9. 记忆持久化：备份 / 脏数据 / 配额');
  {
    /* 1) 主键被写坏时，load 要从上一份好数据的备份恢复 */
    Memory.reset();
    Memory.add('backup-a', 'summary');
    Memory.add('backup-b', 'summary');          /* 这次 persist 会把 backup-a 那份存进 .bak */
    store[Memory.KEY] = '{"v":1,"summaries":[';   /* 截断的 JSON，正是配额写一半的样子 */
    Memory.load();
    ok(Memory.lastLoad() === 'recovered', '主键读不出时从备份恢复（lastLoad=recovered）');
    bag = Memory.list();
    ok(bag.summaries.some(c => c.text === 'backup-a'),
       '备份里有第一张卡（不是空白页）');

    /* 2) 主键和备份都读不出：原文件要留住，不能删 */
    delete store[Memory.KEY + '.bak'];
    delete store[Memory.KEY + '.corrupt'];
    store[Memory.KEY] = 'garbage{not json';
    Memory.load();
    ok(Memory.lastLoad() === 'corrupt', '两个都读不出时标记 corrupt，不假装空');
    ok(store[Memory.KEY + '.corrupt'] === 'garbage{not json',
       '脏数据另存为 .corrupt（给人工抢救的机会）');

    /* 3) 旧存档没有 longmem 字段时，restore 不得清空今天的卡片 */
    Memory.load();
    Memory.add('keep-me', 'summary');
    const kept = Memory.list().summaries.length;
    ok(Memory.restore(undefined) === false && Memory.restore(null) === false,
       'restore(undefined/null) 返回 false（这份存档没有记忆层）');
    ok(Memory.list().summaries.length === kept, '缺 longmem 的旧存档不清空现有记忆');
    ok(Memory.restore({ v: 1, sessions: [], summaries: [] }) === true &&
       Memory.list().summaries.length === 0,
       '显式的空快照仍然按快照恢复（这是玩家自己存过的状态）');

    /* 4) 配额失败要说出来，不能吞 */
    Memory.add('quota-probe', 'summary');
    const realSet = sandbox.localStorage.setItem;
    sandbox.localStorage.setItem = (k, v) => {
      if (k === Memory.KEY) throw new Error('QuotaExceededError');
      realSet(k, v);
    };
    ok(Memory.save() === false && Memory.lastWriteOk() === false,
       '配额失败：save 返回 false 且 lastWriteOk=false');
    sandbox.localStorage.setItem = realSet;
    ok(Memory.save() === true && Memory.lastWriteOk() === true, '恢复正常后写入成功');
    Memory.reset();
  }

  console.log(failures ? '\nMEMORY: ' + failures + ' FAILURES' : '\nMEMORY: ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
