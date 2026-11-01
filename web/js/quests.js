/* Quest engine (source: features/talk/models/quest_clear_detector.dart,
   state_updated_reducer.dart, talk/widgets/quest_sheet.dart, and the
   recovered wire keys dynamic_quest{_type,_goal,_obstacle,_cost,_no},
   need_quest_gen, quest_pending_advance, quest8_goal / quest8_earned).

   The official quest board was server-driven (`/v1/mission-board` masters
   are not in the APK), so the 8-stage main chain below is reconstructed
   from the pack's own copy: 「あたしと一緒にお店を始めたり / 色んな人と出会い
   一緒に冒険したり / アイテムを調合して / まずは船を手に入れて / 船で自由に
   旅へ出よう」. Quest 8 finishing = sailing = the world map past area_01
   (クーケン島) unlocks. Beyond the chain, side quests are LLM-generated
   (need_quest_gen) with a local pool fallback, mirroring 「無限のクエスト
   生成」 minus the paywall.

   All state lives on Game.s.quest (+ history in Game.s.flags.quest_log). */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ definitions */
  var CHAIN = [
    { no: 1, type: 'talk',    title: 'まずは会話をしてみよう',
      desc: 'ライザと会話して、お互いのことにもっと慣れる。',
      goal: 'ライザと4回話す',            need: 4, cost: 1 },
    { no: 2, type: 'explore', title: '島のあちこちを冒険',
      desc: 'ワールドマップを開いて、別の場所へ移動する。',
      goal: '別のステージへ2回移動',      need: 2, cost: 2 },
    { no: 3, type: 'gather',  title: '素材集めの冒険',
      desc: '冒険の材料集め。バッグに素材を詰めてこよう。',
      goal: '素材を3つ集める',            need: 3, cost: 3 },
    { no: 4, type: 'craft',   title: 'はじめての調合',
      desc: '集めた素材で、あたしと一緒に調合に挑戦！',
      goal: '調合を1回成功させる',        need: 1, cost: 3 },
    { no: 5, type: 'battle',  title: '進路を阻む魔物',
      desc: '冒険の途中で魔物が出た。調合アイテムも使って突破しよう。',
      goal: '戦闘に1回勝つ',              need: 1, cost: 4 },
    { no: 6, type: 'shop',    title: 'お店を一日経営してみよう',
      desc: 'いらないアイテムを並べて、お小遣い稼ぎ。',
      goal: 'お店でアイテムを売る',       need: 1, cost: 4 },
    { no: 7, type: 'build',   title: '船の材料を集めて造船',
      desc: '「まずは船を手に入れて」。船には部品が4つ必要らしい。',
      goal: '船の部品を4つそろえる',      need: 4, cost: 5 },
    { no: 8, type: 'sail',    title: '船で自由に旅へ出よう',
      desc: '造船を完成させて、クーケン島の外へ！世界地図が解放される。',
      goal: '資金200Gで出航する',         need: 1, cost: 2 }
  ];

  var TYPE_ICON = {
    talk: 'chara', explore: 'world_map', gather: 'bag', craft: 'cauldron',
    battle: 'fire', shop: 'shop', build: 'asterisk', sail: 'quest_map_ai'
  };

  var PRAISES = [
    'すごい、クリアおめでとう！',
    '次のクエストもがんばろう',
    'すごい！次はどんな冒険にする？'
  ];

  /* Side-quest pool (fallback + 「让莱莎想一个」 without an LLM key).
     Written in the game's register, drawn from recovered dialogue. */
  var POOL = [
    { type: 'craft',   title: '新しいレシピ', desc: 'まだ作ったことのない調合を、ライザと考える。', goal: '調合を1回成功させる', need: 1, cost: 3 },
    { type: 'gather',  title: '水源の材料',   desc: '水源の絶壁まわりで、新しい材料を探す。',       goal: '素材を2つ集める',     need: 2, cost: 3 },
    { type: 'explore', title: '星を見に行こう', desc: '夜のカーク群島、星見の高台まで一緒に歩く。', goal: '夜のステージへ移動',   need: 1, cost: 2 },
    { type: 'battle',  title: '廃村の住人',   desc: '忘れ去られた廃村で、邪魔するやつを退治する。', goal: '戦闘に1回勝つ',       need: 1, cost: 4 },
    { type: 'shop',    title: '移動販売の一日', desc: '港の広場でちょっと商売してみない？',         goal: 'お店でアイテムを売る', need: 1, cost: 4 },
    { type: 'talk',    title: '思い出話',     desc: 'ふたりが初めて会った日のことを、ゆっくり思い出す。', goal: 'ライザと3回話す', need: 3, cost: 1 },
    { type: 'gather',  title: 'おやつ探し',   desc: '甘いものの材料を集めて、あたしのおやつを作る。', goal: '素材を2つ集める',    need: 2, cost: 2 },
    { type: 'explore', title: '遺跡の探索',   desc: '封印の祭殿の奥まで、一緒に見て回ろう。',       goal: '別のステージへ移動',   need: 1, cost: 3 }
  ];

  /* Deterministic action tables — so the game plays with no LLM key. */
  var AREA_LOOT = {
    area_01: ['emeralia', 'uni', 'wasser', 'honey', 'shell', 'mushroom', 'driftwood'],
    area_02: ['ore', 'wasser', 'shell', 'ironwood', 'emeralia'],
    area_03: ['honey', 'mushroom', 'ironwood', 'emeralia', 'cloth'],
    area_04: ['ore', 'cloth', 'charm', 'mushroom'],
    area_05: ['relic', 'cloth', 'ore', 'ironwood']
  };
  var RECIPES = [
    { out: 'bottle', name: '回復のボトル', in: [['emeralia', 1], ['wasser', 1]] },
    { out: 'bomb',   name: '爆弾瓶',       in: [['uni', 1], ['wasser', 1], ['ore', 1]] },
    { out: 'charm',  name: 'お守りの指輪', in: [['relic', 1], ['cloth', 1]] }
  ];
  var PART_ITEMS = ['driftwood', 'ironwood', 'cloth', 'ore'];
  var PART_NAMES = { driftwood: '船底の竜骨材', ironwood: 'マストの堅木', cloth: '大きな帆布', ore: '魔石入りの留め金' };
  var MONSTERS = [
    { i: 1, name: 'モコモコ', area: 1 }, { i: 2, name: 'ビッグツノ', area: 1 },
    { i: 3, name: '溶岩カニ', area: 2 }, { i: 4, name: '森の番人', area: 3 },
    { i: 5, name: '遺跡の守卫像', area: 4 }, { i: 6, name: '星霜の竜', area: 5 }
  ];

  /* Item naming/valuation belong to the module that owns the catalogue
     (game.js). This file used to carry identical copies of both. */
  function itemName(id) { return Game.itemName(id); }

  function nowQuest() { return Game.s.quest || null; }
  function setQuest(q) { Game.s.quest = q; Game.save(); Game.emit('quest'); }

  /* content-localisation helpers (ja strings below are the shipped fallback) */
  function L(key, fb) { return (window.I18n && I18n.tc) ? I18n.tc(key, fb) : fb; }
  function TF(key, fb, map) {
    return (window.I18n && I18n.tf) ? I18n.tf(key, fb, map) : fb;
  }

  /* ------------------------------------------------------- host-injected ports
     Gameplay states intent; the host decides how it is presented. Injecting
     these is what keeps this module from reaching into App / Sound / Fx / Api
     (see scripts/layering_check.js) — and it is the same convention avatar.js
     (setNotice/setVoiceSource) and memory.js (setLLM) use. All default to
     inert, so the module still works standalone in the headless regressions. */
  var _celebrate = null;   /* fn()               — reward feedback (se + confetti) */
  var _present = null;     /* fn(res)            — outcome of an offline action */
  var _generate = null;    /* fn(msgs, opts) -> Promise<{text}>  — LLM quest text */
  var _notice = null;      /* fn(msg, isErr)     — progress/result toast */

  function celebrate() {
    if (!_celebrate) return;
    try { _celebrate(); } catch (e) { /* presentation must never break gameplay */ }
  }

  function notify(msg, isErr) {
    if (!_notice) return;
    try { _notice(msg, !!isErr); } catch (e) { /* ditto */ }
  }

  var Quests = {
    PRAISES: PRAISES,
    CHAIN: CHAIN,

    /* ---------------------------------------------------------- lifecycle */
    ensure: function () {
      if (!Game.s.quest) Quests.startNo(Game.flag('quest_no', 0) + 1 || 1);
      return Game.s.quest;
    },
    active: function () { return Game.s.quest || null; },
    isSide: function (q) { q = q || nowQuest(); return !!q && q.no > 8; },

    startNo: function (no) {
      var def = CHAIN[no - 1];
      var q;
      if (def) {
        q = JSON.parse(JSON.stringify(def));
        q.k = 'q.' + no;
      } else {
        q = JSON.parse(JSON.stringify(POOL[Math.floor(Math.random() * POOL.length)]));
        q.k = 'pq.' + (1 + Math.floor(Math.random() * POOL.length));
        q.no = 100 + (Game.flag('side_done', 0));
        q.type = q.type || 'talk';
      }
      q.step = 0;
      q.complete = false;
      q.side = no > 8;
      q.obstacle = Quests._obstacle(q);
      q.reward = { exp: 30 + Math.min(no, 8) * 15, money: 20 + Math.min(no, 8) * 20 };
      Game.setFlag('quest_no', no);
      setQuest(q);
      return q;
    },

    /* live text (re-resolves when the UI language changes). Old saves /
       fixtures may lack q.k — derive it from the quest number. */
    keyOf: function (q) {
      if (!q) return '';
      if (q.k) return q.k;
      return q.side ? '' : 'q.' + q.no;
    },
    titleOf: function (q) { return q ? L(Quests.keyOf(q) + '.title', q.title) : ''; },
    descOf: function (q) { return q ? L(Quests.keyOf(q) + '.desc', q.desc) : ''; },
    goalOf: function (q) { return q ? L(Quests.keyOf(q) + '.goal', q.goal) : ''; },

    /* 「無限のクエスト生成」 without the paywall: LLM invents a side quest,
       pool fallback keeps it working offline. */
    generate: function (useLLM) {
      if (!useLLM || !window.Config || !Config.llmReady()) {
        var q = Quests.startNo(9);
        return Promise.resolve(q);
      }
      /* side quests need a text model; without the injected generator (or a
         key) the local pool below is the honest fallback */
      if (typeof _generate !== 'function') {
        return Promise.resolve(Quests.startNo(9));
      }
      return _generate([], [
        'ライザと遊ぶRPGクエストを1つ生成して。',
        '次のJSONだけ出力（説明不要）:',
        '{"type":"talk|explore|gather|craft|battle|shop","title":"...","desc":"...","goal":"...","need":2,"cost":3}',
        'type は talk/explore/gather/craft/battle/shop のいずれか1つ。',
        'need は2〜5、cost は1〜5。',
        'title/desc/goal は ' + ((window.I18n && I18n.LANG_NAMES && window.Langs) ? (I18n.LANG_NAMES[Langs.llm()] || Langs.llm()) : '日本語') + 'で書くこと。'
      ].join('\n'), { mode: 'chat', style: 'text', standalone: true }).then(function (r) {
        var m = /\{[\s\S]*\}/.exec(r.text || '');
        if (!m) throw new Error('bad quest json');
        var j = JSON.parse(m[0]);
        var qq = Quests.startNo(9);
        qq.type = (j.type && TYPE_ICON[j.type]) ? j.type : 'talk';
        qq.title = String(j.title || qq.title).slice(0, 40);
        qq.desc = String(j.desc || '').slice(0, 120);
        qq.goal = String(j.goal || qq.goal).slice(0, 60);
        qq.need = Util.clamp(parseInt(j.need, 10) || 2, 1, 8);
        qq.cost = Util.clamp(parseInt(j.cost, 10) || 3, 1, 6);
        qq.obstacle = Quests._obstacle(qq);
        setQuest(qq);
        return qq;
      }).catch(function () { return Quests.startNo(9); });
    },

    _obstacle: function (q) {
      var byType = {
        gather: 'いい素材は少し奥まで入らないと採れないみたい。',
        craft: '調合は失敗しやすいから、材料は余裕をもって集めとこ。',
        battle: 'あ、強いのが出たら逃げてもいいからね…たぶん。',
        shop: '売れるか微妙だけど、やってみないと分からない！',
        build: '部品はどれも大きくて、一回じゃ運べそうにない。',
        explore: '最近道の様子がちょっと変なんだよね。',
        talk: '',
        sail: '出航には資金も必要。お店で稼いでおこう。'
      };
      var fb = byType[q.type] || '';
      return L('qobs.' + q.type, fb);
    },

    /* ------------------------------------------------------- progression */
    /* Deterministic event feed used by app.js (talk turn / stage move). */
    progressEvent: function (what, amount) {
      var q = nowQuest();
      if (!q || q.complete) return null;
      var hit =
        (what === 'talk'   && q.type === 'talk') ||
        (what === 'explore'&& q.type === 'explore') ||
        (what === 'gather' && q.type === 'gather');
      if (!hit) return null;
      q.step = Math.min(q.need, (q.step | 0) + (amount || 1));
      if (q.step >= q.need) return Quests.clear();
      setQuest(q);
      return q;
    },

    /* Reducer entry: a `<state>` quest block from the LLM. */
    onQuestDelta: function (d, origin) {
      if (!d || typeof d !== 'object') return null;
      var q = nowQuest();
      if (!q) { Quests.ensure(); q = nowQuest(); }
      var touched = false;
      if (d.step_add != null) {
        q.step = Util.clamp((q.step | 0) + (parseInt(d.step_add, 10) || 0), 0, q.need);
        touched = true;
      }
      if (d.progress != null && d.step_add == null) {
        q.step = Util.clamp(parseInt(d.progress, 10) || 0, 0, q.need);
        touched = true;
      }
      ['desc', 'goal', 'obstacle', 'activity'].forEach(function (k) {
        if (typeof d[k] === 'string' && d[k]) { q[k === 'activity' ? 'activity' : k] = d[k].slice(0, 160); touched = true; }
      });
      if (touched) setQuest(q);
      if (d.complete === true || q.step >= q.need) {
        if (!q.complete) Quests.clear();
      }
      return q;
    },

    clear: function () {
      var q = nowQuest();
      if (!q || q.complete) return q;
      q.complete = true;
      var reward = q.reward || { exp: 30, money: 20 };
      Game.addExp(reward.exp);
      Game.addMoney(reward.money);
      Game.remember(TF('mem.cleared', '「{title}」をクリア！ +{exp}EXP / +{money}G',
        { title: Quests.titleOf(q), exp: reward.exp, money: reward.money }));
      var log = Game.s.flags.quest_log || [];
      log.push({ no: q.no, type: q.type, title: q.title, at: Date.now() });
      if (log.length > 40) log = log.slice(-40);
      Game.s.flags.quest_log = log;
      if (q.no > 8) Game.setFlag('side_done', Game.flag('side_done', 0) + 1);
      setQuest(q);
      celebrate();
      Quests.showClear(q);
      if (q.no === 8) Game.s.sailed = true;    /* sail quest → world unlock */
      Game.save();
      Quests._pendingAdvance = true;
      return q;
    },

    /* Called from App after the clear overlay is acknowledged. */
    takeNext: function () {
      if (!Quests._pendingAdvance) { Quests.ensure(); return nowQuest(); }
      Quests._pendingAdvance = false;
      var prev = nowQuest();
      var no = prev ? prev.no + 1 : 1;
      if (no > 8) return Quests.startNo(9);
      return Quests.startNo(no);
    },

    pendingAdvance: function () { return !!Quests._pendingAdvance; },

    /* ------------------------------------------------------- action engine
       Each action: stamina-priced, deterministic, returns
         { ok, line, action, deltas? } — App shows `line` in the bubble. */
    doAction: function (actType, ctx) {
      var q = nowQuest();
      ctx = ctx || {};
      if (!q || q.complete) return { ok: false, line: L('qact.noquest', '今はクエストなし。新しいお題を考えてもらおう。') };
      if (!Game.canAct(q.cost)) return { ok: false, faint: true, line: L('qact.hungry', '……お腹すいた。気絶しちゃう前に、安全なところで寝たいな…') };

      var match = (actType || q.type);
      if (match !== q.type) return { ok: false, line: L('qact.mismatch', '今のクエストと違うことをしたかったの？') };
      if (!Game.spend(q.cost, 'quest')) return { ok: false, faint: true, line: 'スタミナが足りないよ…' };
      var fn = Quests['act_' + q.type];
      var res = fn ? fn(q, ctx) : { ok: false, line: 'まだできないことみたい。' };
      if (res && res.ok) {
        setQuest(q);
        /* action filled the last step → clear (showClear inside guards
           against double-fire) */
        if (q.step >= q.need && !q.complete) Quests.clear();
      }
      Game.emit('quest');
      return res;
    },

    act_talk: function (q) {
      return { ok: false, line: L('qact.talk.hint', 'これは会話で進むクエストだよ。あたしに話しかけて？') };
    },
    act_explore: function (q) {
      return { ok: false, line: L('qact.explore.hint', 'ワールドマップから移動するたびに進行するよ。') };
    },
    act_gather: function (q) {
      var area = ctx_area(q);
      var table = AREA_LOOT[area] || AREA_LOOT.area_01;
      var got = [];
      var n = 1 + (Math.random() < 0.45 ? 1 : 0);
      for (var i = 0; i < n; i++) {
        var id = table[Math.floor(Math.random() * table.length)];
        if (Game.addItem('you', id, 1)) got.push(itemName(id));
      }
      if (!got.length) return { ok: false, line: L('qact.gather.full', 'バッグがパンパン…いらないものを売らないと入らないよ。') };
      q.step = Math.min(q.need, (q.step | 0) + got.length);
      Game.addExp(6);
      var done = q.step >= q.need;
      var tail = done ? L('qact.gather.done', 'これで十分！')
                      : TF('qact.gather.more', 'あと {n} 個！', { n: q.need - q.step });
      return { ok: true, done: done,
        line: TF('qact.gather.ok', 'わあい、{items} が採れた！ {tail}', { items: got.join('、'), tail: tail }) };
    },
    act_craft: function (q) {
      var made = null, fail = null;
      for (var i = 0; i < RECIPES.length; i++) {
        var r = RECIPES[i];
        var haveAll = r.in.every(function (pair) {
          return Game.countItem('you', pair[0]) >= pair[1];
        });
        if (haveAll) { made = r; break; }
        if (!fail) fail = r;
      }
      if (!made) {
        var need = fail ? fail.in.map(function (p) { return itemName(p[0]) + '×' + p[1]; }).join('、') : itemName('emeralia');
        return { ok: false, refund: true, line: TF('qact.craft.lack', 'うーん、{need} が足りないみたい。集めてこよっ。', { need: need }) };
      }
      made.in.forEach(function (pair) { Game.removeItem('you', pair[0], pair[1]); });
      Game.addItem('you', made.out, 1);
      q.step = Math.min(q.need, (q.step | 0) + 1);
      Game.addExp(14);
      return { ok: true, done: q.step >= q.need,
        line: TF('qact.craft.ok', 'せーの… できた！ {item}！ あたしの調合、上達してない？', { item: itemName(made.out) }) };
    },
    act_battle: function (q) {
      /* ctx_area returns the AREA ID ('area_01'); MONSTERS.area and the reward
         maths below are numeric. Comparing them as strings never matched
         (every mob came from the fallback pool), and 'area_01' * 10 = NaN
         reached addMoney — whose (x+NaN)||0 guard then WIPED the player's
         gold on every battle win. Convert once, use the number everywhere. */
      var area = Number(/area_(\d+)/.exec(ctx_area(q))[1]) || 1;
      var mobs = MONSTERS.filter(function (m) { return m.area === area; });
      var mi = Math.floor(Math.random() * (mobs.length || MONSTERS.length));
      var mob = (mobs.length ? mobs : MONSTERS)[mi];
      var mobName = TF('mob.' + mob.i, mob.name, {});
      var odds = 0.30 + 0.06 * Game.level();
      var tools = [];
      ['bomb', 'charm', 'bottle'].forEach(function (t) {
        var n = Game.countItem('you', t);
        if (t === 'bomb' && n > 0) { odds += 0.18; tools.push(itemName('bomb')); Game.removeItem('you', t, 1); }
        else if (t === 'charm' && n > 0) { odds += 0.12; }
        else if (t === 'bottle' && n > 0 && Game.s.stamina < Game.max() / 2) {
          Game.removeItem('you', t, 1); Game.restore(Game.ITEMS.bottle.stamina); tools.push(itemName('bottle'));
        }
      });
      var win = Math.random() < Util.clamp(odds, 0.1, 0.92);
      if (win) {
        var money = 20 + Math.floor(Math.random() * 40) + area * 10;
        Game.addMoney(money);
        Game.addExp(18 + area * 8);
        q.step = Math.min(q.need, (q.step | 0) + 1);
        return { ok: true, done: q.step >= q.need,
          line: TF('qact.battle.win', 'やった、{mob} 倒した！ {money}G 落としてったよ。{tools}',
            { mob: mobName, money: money, tools: tools.length ? '（' + tools.join('・') + '）' : '' }) };
      }
      Game.addExp(5);
      return { ok: false, spent: true, done: false,
        line: TF('qact.battle.lose', 'うぅ…{mob}、強すぎだよ。また挑戦しよ。', { mob: mobName }) };
    },
    act_shop: function (q) {
      var list = Game.s.inventory.slice().sort(function (a, b) {
        return itemValue(a.id) - itemValue(b.id);
      });
      var sold = [], take = 0;
      for (var i = 0; i < list.length && sold.length < 3; i++) {
        var it = list[i];
        if ((Game.ITEMS[it.id] || {}).kind !== 'mat') continue;
        var n = Math.min(it.count, 2);
        if (!Game.removeItem('you', it.id, n)) continue;
        take += n * Math.round(itemValue(it.id) * (1 + Math.random() * 0.6));
        sold.push(itemName(it.id) + '×' + n);
      }
      if (!sold.length) return { ok: false, refund: true, line: L('qact.shop.empty', '売れる在庫がないや…素材を集めてこよ？') };
      Game.addMoney(take);
      Game.addExp(16);
      q.step = Math.min(q.need, (q.step | 0) + 1);
      return { ok: true, done: q.step >= q.need,
        line: TF('qact.shop.ok', '開店！ {items} が売れて +{money}G。あたしたち、才能あるかも！',
          { items: sold.join('、'), money: take }) };
    },
    act_build: function (q) {
      var partsDone = Game.flag('ship_parts', 0);
      if (partsDone >= 4) return { ok: false, line: L('qact.build.done', '部品はもうそろってる！ 次は「船で自由に旅へ出よう」だね。') };
      var want = PART_ITEMS[partsDone];
      var have = Game.countItem('you', want) + Game.countItem('ryza', want);
      if (have <= 0) {
        return { ok: false, refund: true,
          line: TF('qact.build.lack', '造船には {part}（{item}）が必要みたい。探してこよ！',
            { part: L('part.' + want, PART_NAMES[want]), item: itemName(want) }) };
      }
      if (!Game.removeItem('you', want, 1)) Game.removeItem('ryza', want, 1);
      Game.setFlag('ship_parts', partsDone + 1);
      Game.addExp(12);
      q.step = Math.min(q.need, partsDone + 1);
      return { ok: true, done: q.step >= q.need,
        line: TF('qact.build.ok', '「{part}」装着！ 船が形になってきた。あと {n} つ！',
          { part: L('part.' + want, PART_NAMES[want]), n: 4 - q.step }) };
    },
    act_sail: function (q) {
      if (Game.flag('ship_parts', 0) < 4) {
        return { ok: false, refund: true, line: L('qact.sail.parts', 'まだ部品が足りない！ 造船クエストに戻ろう。') };
      }
      if (!Game.canPay(200)) {
        return { ok: false, refund: true, line: L('qact.sail.money', '出航に 200G 必要らしい。お店を開いて稼ごう！') };
      }
      Game.addMoney(-200);
      q.step = q.need;
      var cleared = Quests.clear();   /* complete() flips sailed */
      return { ok: true, done: true, sail: true, quest: cleared,
        line: L('qact.sail.ok', '出発の時間だ——！ クーケン島を離れて、自由な旅へ。世界の扉、開いたよ！') };
    },

    /* ------------------------------------------------------------- refund
       Actions with `refund: true` consumed nothing but were blocked;
       hand the quest cost back so failed attempts are free. */
    refundAction: function (res) {
      if (res && !res.ok && !res.spent && !res.faint) {
        var q = nowQuest();
        if (q) Game.restore(q.cost);
      }
    },

    /* ------------------------------------------------------------- sheet UI */
    setCelebrate: function (fn) { _celebrate = (typeof fn === 'function') ? fn : null; },
    setPresenter: function (fn) { _present = (typeof fn === 'function') ? fn : null; },
    setGenerator: function (fn) { _generate = (typeof fn === 'function') ? fn : null; },
    setNotice: function (fn) { _notice = (typeof fn === 'function') ? fn : null; },

    render: function (root, hooks) {
      if (!root) return;
      root.innerHTML = '';
      var q = Quests.ensure();
      var card = document.createElement('div');
      card.className = 'qcard';
      var icon = 'assets/icons/' + (TYPE_ICON[q.type] || 'quest') + '.svg';
      card.innerHTML =
        '<div class="qcard-top"><img class="qico" alt="">' +
        '<div class="qhead"><div class="qtitle"></div><div class="qno"></div></div></div>' +
        '<div class="qdesc"></div>' +
        '<div class="qgoal"><span class="qgoal-t"></span><span class="qgoal-v"></span></div>' +
        '<div class="qobs"></div>' +
        '<div class="qbar"><i></i></div>' +
        '<div class="qacts"></div>';
      card.querySelector('.qico').src = icon;
      card.querySelector('.qtitle').textContent = Quests.titleOf(q);
      card.querySelector('.qno').textContent = q.no <= 8
        ? (I18n.t('quest.no') + ' ' + q.no + ' / 8' + (q.side ? '' : ''))
        : I18n.t('quest.side');
      card.querySelector('.qdesc').textContent = Quests.descOf(q);
      card.querySelector('.qgoal-t').textContent = I18n.t('quest.goal') + '：';
      card.querySelector('.qgoal-v').textContent = Quests.goalOf(q) + '（' + (q.step | 0) + '/' + q.need + '）';
      card.querySelector('.qobs').textContent = L('qobs.' + q.type, q.obstacle || '');
      card.querySelector('.qbar i').style.width =
        Math.round(((q.step | 0) / Math.max(1, q.need)) * 100) + '%';

      var acts = card.querySelector('.qacts');
      var actLabel = I18n.t('quest.act.' + q.type);
      if (actLabel.indexOf('quest.act.') === 0) actLabel = '';
      if (!q.complete && actLabel) {
        var act = document.createElement('button');
        act.className = 'mini-btn primary';
        act.textContent = actLabel + '（' + I18n.t('quest.cost') + ' ' + q.cost + '）';
        act.onclick = function () {
          var res = Quests.doAction(q.type, hooks || {});
          Quests.refundAction(res);
          /* Presenting the outcome (sailing, faint, bubble, se, HUD) is the
             host's job — it owns the render layer. See the ports above. */
          if (res && _present) { try { _present(res); } catch (e) { /* never break gameplay */ } }
          Quests.render(root, hooks);
          if (Quests.pendingAdvance() && hooks && hooks.cleared) hooks.cleared(nowQuest());
        };
        acts.appendChild(act);
      }
      if (Quests.isSide(q) || q.no >= 8) {
        var gen = document.createElement('button');
        gen.className = 'mini-btn';
        gen.textContent = I18n.t('quest.auto');
        gen.onclick = function () {
          var hasKey = !!(window.Config && Config.llmReady());
          if (hasKey) notify(I18n.t('toast.questGen'));
          Quests.generate(hasKey).then(function () {
            notify(I18n.t('quest.newOk') + '「' + Quests.titleOf(Quests.active()) + '」');
            Quests.render(root, hooks);
          });
        };
        acts.appendChild(gen);
      }
      root.appendChild(card);

      /* Ship progress strip while in the build/sail stage. */
      if (q.no >= 7 && !Game.s.sailed) {
        var ship = document.createElement('div');
        ship.className = 'qship';
        var parts = Game.flag('ship_parts', 0);
        ship.innerHTML = '<span>' + I18n.t('quest.ship') + '</span>' +
          PART_ITEMS.map(function (_, i) {
            return '<img alt="" src="assets/icons/' + (i < parts ? 'check' : 'lock') + '.svg">';
          }).join('');
        root.appendChild(ship);
      }

      /* History list. */
      var log = (Game.s.flags.quest_log || []).slice(-6).reverse();
      if (log.length) {
        var h = document.createElement('div');
        h.className = 'qhist-title';
        h.textContent = I18n.t('quest.history');
        root.appendChild(h);
        log.forEach(function (x) {
          var row = document.createElement('div');
          row.className = 'qhist';
          row.innerHTML = '<img alt="" src="assets/icons/quest_clear_icon.svg"><span></span>';
          row.querySelector('span').textContent =
            x.no <= 8 ? L('q.' + x.no + '.title', x.title) : x.title;
          root.appendChild(row);
        });
      }
    },

    showClear: function (q) {
      var ov = document.getElementById('overlay-quest-clear');
      if (!ov) return;
      ov.classList.remove('hidden');
      var t = ov.querySelector('.qc-title');
      if (t) t.textContent = (q && q.title) || '';
      var p = ov.querySelector('.qc-praise');
      if (p) {
        var pi = Math.floor(Math.random() * PRAISES.length);
        p.textContent = L('pr.' + pi, PRAISES[pi]);
      }
    },

    /* ---------------------------------------------------------- prompt block */
    promptBlock: function () {
      var q = Quests.ensure();
      var L = [];
      L.push('## クエスト（進行度あたしと共有。達成したら <state> で教えて）');
      L.push('- No.' + q.no + '「' + Quests.titleOf(q) + '」kind=' + q.type);
      L.push('  目標：' + Quests.goalOf(q) + '（進行 ' + (q.step | 0) + '/' + q.need + '）');
      L.push('  詳細：' + Quests.descOf(q) + (q.obstacle ? ' / 障害：' + q.obstacle : ''));
      if (!Game.s.sailed) {
        L.push('- まだクーケン島にいる。船（No.8）ができるまで世界地図の他エリアはロック。');
        L.push('- 造船部品：' + Game.flag('ship_parts', 0) + '/4。');
      } else {
        L.push('- 船を手に入れて世界へ出航済み。どのエリアにも行ける。');
      }
      return L.join('\n');
    }
  };

  function ctx_area() {
    var st = (window.Config && Config.section('state')) || {};
    var m = /^stage_(\d\d)_/.exec(st.stage || 'stage_01_001_04');
    return m ? ('area_' + m[1]) : 'area_01';
  }
  function itemValue(id) { return Game.itemValue(id); }

  /* ------------------------------------------------- welcome mission board
     Official shape, not the old five-tile guess.

     Source: docs/official/masters_bundle.json (the payload the official app
     caches at /data/data/.../files/masters_bundle.json). It defines:

       mission_groups  3 groups, welcome_start_day 0 / 3 / 5, reward 4 points
                       -> 100 voice_token
       missions        4 per group, driven by two activities:
                         app_launched  x3      (finish 3 missions)
                         app_launched  x1      (touch Ryza)
                         app_launched  x5      (talk with a character 5 times)
                         login_streak  x1/x3/x5 (claim the login bonus)
       activities      10 kinds in total; only the two above appear in these
                       twelve missions

     Progress is therefore a COUNTER per activity, not "did this screen ever
     open". The old panel marked itself from opening the map / alarm / skin
     screens; the official board never asked for that, so those markers stay as
     local milestones under their own keys and nothing already working is lost.

     Rewards: the official group reward is 4 mission points -> 100 voice tokens.
     This build has no token wallet (no official server, no purchases), so the
     group claim pays the local equivalents below and records which groups were
     claimed. That mapping is a LOCAL decision, listed in docs/official/README.md. */

  /* Official titles, verbatim: ja is the shipped wording, zh/en are our
     translations of those same strings. */
  var WM_MISSION_TEXT = {
    mission_clear: { ja: 'ミッションを3つクリアしよう', zh: '完成 3 次任务', en: 'Achieve mission 3 times' },
    touch: { ja: 'ライザを触ってみる', zh: '摸一下莱莎', en: 'Touch Ryza' },
    talk: { ja: 'キャラと5回会話してみよう', zh: '与角色对话 5 次', en: 'Talk with a character 5 times' },
    login_bonus: { ja: 'ログインボーナスを受け取ろう', zh: '领取登录奖励', en: 'Get a logged in bonus' }
  };

  /* missions[] from masters_bundle, in official priority order (1..12). */
  var WM_GROUPS = [
    { id: 'crf_msng_001', title: 'Step 1', day: 0,
      missions: [
        { id: 'crf_msn_001_0001', activity: 'mission_clear', need: 3 },
        { id: 'crf_msn_001_0002', activity: 'touch', need: 1 },
        { id: 'crf_msn_001_0003', activity: 'talk', need: 5 },
        { id: 'crf_msn_001_0004', activity: 'login_bonus', need: 1 }
      ] },
    { id: 'crf_msng_002', title: 'Step 2', day: 3,
      missions: [
        { id: 'crf_msn_002_0001', activity: 'mission_clear', need: 3 },
        { id: 'crf_msn_002_0002', activity: 'touch', need: 1 },
        { id: 'crf_msn_002_0003', activity: 'talk', need: 5 },
        { id: 'crf_msn_002_0004', activity: 'login_bonus', need: 3 }
      ] },
    { id: 'crf_msng_003', title: 'Step 3', day: 5,
      missions: [
        { id: 'crf_msn_003_0001', activity: 'mission_clear', need: 3 },
        { id: 'crf_msn_003_0002', activity: 'touch', need: 1 },
        { id: 'crf_msn_003_0003', activity: 'talk', need: 5 },
        { id: 'crf_msn_003_0004', activity: 'login_bonus', need: 5 }
      ] }
  ];

  /* Local equivalent of the official 4 points -> 100 voice_token. */
  var WM_GROUP_REWARD = { money: 300, exp: 40 };
  var WM_ICON = {
    mission_clear: 'icon_scroll', touch: 'sparkle',
    talk: 'icon_scroll', login_bonus: 'icon_chest'
  };

  var Welcome = {
    /* Board + groups exposed for tooling/regression (read-only). */
    groups: WM_GROUPS,
    /* Is this group open yet? Official gate is welcome_start_day. */
    isOpen: function (g) { return Welcome.dayCount() >= g.day; },

    /* Official activity counters live in Game.s so they ride the save file. */
    activity: function (kind) {
      var s = Game.s;
      if (!s.welcome_activity) s.welcome_activity = {};
      return Number(s.welcome_activity[kind] || 0);
    },

    /* Record one activity. count > 1 for "advance several steps at once". */
    mark: function (kind, count) {
      var n = Math.max(1, Number(count) || 1);
      var s = Game.s;
      if (!s.welcome_activity) s.welcome_activity = {};
      s.welcome_activity[kind] = Number(s.welcome_activity[kind] || 0) + n;
      Game.save();
      Game.emit('welcome');
      return s.welcome_activity[kind];
    },

    /* Local milestones (where the old map / alarm / skin tiles went). The
       official board has no such missions, but the player still gets feedback. */
    milestone: function (id) {
      var w = Config.section('state').welcome || {};
      if (w[id]) return;
      Config.set('state.welcome.' + id, true);
    },
    milestoneDone: function (id) {
      return !!(Config.section('state').welcome && Config.section('state').welcome[id]);
    },

    /* Days since first launch: decides which groups are open (official
       welcome_start_day 0 / 3 / 5). */
    dayCount: function () {
      try { return Number(Config.section('state').welcome_day || 0); } catch (e) { return 0; }
    },
    bumpDay: function (n) {
      var cur = Welcome.dayCount();
      var next = Math.max(cur, Number(n) || 0);
      if (next !== cur) Config.set('state.welcome_day', next);
      return next;
    },

    missionDone: function (m) { return Welcome.activity(m.activity) >= m.need; },
    groupDone: function (g) {
      return g.missions.every(function (m) { return Welcome.missionDone(m); });
    },
    groupClaimed: function (g) {
      var c = Config.section('state').welcome_claimed || {};
      return !!c[g.id];
    },
    claimGroup: function (g) {
      if (!Welcome.groupDone(g) || Welcome.groupClaimed(g)) return null;
      var c = Config.section('state').welcome_claimed || {};
      c[g.id] = true;
      Config.set('state.welcome_claimed', c);
      Game.addMoney(WM_GROUP_REWARD.money);
      Game.addExp(WM_GROUP_REWARD.exp);
      Game.remember('ウェルカムミッション ' + g.title + ' クリア');
      return WM_GROUP_REWARD;
    },

    render: function (root) {
      root.innerHTML = '';
      var hero = document.createElement('div');
      hero.className = 'wm-hero';
      hero.innerHTML = '<h3></h3><p></p>';
      hero.querySelector('h3').textContent = I18n.t('wm.title');
      hero.querySelector('p').textContent = I18n.t('wm.sub');
      root.appendChild(hero);

      var day = Welcome.dayCount();
      var lang = 'zh';
      try { lang = I18n.lang() || 'zh'; } catch (e) {}
      var list = document.createElement('div');
      list.className = 'wm-groups';

      WM_GROUPS.forEach(function (g) {
        var open = day >= g.day;
        var done = Welcome.groupDone(g);
        var box = document.createElement('div');
        box.className = 'wm-group' + (open ? '' : ' locked') + (done ? ' clear' : '');

        var head = document.createElement('div');
        head.className = 'wm-group-head';
        head.innerHTML = '<span class="wm-group-title"></span><span class="wm-group-day"></span>';
        head.querySelector('.wm-group-title').textContent = g.title;
        head.querySelector('.wm-group-day').textContent = open
          ? (done ? (global.I18n && I18n.t ? I18n.t('quest.done') : '完成') : (global.I18n && I18n.t ? I18n.t('quest.ongoing') : '进行中'))
          : (global.I18n && I18n.tf ? I18n.tf('quest.openDay', '第 {day} 天开放', { day: g.day }) : ('第 ' + g.day + ' 天开放'));
        box.appendChild(head);

        var grid = document.createElement('div');
        grid.className = 'wm-grid';
        g.missions.forEach(function (m) {
          var got = Welcome.activity(m.activity);
          var md = Welcome.missionDone(m);
          var tile = document.createElement('div');
          tile.className = 'wm-tile' + (md ? ' clear' : (open ? ' active' : ' locked'));
          tile.innerHTML = '<img class="wm-base" alt=""><img class="wm-ico" alt="">' +
                           '<div class="wm-cap"></div><div class="wm-prog"></div>';
          tile.querySelector('.wm-base').src = 'assets/welcome_mission/' +
            (md ? 'tile_base_clear.svg' : (open ? 'tile_base_active.svg' : 'tile_base_locked.svg'));
          tile.querySelector('.wm-ico').src = 'assets/welcome_mission/' + WM_ICON[m.activity] + '.svg';
          var txt = WM_MISSION_TEXT[m.activity] || { ja: m.id, zh: m.id };
          tile.querySelector('.wm-cap').textContent = txt[lang] || txt.zh || txt.ja;
          /* the official unlock_condition_value is exactly this need */
          tile.querySelector('.wm-prog').textContent = Math.min(got, m.need) + ' / ' + m.need;
          tile.title = txt.ja;
          grid.appendChild(tile);
        });
        box.appendChild(grid);

        if (open && done && !Welcome.groupClaimed(g)) {
          var btn = document.createElement('button');
          btn.className = 'wm-claim';
          btn.textContent = (global.I18n && I18n.t ? I18n.t('quest.claim') : '受け取る');
          btn.onclick = function () {
            var r = Welcome.claimGroup(g);
            if (r) { Welcome.render(root); if (_present) { try { _present(r); } catch (e) {} } }
          };
          box.appendChild(btn);
        } else if (Welcome.groupClaimed(g)) {
          var tag = document.createElement('div');
          tag.className = 'wm-claimed';
          tag.textContent = (global.I18n && I18n.t ? I18n.t('quest.claimed') : '受け取り済み');
          box.appendChild(tag);
        }
        list.appendChild(box);
      });

      root.appendChild(list);
    }
  };

  global.Quests = Quests;
  global.Welcome = Welcome;
})(window);
