/* longterm.js — 长期记忆：带日期的条目 + 压缩摘要。

   为什么要有它（与 memory.js 的分工）
   ----------------------------------
   memory.js 是「近窗卡片的压缩层」：一段对话压成一张卡，卡满了同层再压。
   它回答的是「最近聊过什么」，但回答不了「三个月前她答应过我什么」。

   这一层补上那件事，做法参考 Atelier R'Coagula 的 longmem 设计（两种做法合并）：
     entries[]  精确、带日期、带分类、带关键词、带重要度的事实
                → 每轮按相关度挑 ≤ SELECT_LIMIT 条进提示词
                → **受保护类别或重要度 5 的条目不静默丢弃**
     digest     一段按时间顺序的散文，装「不值得单独占条目、丢了又可惜」的内容
                → 永远注入（有上限），提示词成本恒定

   两者互补：卡片层管最近，这一层管长线；同一件事不会被两边都记（条目优先）。

   依赖注入（沿用本项目约定）
   --------------------------
   · setLLM(fn)   —— 归纳用的模型调用；不注入则退化为「只累积不归纳」，不抛错
   · setClock(fn) —— 取当前时间字符串（回归用固定时钟）
   没有 DOM、没有网络、没有 localStorage 之外的副作用（本模块只读写 localStorage）。
*/
(function (global) {
  'use strict';

  var KEY = 'ryza.longterm.v1';
  var ENTRY_LIMIT = 40;          /* 条目上限，超出的折进 digest */
  var DIGEST_MAX = 1600;         /* digest 存储上限 */
  var DIGEST_PROMPT_MAX = 800;   /* digest 每轮注入上限 */
  var SELECT_LIMIT = 12;         /* 每轮交给模型的条目数 */
  var SUMMARY_MAX = 120;         /* 单条 summary 长度 */
  var KEYWORD_MAX = 8;
  var PENDING_MAX = 20;          /* 未归纳的轮数上限 */
  var DIALOGUE_MAX = 12000;      /* 归纳输入上限，防小上下文模型被撑爆 */

  /* 受保护类别：这些条目即使超出上限也不删（只能由新内容取代） */
  var PROTECTED = ['promise', 'confession', 'deep_hurt',
                   'relationship_turning_point', 'major_life_event'];

  /* 「回忆提示」触发词：命中就提升相关度 */
  var RECENT_CUE = /昨天|前天|之前|上次|还记得|记得|remember|yesterday|昨日|前回|あの時/;

  var CONSOLIDATE_SYS = [
    '你负责维护有限、可靠的长期记忆。只输出 JSON，不要 Markdown 或解释。',
    '格式：{"digest":"按时间顺序的概略散文","entries":[{"date":"YYYY-MM-DD",',
    '"category":"类别","importance":1,"summary":"简洁事实","status":"active",',
    '"keywords":["关键词"]}]}。',
    '合并旧记忆与近期对话并去重；同一事件更新原条目，不重复新增。',
    '只保留稳定偏好、重要经历、关系变化、未完成约定与未来确有价值的信息；',
    '普通寒暄、一次性客套、重复信息应删除。entries 最多 ' + ENTRY_LIMIT + ' 条。',
    '不适合单独成条但丢掉可惜的内容并进 digest（按时间顺序，≤ ' + DIGEST_MAX + ' 字）。',
    'importance 1-5。誓言/承诺用 promise，告白用 confession，深刻伤害用 deep_hurt，',
    '关系转折用 relationship_turning_point，重大人生事件用 major_life_event；',
    '这些类别必须设为 5，除非近期对话明确撤回或解决，否则不删。不要编造日期与细节。'
  ].join('\n');

  var _llm = null;      /* fn(system, user, opts) -> Promise<string> */
  var _clock = null;    /* fn() -> { iso, day } */
  var _writeOk = true;  /* 最近一次 persist 是否真的写进去了 */

  function nowInfo() {
    if (_clock) return _clock();
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return {
      iso: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()),
      day: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    };
  }

  function clip(s, n) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  }

  function blank() {
    return { v: 1, updatedAt: '', digest: '', entries: [], pending: [] };
  }

  var state = blank();

  function load() {
    var raw = 'null';
    try { raw = localStorage.getItem(KEY) || 'null'; } catch (e) {}
    var j = null;
    try { j = JSON.parse(raw); } catch (e) {}
    if (j && j.v === 1 && Array.isArray(j.entries)) {
      state = {
        v: 1,
        updatedAt: String(j.updatedAt || ''),
        digest: clip(j.digest, DIGEST_MAX),
        entries: j.entries.filter(validEntry).map(normEntry),
        pending: (j.pending || []).filter(validTurn).slice(-PENDING_MAX)
      };
    } else {
      state = blank();
    }
    return state;
  }

  function persist() {
    try {
      /* 序列化上限：entry 数由 enforceLimit() 保证（受保护条目可超上限，
         它们就是不丢的东西）；digest / pending 各自有上限。 */
      var out = {
        v: 1, updatedAt: state.updatedAt, digest: clip(state.digest, DIGEST_MAX),
        entries: state.entries.map(normEntry),
        pending: state.pending.slice(-PENDING_MAX)
      };
      localStorage.setItem(KEY, JSON.stringify(out));
      _writeOk = true;
      return true;
    } catch (e) { _writeOk = false; return false; /* 配额满了不能崩，由 lastWriteOk 告知 */ }
  }

  function validEntry(e) {
    return e && typeof e === 'object' && typeof e.summary === 'string' && e.summary;
  }
  function normEntry(e) {
    return {
      id: e.id || ('e' + Math.random().toString(36).slice(2, 9)),
      date: clip(e.date, 10) || nowInfo().day,
      category: clip(e.category, 32) || 'general',
      importance: Math.max(1, Math.min(5, parseInt(e.importance, 10) || 3)),
      summary: clip(e.summary, SUMMARY_MAX),
      status: (e.status === 'retired') ? 'retired' : 'active',
      keywords: (Array.isArray(e.keywords) ? e.keywords : [])
        .map(function (k) { return clip(k, 16); }).filter(Boolean).slice(0, KEYWORD_MAX)
    };
  }
  function validTurn(t) {
    return t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string';
  }

  /* 受保护条目：类别在名单里，或重要度 5 */
  function isProtected(e) {
    return PROTECTED.indexOf(e.category) !== -1 || e.importance >= 5;
  }

  /* 相关度：命中关键词/日期/最近提示词就加分。
     这不是语义检索（本项目没有 embedding），是与提示词的字面匹配——
     够用且可解释，比「全量注入」省 token。 */
  function score(e, cue) {
    var s = e.importance;
    if (e.status !== 'active') s -= 3;
    if (!cue) return s;
    var low = cue.toLowerCase();
    if (e.date && cue.indexOf(e.date) !== -1) s += 4;
    e.keywords.forEach(function (k) {
      if (k && low.indexOf(String(k).toLowerCase()) !== -1) s += 3;
    });
    if (e.summary && low.indexOf(e.summary.slice(0, 8).toLowerCase()) !== -1) s += 3;
    if (RECENT_CUE.test(cue)) s += 1;
    return s;
  }

  function selectEntries(cue, limit) {
    var live = state.entries.filter(function (e) { return e.status === 'active'; });
    return live
      .map(function (e) { return { e: e, s: score(e, cue) }; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, limit || SELECT_LIMIT)
      .map(function (x) { return x.e; });
  }

  /* 超上限时：受保护的留住，其余折进 digest 的说明里（不静默删除） */
  function enforceLimit() {
    if (state.entries.length <= ENTRY_LIMIT) return 0;
    /* 受保护条目**全部**留下（上限只用于非受保护条目）——
       原文保证「受保护类别或重要度 5 的条目不静默丢弃」，
       早先的版本把超额受保护条目也折进 digest，等于让承诺只对前 40 条成立。 */
    var keepIds = {};
    var protectedCount = 0;
    state.entries.forEach(function (e) {
      if (isProtected(e)) { keepIds[e.id] = 1; protectedCount++; }
    });
    var room = Math.max(0, ENTRY_LIMIT - protectedCount);
    var rest = state.entries.filter(function (e) { return !keepIds[e.id]; })
      .sort(function (a, b) {
        return (b.importance - a.importance) ||
               String(b.date).localeCompare(String(a.date));
      });
    rest.slice(0, room).forEach(function (e) { keepIds[e.id] = 1; });
    /* 保留原顺序，只删掉真正被折叠的那些 */
    var folded = state.entries.filter(function (e) { return !keepIds[e.id]; });
    state.entries = state.entries.filter(function (e) { return !!keepIds[e.id]; });
    if (folded.length) {
      var note = folded.map(function (e) { return e.date + ' ' + e.summary; }).join('；');
      state.digest = clip((state.digest ? state.digest + ' ' : '') + note, DIGEST_MAX);
    }
    return folded.length;
  }

  /* 去重键：日期 + 归一化摘要（去标点/空白/大小写）前 14 字。
     不做语义相似度（本项目没有 embedding），但对「同一件事换个说法」够用。 */
  function sameKey(e) {
    var t = String(e.summary || '')
      .replace(/[\s　]+/g, '')
      .replace(/[。、，．,.!！?？「」『』（）()【】\[\]:：;；…—~〜-]/g, '')
      .toLowerCase();
    return String(e.date) + '#' + t.slice(0, 14);
  }

  function parseConsolidation(text) {
    var s = String(text || '').trim();
    /* 模型可能套 ```json ```，剥掉 */
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
  }

  function mergeConsolidation(obj) {
    if (!obj) return false;
    var added = 0;
    if (typeof obj.digest === 'string' && obj.digest.trim()) {
      state.digest = clip(obj.digest, DIGEST_MAX);
    }
    var incoming = (Array.isArray(obj.entries) ? obj.entries : [])
      .filter(validEntry).map(normEntry);
    incoming.forEach(function (ne) {
      /* 去重：同一天 + 相似的 summary 视为同一件事，更新而不是新增 */
      var dup = null;
      var key = sameKey(ne);
      state.entries.forEach(function (e) {
        if (dup) return;
        if (sameKey(e) === key) dup = e;
      });
      if (dup) {
        dup.summary = ne.summary;
        dup.importance = Math.max(dup.importance, ne.importance);
        dup.category = ne.category;
        dup.keywords = ne.keywords;
        dup.status = ne.status;
      } else {
        state.entries.push(ne);
        added++;
      }
    });
    enforceLimit();
    state.updatedAt = nowInfo().iso;
    persist();
    return added > 0 || incoming.length > 0;
  }

  var LongTerm = {
    LIMITS: { ENTRY_LIMIT: ENTRY_LIMIT, DIGEST_MAX: DIGEST_MAX, SELECT_LIMIT: SELECT_LIMIT,
              PENDING_MAX: PENDING_MAX, PROTECTED: PROTECTED },

    /* 回归用：把内部状态摊开（只读快照） */
    _state: function () { return state; },
    _reset: function () { state = blank(); persist(); },

    setLLM: function (fn) { _llm = (typeof fn === 'function') ? fn : null; },
    setClock: function (fn) { _clock = (typeof fn === 'function') ? fn : null; },

    load: load,

    /* 最近一次写入是否成功（配额满时 false；内存里的状态不丢）。 */
    lastWriteOk: function () { return _writeOk; },

    /* 记一轮对话（未归纳）。够 PENDING_MAX 就尝试归纳一次。 */
    note: function (role, text, opts) {
      var t = clip(text, 600);
      if (!t || (role !== 'user' && role !== 'assistant')) return false;
      state.pending.push({ role: role, text: t, at: nowInfo().iso });
      while (state.pending.length > PENDING_MAX) state.pending.shift();
      persist();
      if (!(opts && opts.noConsolidate)) LongTerm.maybeConsolidate();
      return true;
    },

    pendingTurns: function () { return state.pending.length; },

    /* 归纳：把 entries + digest + pending 交给模型，取回合并后的结果。
       没有注入 LLM 时**不抛错**，只返回 null（退化为纯累积）。 */
    consolidate: function () {
      if (!_llm) return Promise.resolve(null);
      var body = JSON.stringify({
        now: nowInfo().iso,
        previous: { digest: state.digest, entries: state.entries },
        dialogue: state.pending
      });
      if (body.length > DIALOGUE_MAX) body = body.slice(0, DIALOGUE_MAX);
      return Promise.resolve(_llm(CONSOLIDATE_SYS, body, { maxTokens: 1200 }))
        .then(function (text) {
          var obj = parseConsolidation(text);
          /* 先把待归纳的内容留一份：模型给不出可用 JSON 时要靠它兜底。
             （早先在这里先清 pending，兜底就永远拿到空串 —— 回归抓到的 bug。） */
          var pending = state.pending.slice();
          state.pending = [];
          if (!obj) {
            var note = pending.map(function (p) { return p.role + ': ' + p.text; }).join(' | ');
            if (!note) note = '（本轮归纳未返回可用 JSON）';
            state.digest = clip((state.digest ? state.digest + ' ' : '') + note, DIGEST_MAX);
            persist();
            return null;
          }
          mergeConsolidation(obj);
          return obj;
        })
        .catch(function () {
          return null;      /* 归纳失败不影响对话 */
        });
    },

    maybeConsolidate: function () {
      if (state.pending.length < PENDING_MAX) return Promise.resolve(null);
      return LongTerm.consolidate();
    },

    /* 提示词块：digest 永远注入（截断），条目按相关度挑 ≤ SELECT_LIMIT。
       cue 是本轮用户说的话，用于相关度。 */
    promptBlock: function (cue) {
      var L = [];
      var digest = clip(state.digest, DIGEST_PROMPT_MAX);
      if (digest) {
        L.push('## 長期記憶（概略）');
        L.push(digest);
      }
      var picked = selectEntries(cue || '', SELECT_LIMIT);
      if (picked.length) {
        L.push('## 長期記憶（出来事）');
        picked.forEach(function (e) {
          L.push('- [' + e.date + '] ' + e.summary);
        });
      }
      return L.join('\n');
    },

    add: function (summary, opts) {
      opts = opts || {};
      var ne = normEntry({
        date: opts.date, category: opts.category, importance: opts.importance,
        summary: summary, keywords: opts.keywords
      });
      if (!ne.summary) return null;
      state.entries.push(ne);
      enforceLimit();
      persist();
      return ne;
    },

    list: function (opts) {
      opts = opts || {};
      if (opts.activeOnly) {
        return state.entries.filter(function (e) { return e.status === 'active'; });
      }
      return state.entries.slice();
    },

    digest: function () { return state.digest; },

    /* 受保护/重要条目：给玩家看的「不能忘的事」 */
    protectedEntries: function () {
      return state.entries.filter(isProtected);
    },

    remove: function (id) {
      var n = state.entries.length;
      state.entries = state.entries.filter(function (e) { return e.id !== id; });
      if (state.entries.length === n) return false;
      persist();
      return true;
    },

    /* 导出/导入（换设备用） */
    export: function () {
      return JSON.stringify({
        v: 1, updatedAt: state.updatedAt, digest: state.digest,
        entries: state.entries.map(normEntry)
      });
    },

    /* 存档槽用：快照里存的是这份 JSON 字符串。
       与 import 的区别是 restore 是**替换**（存档是一份时间点），
       并且读不出来时什么都不改（不能因为一个坏字段清空记忆）。 */
    snapshot: function () { return LongTerm.export(); },
    restore: function (json) {
      var obj = null;
      try { obj = (typeof json === 'string') ? JSON.parse(json) : json; } catch (e) { return false; }
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.entries)) return false;
      state.digest = clip(obj.digest, DIGEST_MAX);
      state.entries = obj.entries.filter(validEntry).map(normEntry);
      state.updatedAt = String(obj.updatedAt || state.updatedAt || '');
      enforceLimit();
      persist();
      return true;
    },
    import: function (json) {
      var obj = null;
      try { obj = JSON.parse(json); } catch (e) { return false; }
      if (!obj || !Array.isArray(obj.entries)) return false;
      state.digest = clip(obj.digest, DIGEST_MAX);
      obj.entries.filter(validEntry).forEach(function (e) { state.entries.push(normEntry(e)); });
      enforceLimit();
      persist();
      return true;
    },

    /* 供回归直接验的纯函数 */
    _score: score,
    _isProtected: isProtected,
    _select: selectEntries,
    _parse: parseConsolidation,
    _merge: mergeConsolidation
  };

  load();
  global.LongTerm = LongTerm;
})(typeof window !== 'undefined' ? window : globalThis);
