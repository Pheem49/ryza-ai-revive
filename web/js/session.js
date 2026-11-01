/* Dialogue session core: manages turn lifecycle, cancellation epochs, prompt
   context assembly, reply state extraction, and multi-speaker dispatch.
   Belongs to features layer — purely headless, zero DOM references. */
(function (global) {
  'use strict';

  var RPG_MODES = { chat: 1, story: 1, immersive: 1 };

  var Session = {
    history: [],
    _busy: false,
    _lastText: '',
    _listeners: {},

    /* ------------------------------------------------------------- events */
    on: function (event, handler) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(handler);
      var self = this;
      return function () {
        var list = self._listeners[event];
        if (!list) return;
        var idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },

    _emit: function (event, data) {
      var list = this._listeners[event];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          try {
            list[i](data);
          } catch (e) {
            if (typeof console !== 'undefined' && console.error) {
              console.error('Session listener error (' + event + '):', e);
            }
          }
        }
      }
    },

    /* -------------------------------------------------------------- state */
    isBusy: function () {
      return this._busy;
    },

    getHistory: function () {
      return this.history;
    },

    setHistory: function (h) {
      this.history = Array.isArray(h) ? h : [];
    },

    clearHistory: function () {
      this.history = [];
      if (global.Nsfw && Nsfw.reset) Nsfw.reset();
      this._emit('clear', {});
    },

    interrupt: function (reason) {
      var why = reason || 'interrupt';
      if (global.Turn && Turn.interrupt) {
        Turn.interrupt(why);
      }
      this._busy = false;
      this._emit('interrupt', { reason: why });
    },

    getLastText: function () {
      return this._lastText;
    },

    /* ----------------------------------------------------------- context */
    _sceneContext: function () {
      var st = (global.Config && Config.section('state')) || {};
      var parts = [];
      if (global.World && World.promptBlock) parts.push(World.promptBlock(st));
      parts.push(this._peopleBlock(st));
      if (global.World) parts.push(this._clockBlock(st));
      return parts.filter(Boolean).join('\n\n');
    },

    _rpgContext: function () {
      var st = (global.Config && Config.section('state')) || {};
      if (!RPG_MODES[st.mode]) return '';
      var p = [];
      if (global.Game && Game.promptBlock) p.push(Game.promptBlock());
      if (global.Quests && Quests.promptBlock) p.push(Quests.promptBlock());
      return p.filter(Boolean).join('\n\n');
    },

    _peopleBlock: function (st) {
      if (!global.World || !World.npcs) return '';
      var L = ['## この世界の人々（ライザ以外）'];
      var here = World.npcsAt ? World.npcsAt(st.stage, st.day || 1) : [];
      L.push('- いま同じ場所にいる人：' +
        (here.length ? here.map(function (n) {
          return (World.npcName ? World.npcName(n.id) : n.id) + (n.note ? '（' + n.note + '）' : '');
        }).join('、') : 'いない'));
      var known = {};
      ((World.npcs && World.npcs.npcs) || []).forEach(function (n) { known[n.id] = n; });
      var met = (global.Game && Game.s && Game.s.met_charas ? Game.s.met_charas : [])
        .map(function (id) { return known[id]; })
        .filter(Boolean).slice(0, 16);
      if (met.length) {
        L.push('- これまでに会った人：' + met.map(function (n) {
          return (World.npcName ? World.npcName(n.id) : n.id) + (n.note ? '（' + n.note + '）' : '');
        }).join('、'));
      }
      if (global.Npc && Npc.promptBlock) {
        var npcBlock = Npc.promptBlock(st, {
          appCfg: (global.Config && Config.section('app')) || {},
          translate: !!(global.Langs && Langs.llm && Langs.ui && Langs.llm() !== Langs.ui())
        });
        if (npcBlock) L.push('', npcBlock);
      }
      return L.join('\n');
    },

    _clockBlock: function (st) {
      var appCfg = (global.Config && Config.section('app')) || {};
      var mode = appCfg.timeMode || 'real';
      var hour = mode === 'flow' ? Math.floor(Number(st.gameHour) || 12)
               : mode === 'manual' ? (global.World && World.todStartHour ? World.todStartHour(st.tod) : 12)
               : new Date().getHours();
      return '## 現在時刻\n- 同伴 ' + (st.day || 1) + '日目／' +
        (global.World && World.todLabel ? World.todLabel(st.tod) : st.tod) + '（約' + hour + '時）';
    },

    _turnCurrent: function (epoch) {
      if (epoch == null) return true;
      if (!global.Turn || !Turn.epoch) return true;
      return Turn.epoch() === epoch;
    },

    _failKind: function (err) {
      var code = (err && typeof err === 'object' && err.code) || '';
      if (code === 'timeout' || code === 'net') return code;
      var m = String((err && err.message) || err || '');
      if (m === 'NO_KEY' || /NO_KEY|needKey/i.test(m)) return 'nokey';
      if (/401|403|unauthor|invalid[_ ]api[_ ]key|forbidden/i.test(m)) return 'auth';
      if (/model|not found|unsupported/i.test(m)) return 'model';
      return 'other';
    },

    /* ----------------------------------------------------------------- say */
    say: function (text) {
      var st = (global.Config && Config.section('state')) || {};
      var llmCfg = (global.Config && Config.section('llm')) || {};

      var ready = (global.Config && Config.llmReady) ? Config.llmReady() : !!llmCfg.apiKey;
      if (!ready) {
        this._emit('error', { kind: 'nokey', message: 'NO_KEY', canRetry: false });
        return Promise.reject(new Error('NO_KEY'));
      }

      if (global.Game) {
        var cost = Game.turnCost ? Game.turnCost(st.mode, st.style) : 1;
        if ((Game.faint && Game.faint()) || (Game.canAct && !Game.canAct(cost))) {
          this._emit('error', { kind: 'stamina', message: 'STAMINA_OUT', canRetry: false });
          return Promise.reject(new Error('STAMINA_OUT'));
        }
      }

      this._lastText = text;
      this._busy = true;

      var turnEpoch = (global.Turn && Turn.beginTurn) ? Turn.beginTurn('say') : null;

      if (global.Welcome && Welcome.mark) {
        Welcome.mark('talk');
      }

      if (global.LongTerm && LongTerm.note) {
        try { LongTerm.note('user', text); } catch (e) {}
      }

      this._emit('start', { text: text, epoch: turnEpoch });

      var self = this;
      return Api.chat(this.history, text, {
        mode: st.mode,
        style: st.style,
        epoch: turnEpoch,
        cue: text,
        rpgContext: this._rpgContext(),
        sceneSection: this._sceneContext(),
        nsfwSection: (global.Nsfw && Nsfw.screenFact) ? Nsfw.screenFact() : ''
      })
        .then(function (reply) {
          if (!self._turnCurrent(turnEpoch)) return null;

          self._busy = false;
          if (global.Turn && Turn.finishTurn) Turn.finishTurn();

          self.history.push({ role: 'user', content: text });

          if (global.Memory && Memory.ingest) {
            try { Memory.ingest(text, reply.text); } catch (e) {}
          }

          if (reply.state && typeof reply.state === 'object' && global.Game && Game.applyDelta) {
            Game.applyDelta(reply.state, 'llm');
          }

          if (global.Game && Game.spend) {
            var cost = Game.turnCost ? Game.turnCost(st.mode, st.style) : 1;
            Game.spend(cost, 'talk');
          }

          if (global.Nsfw && Nsfw.onTurn) {
            Nsfw.onTurn(reply);
          }

          var formattedContent = (global.Api && Api.formatHistoryReply)
            ? Api.formatHistoryReply(reply.text)
            : reply.text;

          self.history.push({
            role: 'assistant',
            content: formattedContent
          });

          if (global.LongTerm && LongTerm.note) {
            try { LongTerm.note('assistant', reply.text); } catch (e) {}
          }

          if (!(reply.state && reply.state.quest) && global.Quests && Quests.progressEvent) {
            Quests.progressEvent('talk');
          }

          self._emit('reply', {
            reply: reply,
            epoch: turnEpoch,
            userText: text
          });

          return reply;
        })
        .catch(function (e) {
          if (e && e.stale) return null;
          if (!self._turnCurrent(turnEpoch)) return null;

          self._busy = false;
          if (global.Turn && Turn.finishTurn) Turn.finishTurn();

          var kind = self._failKind(e);
          self._emit('error', {
            kind: kind,
            message: String((e && e.message) || ''),
            error: e,
            canRetry: kind !== 'nokey'
          });

          throw e;
        });
    }
  };

  global.Session = Session;
})(typeof window !== 'undefined' ? window : global);
