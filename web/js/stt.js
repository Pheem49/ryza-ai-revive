/* Speech input that does not depend on the browser's cloud recogniser.

   Why this exists
   ---------------
   The only speech input was `webkitSpeechRecognition` (voice.js). Measured, not
   assumed (temp/electron-probe, 2026-09-18): in the packaged Electron shell the
   constructor exists, `start()` even fires `onstart`, and then Chromium's
   speech service answers `error: network` — Electron ships no speech backend.
   Granting `media` through setPermissionRequestHandler changes nothing, so it is
   not a permission problem. On Android the WebView had no RECORD_AUDIO and no
   onPermissionRequest at all, so it could never work either. Net effect: the
   feature worked in a desktop browser and nowhere the app is actually shipped.

   What the same probe DID find available in both shells: getUserMedia (with
   echoCancellation / noiseSuppression / autoGainControl actually applied —
   verified from track.getSettings()), AudioContext and AudioWorklet. So the raw
   audio is reachable; only the *recogniser* is missing. This module owns the
   raw path and hands utterances to a transcriber, which is transport and
   therefore injected (api.js -> /audio/transcriptions -> /_proxy), the same way
   airi keeps STT as a provider descriptor instead of a browser API.

   Deliberately NOT doing, and why (rather than half-doing it):
     * no VAD model here. N.E.K.O.'s Silero v6.2.1 ONNX gate needs a spike on
       all three hosts first (docs, §8). Until then the gate below is N.E.K.O.'s
       *stage one* — the energy/adaptive-baseline throttle — which is what their
       own pipeline uses before the model, with their measured constants.
     * no MediaRecorder. webm/opus chunks cannot be trimmed: the first chunk
       carries the container header, so an utterance that starts later cannot be
       assembled from a slice. Raw PCM through an AudioWorklet gives exact
       pre-roll/trailing trimming, needs no encoder to be present, and already
       produces the 16 kHz frames a Silero gate will want. The WAV container
       written here is what every OpenAI-compatible /audio/transcriptions
       endpoint accepts.

   Layer: voice. Ports are injected (transcriber / notice / sink / lang), so the
   gate can be driven deterministically in scripts/stt_regression.js with no
   audio hardware at all.
*/
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- constants
     N.E.K.O.'s measured values. The first group is its energy throttle
     (endpointing/throttle_policy.py: bootstrap_onset 0.35, min_onset 0.20,
     max_onset 0.65, baseline_alpha 0.05); the second is its utterance lifecycle
     (min speech 200 ms, candidate silence 300 ms, pre-roll 700 ms, trailing
     400 ms). They are kept here as named constants so a future calibrated value
     replaces one number instead of being buried in a branch. */
  var BOOTSTRAP_ONSET = 0.35;   /* threshold before the baseline has settled */
  var MIN_ONSET = 0.20;         /* adaptive floor */
  var MAX_ONSET = 0.65;         /* adaptive ceiling */
  var BASELINE_ALPHA = 0.05;    /* EMA weight for the ambient-noise baseline */
  var MIN_SPEECH_MS = 200;      /* shorter than this is not an utterance */
  var CANDIDATE_SILENCE_MS = 300;
  var PRE_ROLL_MS = 700;        /* kept before the onset so the first syllable is in */
  var TRAILING_MS = 400;        /* kept after the last voiced frame */
  var TARGET_RATE = 16000;      /* Hz — what Silero and the ASR endpoints want */
  var FRAME_MS = 50;            /* how often the level is sampled */

  /* ---------------------------------------------------------------- state */
  var _transcribe = null;   /* fn(blob, opts) -> Promise<text> */
  var _notice = null;
  var _sink = null;         /* fn(text) — same contract as voice.js */
  var _lang = null;
  var _ononset = null;      /* fn() — the player started speaking (barge-in) */
  var _now = function () { return Date.now(); };

  var _want = false;        /* the player asked for the mic */
  var _stream = null, _ctx = null, _node = null, _src = null;
  var _rate = TARGET_RATE;
  var _pcm = [];            /* rolling Int16 frames, trimmed to the ring window */
  var _pcmSamples = 0;      /* samples currently in _pcm (sum of frame lengths) */
  var _speaking = false;
  var _voicedSince = 0;
  var _silentSince = 0;
  var _sentAt = 0;          /* when the last utterance was handed to the transcriber */
  var _busy = false;
  var _level = 0;           /* last level in 0..1 after normalisation */
  var _baseline = 0;

  function emit(text) { if (_sink) { try { _sink(text); } catch (e) {} } }
  function notice(code, isErr) { if (_notice) { try { _notice(code, !!isErr); } catch (e) {} } }
  function lang() {
    try { return (_lang && _lang()) || 'ja'; } catch (e) { return 'ja'; }
  }

  /* ------------------------------------------------------------ pure helpers */
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* RMS of a frame, normalised so that a full-scale sine is 1. Frames arrive as
     Float32 in [-1,1] from the worklet, or as Int16 from the fallback path. */
  function frameLevel(frame, isInt16) {
    if (!frame || !frame.length) return 0;
    var sum = 0, i, v;
    for (i = 0; i < frame.length; i++) {
      v = isInt16 ? (frame[i] / 32768) : frame[i];
      sum += v * v;
    }
    /* sqrt(2) puts a full-scale sine at 1.0, which is what the thresholds in
       N.E.K.O. are scaled against. */
    return clamp01(Math.sqrt(sum / frame.length) * Math.SQRT2);
  }

  function int16(frame) {
    var out = new Int16Array(frame.length), i, v;
    for (i = 0; i < frame.length; i++) {
      v = frame[i];
      v = v < -1 ? -1 : (v > 1 ? 1 : v);
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  /* 16-bit mono PCM -> WAV. Written by hand because there is no encoder to rely
     on in a WebView, and because every ASR endpoint accepts WAV. */
  function wavBlob(frames, rate) {
    var total = 0, i;
    for (i = 0; i < frames.length; i++) total += frames[i].length;
    var buf = new ArrayBuffer(44 + total * 2);
    var view = new DataView(buf);
    function str(off, s) { for (var j = 0; j < s.length; j++) view.setUint8(off + j, s.charCodeAt(j)); }
    str(0, 'RIFF');
    view.setUint32(4, 36 + total * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);        /* PCM chunk size */
    view.setUint16(20, 1, true);         /* format: PCM */
    view.setUint16(22, 1, true);         /* channels: mono */
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);  /* byte rate */
    view.setUint16(32, 2, true);         /* block align */
    view.setUint16(34, 16, true);        /* bits per sample */
    str(36, 'data');
    view.setUint32(40, total * 2, true);
    var off = 44;
    for (i = 0; i < frames.length; i++) {
      var f = frames[i];
      for (var k = 0; k < f.length; k++, off += 2) view.setInt16(off, f[k], true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ------------------------------------------------------------ gate (pure)
     Fed one level at a time. Keeping the decision separate from the audio
     plumbing is what lets the regression drive a whole conversation with no
     microphone: the same shape voice.js uses for its `_accept`. */
  function feedLevel(level, now) {
    level = clamp01(Number(level) || 0);
    _level = level;
    /* The baseline follows the quiet parts only — otherwise a long utterance
       would raise its own threshold and cut itself off. */
    if (!_speaking || level < _baseline) {
      _baseline = _baseline * (1 - BASELINE_ALPHA) + level * BASELINE_ALPHA;
    }
    var threshold = _baseline > 0
      ? Util.clamp(_baseline * 2.2, MIN_ONSET, MAX_ONSET)
      : BOOTSTRAP_ONSET;
    var voiced = level >= threshold;

    if (voiced) {
      if (!_speaking) {
        /* Not an utterance yet: a door, a cough and a chair all clear the
           threshold. It becomes one only after the minimum duration. */
        if (!_voicedSince) _voicedSince = now;
        if (now - _voicedSince >= MIN_SPEECH_MS) {
          _speaking = true;
          _silentSince = 0;
          /* Onset fires where the *player* started, i.e. after confirmation —
             that is N.E.K.O.'s confirm_speech_ms idea, and it is what makes
             barge-in usable instead of hair-trigger. */
          if (_ononset) { try { _ononset(); } catch (e) {} }
        }
      } else {
        _silentSince = 0;
      }
      return null;
    }

    /* Not voiced. */
    if (!_speaking) { _voicedSince = 0; return null; }
    if (!_silentSince) { _silentSince = now; return null; }
    if (now - _silentSince < CANDIDATE_SILENCE_MS) return null;
    return closeUtterance(now);
  }

  /* The utterance is over: cut it out of the ring buffer, keeping the pre-roll
     (so the first syllable is not clipped) and dropping anything from a previous
     utterance. Returns the blob handed to the transcriber, or null. */
  function closeUtterance(now) {
    var keepFrom = Math.max(0, Math.round(PRE_ROLL_MS / FRAME_MS));
    var take = _pcm.slice(Math.max(0, _pcm.length - keepFrom - Math.round(TRAILING_MS / FRAME_MS)));
    _speaking = false;
    _voicedSince = 0;
    _silentSince = 0;
    if (!take.length) return null;
    var blob = wavBlob(take, _rate);
    _sentAt = now;
    if (!_transcribe) { notice('mic.noTranscriber', true); return null; }
    if (_busy) return null;             /* one utterance at a time */
    _busy = true;
    var opts = { lang: lang() };
    Promise.resolve()
      .then(function () { return _transcribe(blob, opts); })
      .then(function (text) {
        _busy = false;
        var t = String(text == null ? '' : text).trim();
        if (!t) { notice('mic.empty', false); return; }
        emit(t);
      })
      .catch(function (e) {
        _busy = false;
        notice('mic.error:' + ((e && e.message) || e), true);
      });
    return blob;
  }

  function pushFrame(frame, isInt16) {
    _pcm.push(isInt16 ? frame : int16(frame));
    _pcmSamples += _pcm.length ? _pcm[_pcm.length - 1].length : 0;
    /* Keep a bounded ring: enough for pre-roll + trailing, not the whole session. */
    var limit = Math.round((PRE_ROLL_MS + TRAILING_MS + CANDIDATE_SILENCE_MS * 2) / FRAME_MS) + 4;
    while (_pcm.length > limit) {
      _pcmSamples -= _pcm.shift().length;
    }
  }

  /* ------------------------------------------------------------------ capture
     AudioWorklet when the host has it (it does in all three, verified), with
     ScriptProcessorNode as the fallback for an old WebView. The worklet source
     is inlined as a Blob URL so this needs no extra file and no bundler. */
  var WORKLET_SRC = [
    'class RyzaTap extends AudioWorkletProcessor {',
    '  process(inputs) {',
    '    const ch = inputs[0] && inputs[0][0];',
    '    if (ch) this.port.postMessage(ch.slice(0));',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("ryza-tap", RyzaTap);'
  ].join('\n');

  function startCapture() {
    var md = global.navigator && global.navigator.mediaDevices;
    if (!md || !md.getUserMedia) return Promise.reject(new Error('NO_MIC_API'));
    return md.getUserMedia({
      audio: {
        /* The layer the docs used to claim and the code never requested: without
           a stream of our own there was nothing to apply these to. */
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    }).then(function (stream) {
      _stream = stream;
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) throw new Error('NO_AUDIO_CTX');
      /* Ask for 16 kHz directly; the host resamples once, which is cheaper than
         doing it per frame and is the rate the ASR side wants. */
      try { _ctx = new AC({ sampleRate: TARGET_RATE }); } catch (e) { _ctx = new AC(); }
      _rate = _ctx.sampleRate || TARGET_RATE;
      _src = _ctx.createMediaStreamSource(stream);

      var worklet = _ctx.audioWorklet && global.AudioWorkletNode;
      if (!worklet) return startScriptProcessor();

      var url = global.URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      return _ctx.audioWorklet.addModule(url).then(function () {
        global.URL.revokeObjectURL(url);
        _node = new global.AudioWorkletNode(_ctx, 'ryza-tap');
        _node.port.onmessage = function (ev) { onFrame(ev.data); };
        _src.connect(_node);
        /* A worklet only runs while connected to a destination; a zero gain
           keeps the microphone out of the speakers. */
        var mute = _ctx.createGain();
        mute.gain.value = 0;
        _node.connect(mute);
        mute.connect(_ctx.destination);
        return true;
      }).catch(function () {
        global.URL.revokeObjectURL(url);
        return startScriptProcessor();
      });
    });
  }

  function startScriptProcessor() {
    if (!_ctx.createScriptProcessor) return Promise.reject(new Error('NO_AUDIO_TAP'));
    _node = _ctx.createScriptProcessor(2048, 1, 1);
    _node.onaudioprocess = function (ev) {
      onFrame(ev.inputBuffer.getChannelData(0));
    };
    _src.connect(_node);
    var mute = _ctx.createGain();
    mute.gain.value = 0;
    _node.connect(mute);
    mute.connect(_ctx.destination);
    return Promise.resolve(true);
  }

  var _lastTick = 0;
  /* One audio frame in: buffer it, and evaluate the gate at most every FRAME_MS
     so the thresholds stay in wall-clock terms regardless of the block size. */
  function onFrame(channel) {
    if (!_want || !channel) return;
    pushFrame(channel, false);
    var now = _now();
    if (_lastTick && now - _lastTick < FRAME_MS) return;
    _lastTick = now;
    feedLevel(frameLevel(channel, false), now);
  }

  function teardown() {
    _lastTick = 0;
    _speaking = false;
    _voicedSince = 0;
    _silentSince = 0;
    _pcm = [];
    _pcmSamples = 0;
    _busy = false;
    try { if (_node) { _node.port && (_node.port.onmessage = null); _node.onaudioprocess = null; _node.disconnect(); } } catch (e) {}
    try { if (_src) _src.disconnect(); } catch (e) {}
    try { if (_ctx) _ctx.close(); } catch (e) {}
    /* Releasing the tracks is what turns the recording indicator off; skipping
       it is the classic "the browser still says it is listening" bug. */
    try { if (_stream) _stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    _node = null; _src = null; _ctx = null; _stream = null;
  }

  var Stt = {
    MIN_SPEECH_MS: MIN_SPEECH_MS,
    CANDIDATE_SILENCE_MS: CANDIDATE_SILENCE_MS,
    TARGET_RATE: TARGET_RATE,

    /* ------------------------------------------------------------- ports */
    setTranscriber: function (fn) { _transcribe = (typeof fn === 'function') ? fn : null; },
    setNotice: function (fn) { _notice = (typeof fn === 'function') ? fn : null; },
    setSink: function (fn) { _sink = (typeof fn === 'function') ? fn : null; },
    setLang: function (fn) { _lang = (typeof fn === 'function') ? fn : null; },
    setClock: function (fn) { _now = (typeof fn === 'function') ? fn : _now; },
    /* fn() — fired once per confirmed speech onset, i.e. the player started
       talking. This is the true onset that used to be available only where the
       browser recogniser had onspeechstart. */
    setOnset: function (fn) { _ononset = (typeof fn === 'function') ? fn : null; },

    /* ------------------------------------------------------------- state */
    available: function () {
      var md = global.navigator && global.navigator.mediaDevices;
      return !!(md && md.getUserMedia);
    },
    isListening: function () { return !!_want; },
    isSpeaking: function () { return !!_speaking; },
    level: function () { return _level; },
    baseline: function () { return _baseline; },

    start: function () {
      if (_want) return Promise.resolve(true);
      if (!Stt.available()) { notice('mic.unsupported', true); return Promise.resolve(false); }
      _want = true;
      return startCapture().then(function () {
        notice('mic.on', false);
        return true;
      }).catch(function (e) {
        _want = false;
        teardown();
        var name = (e && e.name) || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') notice('mic.denied', true);
        else if (name === 'NotFoundError' || name === 'OverconstrainedError') notice('mic.nodevice', true);
        else notice('mic.error:' + name + ':' + ((e && e.message) || e), true);
        return false;
      });
    },

    stop: function () {
      _want = false;
      teardown();
      notice('mic.off', false);
      return true;
    },

    toggle: function () { return Stt.isListening() ? Stt.stop() : Stt.start(); },

    /* ------------------------------------------------- exposed for tests
       The gate is fed by real audio in production and by the regression
       directly, so onset/endpoint behaviour is testable without a microphone. */
    _feedLevel: feedLevel,
    _pushFrame: pushFrame,
    _frameLevel: frameLevel,
    _wavBlob: wavBlob,
    _close: closeUtterance,
    _state: function () {
      return {
        speaking: _speaking, busy: _busy, frames: _pcm.length,
        samples: _pcmSamples, sentAt: _sentAt, want: _want
      };
    },
    _reset: function () {
      _lastTick = 0; _speaking = false; _voicedSince = 0; _silentSince = 0;
      _pcm = []; _pcmSamples = 0; _busy = false; _want = false;
      _level = 0; _baseline = 0; _rate = TARGET_RATE;
    }
  };

  global.Stt = Stt;
})(typeof window !== 'undefined' ? window : globalThis);
