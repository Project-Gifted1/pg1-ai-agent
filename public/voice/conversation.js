// PG1 voice, phase 2: hands-free conversation with barge-in.
//
// Everything that decides *when* the operator is talking lives here, with no
// DOM and no browser globals, so tests can drive it with fake frames and a
// fake clock (tests/voice-conversation.test.mjs). public/index.html wires it
// to the real microphone, the speech recogniser and the chat composer.
//
//   mic ─▶ AudioWorklet (public/voice/vad-worklet.js) ─▶ frame assembler
//       ─▶ 512-sample frames at 16 kHz ─▶ VAD (Silero via onnxruntime-web,
//       energy detector as the fallback) ─▶ speech probability per frame
//       ─▶ turn tracker ─▶ turn_start / turn_end / barge_in events
//
// Speech-to-text stays with the browser's own recogniser: its transcript is
// the only thing that leaves this module, as the message sent to PG1. No
// audio is kept anywhere: frames are scored and dropped.
//
// The wrapper hands the global object to the factory as `root`: the factory
// is its own function, so it cannot see the wrapper's parameters, and the
// browser helpers below (openMicrophone, loadOnnxRuntime, the phrase hints)
// read navigator, document, AudioContext and friends from `root`. Chrome
// surfaced this as the toast "root is not defined" when the factory took no
// argument (PR #236). The tests load this file in a vm context whose global
// object is the context itself, so the same `root` works there.
(function (root, factory) {
  const api = factory(root);
  root.PG1Voice = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    sampleRate: 16000,
    frameSamples: 512,          // 32 ms at 16 kHz, what Silero expects
    speechThreshold: 0.5,       // speech probability that starts a turn
    releaseThreshold: 0.35,     // ...and the lower one that keeps it going
    bargeInThreshold: 0.85,     // higher while PG1 is talking (speaker echo)
    bargeInSustainMs: 300,      // sustained speech needed to interrupt
    bargeInGapMs: 100,          // a dip shorter than this does not reset it
    minTurnSpeechMs: 150,       // shorter blips are ignored
    endOfTurnSilenceMs: 800,    // silence that ends the operator's turn
    finalGraceMs: 1500,         // wait this long for the recogniser's final text
    autoOffSilenceMs: 120000,   // 2 minutes without speech switches off
    echoThreshold: 0.8          // transcript this similar to PG1's speech is echo
  });

  // ---------------------------------------------------------------------------
  // Frame assembly: any input rate, any block size -> fixed frames at 16 kHz.

  // Linear-interpolation resampler that cuts the stream into frames of
  // `frameSamples` and hands each one to onFrame as a fresh Float32Array.
  function createFrameAssembler(inputRate, onFrame, opts = {}) {
    const targetRate = opts.sampleRate || DEFAULTS.sampleRate;
    const frameSamples = opts.frameSamples || DEFAULTS.frameSamples;
    const ratio = inputRate / targetRate;
    let frame = new Float32Array(frameSamples);
    let filled = 0;
    let pos = 0;        // fractional read position in the current block
    let prev = 0;       // last sample of the previous block
    const emit = (v) => {
      frame[filled++] = v;
      if (filled === frameSamples) {
        const out = frame;
        frame = new Float32Array(frameSamples);
        filled = 0;
        onFrame(out);
      }
    };
    return {
      push(block) {
        const n = block.length;
        if (!n) return;
        if (ratio === 1) {
          for (let i = 0; i < n; i++) emit(block[i]);
          return;
        }
        while (pos < n - 1) {
          const i = Math.floor(pos);
          const frac = pos - i;
          const s0 = i < 0 ? prev : block[i];
          const s1 = block[i + 1];
          emit(s0 + (s1 - s0) * frac);
          pos += ratio;
        }
        pos -= n;
        prev = block[n - 1];
      },
      reset() { filled = 0; pos = 0; prev = 0; }
    };
  }

  // ---------------------------------------------------------------------------
  // Voice activity detectors. Both expose process(frame) -> probability in
  // [0, 1] (a Promise for Silero, a plain number for the energy detector),
  // reset() and a name.

  // Energy detector: RMS of the frame against a slowly adapting noise floor.
  // Roughly 6 dB over the floor starts to count as speech, 15 dB is certain.
  function createEnergyVad(opts = {}) {
    const minRms = opts.minRms || 0.004;     // below this is digital silence
    const riseRate = opts.riseRate || 0.004; // how fast the floor follows a louder room
    let floor = null;
    return {
      name: 'energy',
      process(frame) {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / (frame.length || 1));
        if (floor === null) floor = Math.max(rms, minRms);
        else if (rms < floor) floor = floor + (rms - floor) * 0.3;
        else floor = floor + (rms - floor) * riseRate;
        floor = Math.max(floor, minRms);
        if (rms < minRms) return 0;
        const snr = rms / floor;
        // 2x (6 dB) -> 0, 5.6x (15 dB) -> 1
        return Math.min(1, Math.max(0, (snr - 2) / 3.6));
      },
      reset() { floor = null; },
      get noiseFloor() { return floor; }
    };
  }

  // Silero VAD (v5 ONNX graph) on onnxruntime-web. `ort` is the runtime's
  // global; the model and the runtime's wasm are served from this app.
  // Rejects when anything is missing, so loadVad can fall back.
  async function createSileroVad(ort, opts = {}) {
    if (!ort || !ort.InferenceSession || !ort.Tensor) throw new Error('onnxruntime-web is not available');
    const modelUrl = opts.modelUrl || '/voice/silero_vad_v5.onnx';
    const CONTEXT = 64;
    const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(DEFAULTS.sampleRate)]), []);
    let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    let context = new Float32Array(CONTEXT);
    return {
      name: 'silero',
      async process(frame) {
        const input = new Float32Array(CONTEXT + frame.length);
        input.set(context, 0);
        input.set(frame, CONTEXT);
        context = frame.slice(-CONTEXT);
        const out = await session.run({ input: new ort.Tensor('float32', input, [1, input.length]), state, sr });
        if (!out.stateN || !out.output || !out.output.data) throw new Error('Silero VAD returned no output');
        state = out.stateN;
        const p = Number(out.output.data[0]);
        return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
      },
      reset() {
        state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
        context = new Float32Array(CONTEXT);
      },
      async release() { try { await session.release(); } catch (e) { /* already gone */ } }
    };
  }

  // Silero when it loads, the energy detector otherwise. `loadRuntime`
  // resolves to the onnxruntime-web global (or rejects). onFallback(error)
  // is told why Silero was skipped.
  async function loadVad({ loadRuntime, modelUrl, onFallback, timeoutMs = 15000 } = {}) {
    try {
      if (typeof loadRuntime !== 'function') throw new Error('no runtime loader');
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('VAD load timed out')), timeoutMs); });
      try {
        const ort = await Promise.race([loadRuntime(), timeout]);
        const vad = await Promise.race([createSileroVad(ort, { modelUrl }), timeout]);
        return vad;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (typeof onFallback === 'function') onFallback(err);
      return createEnergyVad();
    }
  }

  // ---------------------------------------------------------------------------
  // Turn tracker: speech probabilities in, turn events out. Time comes from
  // the caller (ms), so the tests can run it without waiting.

  function createTurnTracker(opts = {}) {
    const o = Object.assign({}, DEFAULTS, opts);
    let speaking = false;        // the current frame run counts as speech
    let speechStartedAt = null;  // start of the current speech run
    let lastSpeechAt = null;     // last frame that counted as speech
    let inTurn = false;          // the operator's turn is open
    let turnStartedAt = null;
    let lastActivityAt = null;   // speech of any kind, for auto-off
    let bargeStartedAt = null;   // start of the sustained run during playback
    let bargeLastAt = null;

    function update({ prob, playing, now }) {
      const events = [];
      if (lastActivityAt === null) lastActivityAt = now;
      const p = Number(prob) || 0;

      // Barge-in: while PG1 talks, only a sustained, confident run counts.
      if (playing && !inTurn) {
        if (p >= o.bargeInThreshold) {
          if (bargeStartedAt === null || now - bargeLastAt > o.bargeInGapMs) bargeStartedAt = now;
          bargeLastAt = now;
          lastActivityAt = now;
          if (now - bargeStartedAt >= o.bargeInSustainMs) {
            events.push('barge_in');
            inTurn = true;
            turnStartedAt = bargeStartedAt;
            speaking = true;
            speechStartedAt = bargeStartedAt;
            lastSpeechAt = now;
            bargeStartedAt = bargeLastAt = null;
          }
        } else if (bargeStartedAt !== null && now - bargeLastAt > o.bargeInGapMs) {
          bargeStartedAt = bargeLastAt = null;
        }
        speaking = false;
        return events;
      }
      bargeStartedAt = bargeLastAt = null;

      const threshold = speaking ? o.releaseThreshold : o.speechThreshold;
      if (p >= threshold) {
        if (!speaking) { speaking = true; speechStartedAt = now; }
        lastSpeechAt = now;
        lastActivityAt = now;
        if (!inTurn && now - speechStartedAt >= o.minTurnSpeechMs) {
          inTurn = true;
          turnStartedAt = speechStartedAt;
          events.push('turn_start');
        }
      } else {
        speaking = false;
      }

      if (inTurn && lastSpeechAt !== null && now - lastSpeechAt >= o.endOfTurnSilenceMs) {
        inTurn = false;
        speaking = false;
        events.push('turn_end');
      }
      return events;
    }

    return {
      update,
      // Evidence of speech from outside (the recogniser produced text).
      // It opens a turn the detector missed; it never extends one that is
      // open, so the recogniser's own lag does not push the 800 ms out.
      noteSpeech(now) {
        lastActivityAt = now;
        if (inTurn) return [];
        lastSpeechAt = now;
        inTurn = true;
        turnStartedAt = now;
        return ['turn_start'];
      },
      // Ends an open turn without waiting for silence.
      endTurn() { const was = inTurn; inTurn = false; speaking = false; return was; },
      idleMs(now) { return lastActivityAt === null ? 0 : now - lastActivityAt; },
      reset(now) {
        speaking = false; speechStartedAt = null; lastSpeechAt = null; inTurn = false; turnStartedAt = null;
        bargeStartedAt = bargeLastAt = null;
        lastActivityAt = typeof now === 'number' ? now : null;
      },
      get inTurn() { return inTurn; },
      get speaking() { return speaking; },
      get turnStartedAt() { return turnStartedAt; }
    };
  }

  // ---------------------------------------------------------------------------
  // Transcript hygiene.

  // "Hey PG1" comes back from the recogniser as "April", "a PG one", "PG
  // one" and friends. Only the start of an utterance is touched, so a
  // sentence about the month of April is left alone.
  const WAKE_RE = /^(\s*)((?:(?:hey|hi|hello|ok|okay|yo)[,\s]+)?)(april|a\s*p\.?\s*g\.?\s*(?:one|1|won)|p\.?\s*g\.?\s*(?:one|1|won)|peachy\s*(?:one|1)|pee\s*gee\s*(?:one|1|won)|pg1)(?=$|[\s,.!?:;])/i;
  function normaliseWakeWord(text) {
    if (typeof text !== 'string') return '';
    return text.replace(WAKE_RE, (m, lead, greeting) => `${lead}${greeting}PG1`);
  }

  function echoTokens(text) {
    return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
  }

  // How much of `transcript` is found, in order, in `spoken`: the share of
  // its words that match along the best common subsequence. 1 means every
  // word of the transcript appears in that order in what was spoken.
  function echoSimilarity(transcript, spoken) {
    const a = echoTokens(transcript);
    const b = echoTokens(spoken);
    if (!a.length || !b.length) return 0;
    // Longest common subsequence over words (small inputs, O(n*m)).
    let prevRow = new Uint16Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      const row = new Uint16Array(b.length + 1);
      for (let j = 1; j <= b.length; j++) {
        row[j] = a[i - 1] === b[j - 1] ? prevRow[j - 1] + 1 : Math.max(prevRow[j], row[j - 1]);
      }
      prevRow = row;
    }
    return prevRow[b.length] / a.length;
  }

  // True when the transcript is (part of) something PG1 just said. One- or
  // two-word transcripts ("yes", "stop") only count as echo when they are
  // the whole of a spoken text, so short real answers still get through.
  function isEchoOfSpoken(transcript, spokenTexts, opts = {}) {
    const threshold = opts.threshold || DEFAULTS.echoThreshold;
    const words = echoTokens(transcript);
    if (!words.length) return false;
    const list = Array.isArray(spokenTexts) ? spokenTexts : [spokenTexts];
    for (const spoken of list) {
      if (!spoken) continue;
      if (words.length <= 2) {
        if (echoTokens(spoken).join(' ') === words.join(' ')) return true;
        continue;
      }
      if (echoSimilarity(transcript, spoken) >= threshold) return true;
    }
    return false;
  }

  // The last few things PG1 said out loud, for the echo guard.
  function createSpokenLog(max = 4) {
    const texts = [];
    return {
      add(text) {
        const t = typeof text === 'string' ? text.trim() : '';
        if (!t) return;
        if (texts[texts.length - 1] === t) return;
        texts.push(t);
        while (texts.length > max) texts.shift();
      },
      get texts() { return texts.slice(); },
      clear() { texts.length = 0; }
    };
  }

  // ---------------------------------------------------------------------------
  // The conversation itself: ties mic, VAD, recogniser and chat together.
  //
  // deps (all injectable, see index.html for the real ones):
  //   now()                      ms clock
  //   setTimeout/clearTimeout
  //   openMic()                  -> Promise<{ onFrame(cb), close() }>  frames at 16 kHz
  //   loadVad()                  -> Promise<vad>
  //   createRecognition()        -> SpeechRecognition-like object or null
  //   isPlaying()                PG1's voice is coming out of the speaker
  //   isBusy()                   a reply is still being fetched
  //   stopPlayback()             silence PG1 now
  //   abortRequests()            abort the reply being fetched
  //   send(text)                 submit the operator's message
  //   spokenLog                  createSpokenLog() shared with the page
  //   onState(state, detail)     'listening' | 'thinking' | 'speaking' | 'off'
  //   onTranscript(text)         live (interim) text for the indicator
  //   onError(message)

  function createConversation(deps, opts = {}) {
    const o = Object.assign({}, DEFAULTS, opts);
    const now = deps.now || (() => Date.now());
    const setT = deps.setTimeout || setTimeout;
    const clearT = deps.clearTimeout || clearTimeout;
    const tracker = createTurnTracker(o);
    const spokenLog = deps.spokenLog || createSpokenLog();

    let on = false;
    let starting = false;
    let state = 'off';
    let mic = null;
    let vad = null;
    let recognition = null;
    let recognitionWanted = false;  // restart it when it ends on its own
    let recognitionRunning = false;
    let finalText = '';
    let interimText = '';
    let flushing = null;            // { timer, resolve } while a turn is finalised
    let processing = false;         // a VAD frame is being scored
    let queuedFrame = null;
    let stopReason = null;
    let wasPlaying = false;
    let restartTimer = null;

    const setState = (next, detail) => {
      if (next === state && !detail) return;
      state = next;
      if (deps.onState) deps.onState(next, detail || '');
    };
    const fail = (msg) => { if (deps.onError) deps.onError(msg); };

    function syncState() {
      if (!on) return;
      if (deps.isPlaying && deps.isPlaying()) setState('speaking');
      else if (deps.isBusy && deps.isBusy()) setState('thinking');
      else setState('listening');
    }

    // --- recogniser -------------------------------------------------------

    function clearTranscript() { finalText = ''; interimText = ''; if (deps.onTranscript) deps.onTranscript(''); }

    function startRecognition() {
      if (!on || !recognition || recognitionRunning) return;
      recognitionWanted = true;
      // A fresh session starts with an empty transcript.
      finalText = ''; interimText = '';
      try {
        recognition.start();
        recognitionRunning = true;
      } catch (e) {
        // "already started" or a transient failure: try again shortly.
        recognitionRunning = false;
        scheduleRecognitionRestart(300);
      }
    }

    function scheduleRecognitionRestart(ms) {
      if (restartTimer) clearT(restartTimer);
      restartTimer = setT(() => { restartTimer = null; if (on && recognitionWanted && !recognitionRunning) startRecognition(); }, ms);
    }

    // Drop whatever the recogniser has heard so far and listen afresh.
    function restartRecognitionClean() {
      clearTranscript();
      if (!recognition) return;
      recognitionWanted = on;
      if (recognitionRunning) {
        try { recognition.abort(); } catch (e) { /* not running */ }
        recognitionRunning = false;
      }
      if (on) scheduleRecognitionRestart(50);
    }

    function attachRecognition(r) {
      r.continuous = true;
      r.interimResults = true;
      if (deps.language) r.lang = deps.language;
      // Chrome 139+ accepts phrase hints on the recogniser. Anything older
      // ignores them; normaliseWakeWord covers the gap either way.
      try {
        if (typeof root.SpeechRecognitionPhrase === 'function' && 'phrases' in r) {
          r.phrases = [new root.SpeechRecognitionPhrase('PG1', 5.0)];
        }
      } catch (e) { /* hints unsupported */ }
      r.onresult = (event) => {
        // Results after stop() (or from a session already abandoned) are stale.
        if (!on || !recognitionRunning) return;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const alt = res && res[0];
          const text = alt && typeof alt.transcript === 'string' ? alt.transcript : '';
          if (!text) continue;
          if (res.isFinal) finalText = (finalText + ' ' + text).trim();
          else interim += text;
        }
        interimText = interim.trim();
        // Anything heard while PG1 is talking and no barge-in has been
        // confirmed is the speaker, not the operator: it is dropped.
        if (deps.isPlaying && deps.isPlaying() && !tracker.inTurn) { finalText = ''; interimText = ''; return; }
        if (deps.onTranscript) deps.onTranscript((finalText + ' ' + interimText).trim());
        if (finalText && !flushing) {
          // The recogniser finalised something: that is speech too, even
          // if the detector missed it.
          tracker.noteSpeech(now());
        }
      };
      r.onerror = (event) => {
        const code = event && event.error;
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          fail('Microphone access was refused.');
          stop('error');
          return;
        }
        if (code === 'network') fail('Speech recognition needs a network connection.');
        // 'no-speech' and 'aborted' are routine; onend restarts it.
      };
      r.onend = () => {
        recognitionRunning = false;
        if (flushing) { const f = flushing; flushing = null; clearT(f.timer); f.resolve(); return; }
        if (on && recognitionWanted) scheduleRecognitionRestart(100);
      };
    }

    // Stop the recogniser so it flushes its final text, then resolve.
    function flushRecognition() {
      return new Promise((resolve) => {
        if (!recognition || !recognitionRunning) { resolve(); return; }
        const timer = setT(() => { if (flushing) { flushing = null; resolve(); } }, o.finalGraceMs);
        flushing = { timer, resolve };
        try { recognition.stop(); } catch (e) { flushing = null; clearT(timer); resolve(); }
      });
    }

    // --- turn handling ----------------------------------------------------

    async function finishTurn() {
      const bufferedBefore = (finalText + ' ' + interimText).trim();
      await flushRecognition();
      if (!on) return;
      let text = (finalText || interimText || bufferedBefore).trim();
      finalText = ''; interimText = '';
      if (deps.onTranscript) deps.onTranscript('');
      text = normaliseWakeWord(text).trim();
      const echoed = text && isEchoOfSpoken(text, spokenLog.texts, { threshold: o.echoThreshold });
      if (echoed) text = '';
      if (text) {
        if (deps.send) deps.send(text);
        setState('thinking', text);
      }
      syncState();
      scheduleRecognitionRestart(50);
    }

    function bargeIn() {
      if (deps.stopPlayback) deps.stopPlayback();
      if (deps.abortRequests) deps.abortRequests();
      restartRecognitionClean();
      setState('listening', 'interrupted');
    }

    async function scoreFrame(frame) {
      if (!on || !vad) return;
      let prob = 0;
      try {
        prob = await vad.process(frame);
      } catch (e) {
        // A broken Silero session falls back to energy for the rest of the
        // conversation rather than going deaf.
        if (vad.name !== 'energy') { vad = createEnergyVad(); fail('Voice detection fell back to the basic detector.'); }
        return;
      }
      if (!on) return;
      const t = now();
      const playing = !!(deps.isPlaying && deps.isPlaying());
      if (wasPlaying && !playing && !tracker.inTurn) {
        // PG1 just finished talking without being interrupted: forget
        // anything the recogniser picked up from the speaker.
        restartRecognitionClean();
      }
      wasPlaying = playing;
      const events = tracker.update({ prob, playing, now: t });
      for (const ev of events) {
        if (ev === 'barge_in') bargeIn();
        else if (ev === 'turn_end') finishTurn();
      }
      if (tracker.idleMs(t) >= o.autoOffSilenceMs) { stop('silence'); return; }
      syncState();
    }

    function onFrame(frame) {
      if (!on) return;
      if (processing) { queuedFrame = frame; return; }
      processing = true;
      Promise.resolve(scoreFrame(frame)).catch(() => {}).then(() => {
        processing = false;
        if (queuedFrame) { const f = queuedFrame; queuedFrame = null; onFrame(f); }
      });
    }

    // --- lifecycle --------------------------------------------------------

    async function start() {
      if (on || starting) return false;
      starting = true;
      stopReason = null;
      try {
        if (deps.createRecognition) recognition = deps.createRecognition();
        if (!recognition) throw new Error('Speech recognition is not available in this browser.');
        attachRecognition(recognition);
        vad = await deps.loadVad();
        mic = await deps.openMic();
        if (!mic) throw new Error('Microphone is not available.');
        on = true;
        tracker.reset(now());
        wasPlaying = false;
        clearTranscript();
        mic.onFrame(onFrame);
        startRecognition();
        setState('listening', 'started');
        return true;
      } catch (err) {
        on = false;
        fail((err && err.message) || 'Conversation mode could not start.');
        await teardown();
        setState('off', 'error');
        return false;
      } finally {
        starting = false;
      }
    }

    async function teardown() {
      recognitionWanted = false;
      if (restartTimer) { clearT(restartTimer); restartTimer = null; }
      if (flushing) { const f = flushing; flushing = null; clearT(f.timer); f.resolve(); }
      if (recognition) {
        try { recognition.abort(); } catch (e) { /* not running */ }
        recognition.onresult = recognition.onend = recognition.onerror = null;
        recognition = null;
        recognitionRunning = false;
      }
      if (mic) { try { await mic.close(); } catch (e) { /* already closed */ } mic = null; }
      if (vad && vad.release) { try { await vad.release(); } catch (e) { /* ignore */ } }
      vad = null;
      queuedFrame = null;
      finalText = ''; interimText = '';
    }

    // reason: 'tap' | 'silence' | 'hidden' | 'error' | 'dictation'
    async function stop(reason) {
      if (!on && !starting) return;
      on = false;
      stopReason = reason || 'tap';
      await teardown();
      if (deps.onTranscript) deps.onTranscript('');
      setState('off', stopReason);
    }

    return {
      start,
      stop,
      get on() { return on; },
      get state() { return state; },
      get stopReason() { return stopReason; },
      get vadName() { return vad ? vad.name : null; },
      get tracker() { return tracker; },
      // For tests and the page: push a frame straight into the detector.
      feedFrame: onFrame
    };
  }

  // ---------------------------------------------------------------------------
  // Browser helpers (used by index.html; harmless under Node).

  // Opens the microphone with echo cancellation, noise suppression and
  // automatic gain, and streams 16 kHz frames through an AudioWorklet
  // (ScriptProcessor where worklets are missing). Nothing is recorded.
  async function openMicrophone({ workletUrl = '/voice/vad-worklet.js', frameSamples = DEFAULTS.frameSamples } = {}) {
    const nav = root.navigator;
    if (!nav || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) throw new Error('Microphone is not available.');
    const stream = await nav.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const Ctor = root.AudioContext || root.webkitAudioContext;
    if (!Ctor) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Web Audio is not available.'); }
    const ctx = new Ctor();
    if (ctx.state === 'suspended' && ctx.resume) { try { await ctx.resume(); } catch (e) { /* resumed on the next gesture */ } }
    const source = ctx.createMediaStreamSource(stream);
    let frameCb = null;
    const assembler = createFrameAssembler(ctx.sampleRate, (f) => { if (frameCb) frameCb(f); }, { frameSamples });
    let node;
    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function' && typeof root.AudioWorkletNode === 'function') {
      await ctx.audioWorklet.addModule(workletUrl);
      node = new root.AudioWorkletNode(ctx, 'pg1-vad-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      node.port.onmessage = (e) => { if (e.data instanceof Float32Array) assembler.push(e.data); };
      source.connect(node);
    } else {
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => assembler.push(e.inputBuffer.getChannelData(0));
      source.connect(node);
      // Chrome only runs a ScriptProcessor that is connected to the output;
      // a muted gain keeps the mic out of the speaker.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
    }
    return {
      onFrame(cb) { frameCb = cb; },
      get sampleRate() { return ctx.sampleRate; },
      async close() {
        frameCb = null;
        try { source.disconnect(); } catch (e) { /* ignore */ }
        try { node.disconnect(); } catch (e) { /* ignore */ }
        if (node.port) node.port.onmessage = null;
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
        try { await ctx.close(); } catch (e) { /* ignore */ }
      }
    };
  }

  // Loads onnxruntime-web from this app's own files (no CDN), once.
  let runtimePromise = null;
  function loadOnnxRuntime({ scriptUrl = '/voice/ort.wasm.min.js', wasmPath = '/voice/' } = {}) {
    if (runtimePromise) return runtimePromise;
    runtimePromise = new Promise((resolve, reject) => {
      const doc = root.document;
      if (root.ort && root.ort.InferenceSession) { resolve(root.ort); return; }
      if (!doc || !doc.createElement) { reject(new Error('no document')); return; }
      if (typeof root.WebAssembly === 'undefined') { reject(new Error('WebAssembly is not available')); return; }
      const s = doc.createElement('script');
      s.src = scriptUrl;
      s.async = true;
      s.onload = () => {
        const ort = root.ort;
        if (!ort || !ort.InferenceSession) { reject(new Error('onnxruntime-web did not load')); return; }
        try {
          ort.env.wasm.wasmPaths = wasmPath;
          ort.env.wasm.numThreads = 1;   // no SharedArrayBuffer needed
          ort.env.wasm.proxy = false;
          ort.env.logLevel = 'error';
        } catch (e) { /* defaults */ }
        resolve(ort);
      };
      s.onerror = () => reject(new Error('onnxruntime-web failed to load'));
      doc.head.appendChild(s);
    });
    runtimePromise.catch(() => { runtimePromise = null; });
    return runtimePromise;
  }

  return {
    DEFAULTS,
    createFrameAssembler,
    createEnergyVad,
    createSileroVad,
    loadVad,
    createTurnTracker,
    normaliseWakeWord,
    echoSimilarity,
    isEchoOfSpoken,
    createSpokenLog,
    createConversation,
    openMicrophone,
    loadOnnxRuntime
  };
});
