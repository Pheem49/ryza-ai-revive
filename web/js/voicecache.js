/* voicecache.js — 语音片段缓存（重播 / 收藏用）。

   只做一件事：保留最近 N 段语音，按**字节预算**逐出（最旧的先删），
   被收藏的片段豁免逐出。文本、配置、对话本身都不归它管。

   为什么用 IndexedDB 而不是 localStorage
   --------------------------------------
   桌面壳会把 localStorage 镜像进 `%AppData%/RyzaChat/ryza-web-storage.json`
   并在每次启动重新注入；几百 KB 的音频会把那个文件撑大、拖慢每次启动。
   IndexedDB 存在 Chromium profile 里，重启后 blob 逐字节一致（参考项目实测过）。

   依赖注入：没有 IndexedDB 时（headless 回归 / 老 WebView）全部接口退化为
   空操作并返回 false/null，**不抛错**。
*/
(function (global) {
  'use strict';

  var DB = 'ryza_voice';
  var STORE = 'clips';
  var DEFAULT_BUDGET = 8 * 1024 * 1024;   /* 字节预算，约 8MB */
  var DEFAULT_KEEP = 40;                  /* 条数上限 */
  var META_KEY = 'ryza.voicefav.v1';      /* 收藏表很小，放 localStorage */

  var _db = null;

  function hasIdb() { return typeof indexedDB !== 'undefined'; }

  function open() {
    if (_db) return Promise.resolve(_db);
    if (!hasIdb()) return Promise.reject(new Error('no indexedDB'));
    return new Promise(function (res, rej) {
      var req;
      try { req = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'key' });
          os.createIndex('at', 'at', { unique: false });
        }
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function tx(mode) {
    return open().then(function (db) { return db.transaction(STORE, mode).objectStore(STORE); });
  }

  function favs() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { return {}; }
  }
  function setFavs(o) {
    try { localStorage.setItem(META_KEY, JSON.stringify(o)); } catch (e) {}
  }

  function isFav(key) { return !!favs()[key]; }

  /* 预算/条数逐出：收藏的跳过；从最旧的开始删。 */
  function evict(budget, keep) {
    return tx('readwrite').then(function (store) {
      return new Promise(function (res) {
        var all = [];
        var cur = store.openCursor();
        cur.onsuccess = function () {
          var c = cur.result;
          if (c) { all.push(c.value); c.continue(); return; }
          all.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });  /* 旧 → 新 */
          var total = all.reduce(function (s, x) { return s + (x.bytes || 0); }, 0);
          var victims = [];
          /* 先按字节预算，再按条数；两轮都跳过收藏项 */
          for (var i = 0; i < all.length && (total > budget || all.length - victims.length > keep); i++) {
            var x = all[i];
            if (isFav(x.key)) continue;
            if (total <= budget && (all.length - victims.length) <= keep) break;
            total -= (x.bytes || 0);
            victims.push(x.key);
          }
          var n = 0;
          victims.forEach(function (k) {
            var d = store.delete(k);
            d.onsuccess = function () { n++; };
          });
          setTimeout(function () { res({ evicted: victims.length }); }, 0);
        };
        cur.onerror = function () { res({ evicted: 0 }); };
      });
    }).catch(function () { return { evicted: 0 }; });
  }

  var VoiceCache = {
    DEFAULT_BUDGET: DEFAULT_BUDGET,
    DEFAULT_KEEP: DEFAULT_KEEP,

    /* 逐出豁免直接问本模块自己的收藏表（favorites 在 localStorage，
       `isFav`）——曾经还留了一个 setProtector 注入口，但没有人调用它，
       等于同一件事有两个主人，已删。 */

    /* 存一段语音。blob 可以是 Blob / ArrayBuffer / Uint8Array。
       key 建议用「回数 + 文本哈希」这类稳定值；重复 key 覆盖。 */
    put: function (key, blob, meta) {
      if (!key || !blob || !hasIdb()) return Promise.resolve(false);
      var bytes = blob.size != null ? blob.size : (blob.byteLength || 0);
      var rec = {
        key: String(key),
        at: Date.now(),
        bytes: bytes,
        text: String((meta && meta.text) || '').slice(0, 400),
        url: String((meta && meta.url) || ''),
        blob: blob
      };
      return tx('readwrite').then(function (store) {
        return new Promise(function (res, rej) {
          var p = store.put(rec);
          p.onsuccess = function () { res(rec); };
          p.onerror = function () { rej(p.error); };
        });
      }).then(function () {
        return evict(DEFAULT_BUDGET, DEFAULT_KEEP).then(function () { return true; });
      }).catch(function () { return false; });
    },

    get: function (key) {
      return tx('readonly').then(function (store) {
        return new Promise(function (res) {
          var g = store.get(String(key));
          g.onsuccess = function () { res(g.result || null); };
          g.onerror = function () { res(null); };
        });
      }).catch(function () { return null; });
    },

    /* 列出片段（不带 blob，列表轻）；按时间倒序（新的在前）。 */
    list: function () {
      return tx('readonly').then(function (store) {
        return new Promise(function (res) {
          var out = [];
          var cur = store.openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c) {
              out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
              return res(out);
            }
            var v = c.value;
            out.push({ key: v.key, at: v.at, bytes: v.bytes, text: v.text, fav: isFav(v.key) });
            c.continue();
          };
          cur.onerror = function () { res([]); };
        });
      }).catch(function () { return []; });
    },

    /* 取 blob URL（重播用）。调用方负责在播完后 revoke。 */
    urlFor: function (key) {
      return VoiceCache.get(key).then(function (rec) {
        if (!rec || !rec.blob) return null;
        try { return URL.createObjectURL(rec.blob); } catch (e) { return null; }
      });
    },

    toggleFav: function (key) {
      var f = favs();
      if (f[key]) delete f[key]; else f[key] = 1;
      setFavs(f);
      return !!f[key];
    },

    /* 清空（收藏的默认保留；force=true 才全清） */
    clear: function (force) {
      return tx('readwrite').then(function (store) {
        return new Promise(function (res) {
          var cur = store.openCursor();
          var n = 0;
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c) return res({ cleared: n });
            var v = c.value;
            if (force || !isFav(v.key)) { store.delete(v.key); n++; }
            c.continue();
          };
          cur.onerror = function () { res({ cleared: n }); };
        });
      }).catch(function () { return { cleared: 0 }; });
    },

    stats: function () {
      return VoiceCache.list().then(function (l) {
        return {
          count: l.length,
          bytes: l.reduce(function (s, x) { return s + (x.bytes || 0); }, 0),
          favs: l.filter(function (x) { return x.fav; }).length,
          budget: DEFAULT_BUDGET
        };
      });
    }
  };

  global.VoiceCache = VoiceCache;
})(typeof window !== 'undefined' ? window : globalThis);
