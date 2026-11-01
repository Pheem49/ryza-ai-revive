/* Two-layer conversation memory. Independent of Game.s.memory (adventure
   log) and App.memory (raw diary the player can still browse).

   sessions  = one card per window of recent turns
   summaries = cards made from sessions; when this layer hits its cap, those
               cards fold into ONE new card still on this layer

   Prompt order is summaries then sessions (stable prefix, new session
   appended at the end) so prefix-cache hits survive a new 会话. */
(function (global) {
  'use strict';

  var KEY = 'ryza.longmem.v1';
  var TEXT_MAX = 2000;

  function cfg() {
    var m = {};
    try { m = (global.Config && Config.section('memory')) || {}; } catch (e) {}
    return {
      enabled: m.enabled !== false,
      turnsPerSession: clampInt(m.turnsPerSession, 8, 2, 32),
      sessionCap: clampInt(m.sessionCap, 8, 2, 24),
      summaryCap: clampInt(m.summaryCap, 8, 2, 24)
    };
  }

  function clampInt(v, d, lo, hi) {
    v = parseInt(v, 10);
    if (v !== v) v = d;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function uid() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function blank() {
    return { v: 1, pending: [], sessions: [], summaries: [] };
  }

  function clip(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  }

  function card(layer, text, n) {
    return { id: uid(), layer: layer, text: clip(text), at: Date.now(), n: n | 0 };
  }

  var state = blank();
  var busy = false;
  /* 上一次读到的、能解析的原文。persist 会把它转存到备份键，
     主键被写坏（配额截断 / 写一半被杀）时还能回滚。 */
  var lastGood = '';
  var lastLoad = 'empty';   /* ok | recovered | corrupt | empty（给 UI 一句实话） */
  var persistOk = true;

  function normalize(j) {
    if (!j || typeof j !== 'object' || j.v !== 1) return null;
    if (!Array.isArray(j.sessions) || !Array.isArray(j.summaries)) return null;
    return {
      v: 1,
      pending: Array.isArray(j.pending) ? j.pending : [],
      sessions: j.sessions.filter(validCard),
      summaries: j.summaries.filter(validCard)
    };
  }

  function readKey(key) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }

  /* true = 写进去了。false = 配额满/被拒——上层要能说出来，不能只会丢数据。 */
  function persist() {
    var text;
    try { text = JSON.stringify(state); } catch (e) { persistOk = false; return false; }
    try {
      /* 先备份上一份好数据，再覆盖主键：
         主键写一半就断电/被杀时，load 还能从备份回来。 */
      if (lastGood && lastGood !== text) {
        try { global.localStorage.setItem(KEY + '.bak', lastGood); } catch (e) {}
      }
      global.localStorage.setItem(KEY, text);
      lastGood = text;
      persistOk = true;
      return true;
    } catch (e) {
      persistOk = false;
      return false;
    }
  }

  function load() {
    var raw = null;
    try { raw = global.localStorage.getItem(KEY); } catch (e) {}
    var primary = readKey(KEY);
    if (primary) {
      state = primary;
      lastGood = JSON.stringify(state);
      lastLoad = 'ok';
      return state;
    }
    /* 主键在但读不出来：先把原文留一份，供人工/以后抢救；不删原键。 */
    if (raw) {
      try {
        if (!global.localStorage.getItem(KEY + '.corrupt')) {
          global.localStorage.setItem(KEY + '.corrupt', raw);
        }
      } catch (e) {}
    }
    var backup = readKey(KEY + '.bak');
    if (backup) {
      state = backup;
      lastLoad = 'recovered';
      return state;
    }
    state = blank();
    lastLoad = raw ? 'corrupt' : 'empty';
    return state;
  }

  function validCard(c) {
    return c && typeof c === 'object' && c.id && typeof c.text === 'string';
  }

  function fallbackText(items) {
    return items.map(function (it) {
      if (it.text) return it.text;
      var who = it.role === 'user' ? '君' : 'ライザ';
      return who + '：' + clip(it.content || it.text || '');
    }).join(' / ').slice(0, 800);
  }

  function formatPending(pending) {
    return pending.map(function (t) {
      var who = t.role === 'user' ? '君' : 'ライザ';
      return who + '：' + clip(t.text);
    }).join('\n');
  }

  /* Test seam: tests assign a sync function (see scripts/memory_regression.js).
     It short-circuits the prompt/LLM path entirely. */
  var _summarizer = null;
  /* The LLM call itself is injected by the host (app.js wires Api.complete) so
     this module never reaches into the transport layer — that reference used
     to make api.js <-> memory.js a two-way dependency. */
  var _llm = null;

  function summarize(items, kind) {
    if (typeof _summarizer === 'function') {
      try { return Promise.resolve(_summarizer(items, kind)); }
      catch (e) { return Promise.resolve(fallbackText(items)); }
    }
    var body = kind === 'pending'
      ? formatPending(items)
      : items.map(function (it) { return '・' + it.text; }).join('\n');
    var sys = '会話記憶の要約者。与えられた内容を短い箇条書き1本にまとめる。' +
              '固有名詞・約束・感情の変化を残す。タグもJSONも出力しない。200字以内。';
    if (typeof _llm === 'function') {
      try {
        return Promise.resolve(_llm(sys, body, { maxTokens: 280, temperature: 0.2 }))
          .then(function (t) { t = clip(t); return t || fallbackText(items); })
          .catch(function () { return fallbackText(items); });
      } catch (e) { return Promise.resolve(fallbackText(items)); }
    }
    return Promise.resolve(fallbackText(items));
  }

  function runQueue(fn) {
    if (busy) {
      return busy.then(function () { return fn(); });
    }
    busy = Promise.resolve().then(fn).then(function (v) {
      busy = false;
      return v;
    }, function (e) {
      busy = false;
      throw e;
    });
    return busy;
  }

  function promoteSessions() {
    var c = cfg();
    if (state.sessions.length < c.sessionCap) return Promise.resolve(false);
    var batch = state.sessions.slice();
    return summarize(batch, 'sessions').then(function (text) {
      state.sessions = [];
      state.summaries.push(card('summary', text, batch.length));
      persist();
      return true;
    }).then(function () { return promoteSummaries(); });
  }

  function promoteSummaries() {
    var c = cfg();
    if (state.summaries.length < c.summaryCap) return Promise.resolve(false);
    var batch = state.summaries.slice();
    return summarize(batch, 'summaries').then(function (text) {
      state.summaries = [card('summary', text, batch.length)];
      persist();
      return true;
    });
  }

  function flushPending() {
    if (!state.pending.length) return Promise.resolve(false);
    var batch = state.pending.slice();
    state.pending = [];
    persist();
    return summarize(batch, 'pending').then(function (text) {
      state.sessions.push(card('session', text, Math.ceil(batch.length / 2)));
      persist();
      return promoteSessions();
    });
  }

  function maybeRoll() {
    var c = cfg();
    if (!c.enabled) return Promise.resolve();
    return runQueue(function () {
      var chain = Promise.resolve();
      if (state.pending.length >= c.turnsPerSession * 2) {
        chain = chain.then(flushPending);
      }
      return chain.then(promoteSessions).then(promoteSummaries);
    }).catch(function () {});
  }

  var Memory = {
    KEY: KEY,
    load: load,
    save: persist,

    /* 最近一次 load 的结果：ok / recovered（用了备份）/ corrupt / empty。
       UI 可以据此说一句实话，而不是让玩家过几天才发现记忆没了。 */
    lastLoad: function () { return lastLoad; },
    /* 最近一次写入是否成功（配额满了会 false；数据仍在内存里）。 */
    lastWriteOk: function () { return persistOk; },
    cfg: cfg,
    snapshot: function () {
      return JSON.parse(JSON.stringify(state));
    },
    restore: function (snap) {
      /* An old save slot has no `longmem` field at all. That must NOT wipe
         today's cards — the slot simply cannot speak about this layer. */
      if (snap == null) return false;
      if (typeof snap !== 'object') { state = blank(); persist(); return true; }
      state = {
        v: 1,
        pending: Array.isArray(snap.pending) ? snap.pending : [],
        sessions: (snap.sessions || []).filter(validCard),
        summaries: (snap.summaries || []).filter(validCard)
      };
      persist();
      return true;
    },
    reset: function () { state = blank(); persist(); },

    /* One user+assistant exchange. Never throws into the talk loop. */
    ingest: function (userText, assistantText) {
      try {
        if (!cfg().enabled) return;
        var u = clip(userText), a = clip(assistantText);
        if (!u && !a) return;
        if (u) state.pending.push({ role: 'user', text: u, at: Date.now() });
        if (a) state.pending.push({ role: 'assistant', text: a, at: Date.now() });
        persist();
        maybeRoll();
      } catch (e) {}
    },

    flushNow: function () {
      if (!cfg().enabled) return Promise.resolve();
      return runQueue(function () {
        return flushPending().then(promoteSessions).then(promoteSummaries);
      }).catch(function () {});
    },

    /* Context nearly full: dump pending so the next turn's near-window shrinks. */
    notifyPressure: function () {
      try { Memory.flushNow(); } catch (e) {}
    },

    list: function (layer) {
      if (layer === 'summary') return state.summaries.slice();
      if (layer === 'session') return state.sessions.slice();
      return { pending: state.pending.slice(), sessions: state.sessions.slice(),
               summaries: state.summaries.slice() };
    },

    pendingTurns: function () {
      return Math.ceil(state.pending.length / 2);
    },

    get: function (id) {
      var i;
      for (i = 0; i < state.summaries.length; i++) {
        if (state.summaries[i].id === id) return state.summaries[i];
      }
      for (i = 0; i < state.sessions.length; i++) {
        if (state.sessions[i].id === id) return state.sessions[i];
      }
      return null;
    },

    update: function (id, text) {
      var c = Memory.get(id);
      if (!c) return false;
      c.text = clip(text);
      persist();
      return true;
    },

    remove: function (id) {
      var n = state.summaries.length + state.sessions.length;
      state.summaries = state.summaries.filter(function (c) { return c.id !== id; });
      state.sessions = state.sessions.filter(function (c) { return c.id !== id; });
      if (state.summaries.length + state.sessions.length === n) return false;
      persist();
      return true;
    },

    add: function (text, layer) {
      var t = clip(text);
      if (!t) return null;
      var c = card(layer === 'summary' ? 'summary' : 'session', t, 0);
      if (c.layer === 'summary') state.summaries.push(c);
      else state.sessions.push(c);
      persist();
      maybeRoll();
      return c;
    },

    /* Highest layer first, newest session last — prefix-cache friendly. */
    promptBlock: function () {
      if (!cfg().enabled) return '';
      if (!state.summaries.length && !state.sessions.length) return '';
      var L = ['## 長期記憶（下ほど新しい。事実だけ参照）'];
      state.summaries.forEach(function (c) { L.push('- ' + c.text); });
      state.sessions.forEach(function (c) { L.push('- ' + c.text); });
      return L.join('\n');
    },

    setSummarizer: function (fn) { _summarizer = fn; },

    /* Host-injected summarisation call: fn(systemPrompt, body, opts) -> text.
       Left unset, summaries fall back to plain listing (never throws). */
    setLLM: function (fn) { _llm = (typeof fn === 'function') ? fn : null; }
  };

  load();
  global.Memory = Memory;
})(typeof window !== 'undefined' ? window : globalThis);
