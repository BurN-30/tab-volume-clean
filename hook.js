// Audio engine, runs in the page world at document_start.
//
// Chain: source -> GainNode (0 to 6, linear) -> WaveShaperNode (soft clipper) -> output.
// With Normalize: source -> GainNode -> leveler GainNode -> WaveShaperNode -> output,
// plus a side chain (filters and analysers) that only measures, never feeds the output.
//
// The gain is a plain linear multiplier, like extensions built on Chrome's tabCapture
// (capture -> GainNode -> output). Firefox has no tab capture API, so the audio is taken
// from inside the page instead. The soft clipper is the only addition: it is an exact identity
// up to -0.9 dBFS (bit-for-bit the same as a plain gain), then bends smoothly toward 1.0, so
// samples that a plain gain would hard-clip at the sound card are rounded off instead.
// It has no memory: no pumping, no level change on quiet passages, no added latency.
// There is no compressor anywhere: the volume changes the level, never the timbre.
//
// The AudioContext is created without a sampleRate, so it runs at the device's native rate.
//
// Nothing is touched while a site is at its defaults (100%, Normalize and Mono off): no AudioContext,
// no captured element. Once another value arrives, the extension captures:
//   - classic <audio>/<video> elements and those playing a MediaStream (srcObject, WebRTC:
//     BigBlueButton, Jitsi...), through createMediaElementSource, which follows the element
//     even when the page swaps its stream;
//   - audio the page makes itself with Web Audio: its connections to the output go through the chain.
// When the extension is turned off for the site, the chains switch to a plain pass-through (gain 1).
(() => {
  "use strict";

  if (window.__tabVolumeCleanHook) return;
  try {
    Object.defineProperty(window, "__tabVolumeCleanHook", { value: true });
  } catch (e) {
    return;
  }

  const AC = window.AudioContext;
  if (!AC || !window.AudioNode || !window.HTMLMediaElement) return;

  const MAX_GAIN = 6;
  // Input range of the shaper curve: the GainNode feeds gain / RANGE, the curve maps [-1, 1] to [-RANGE, RANGE].
  const RANGE = 8;
  const KNEE = 0.9; // identity below this level (-0.9 dBFS)
  const CURVE = (() => {
    const n = 65537;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const y = RANGE * ((2 * i) / (n - 1) - 1);
      const a = Math.abs(y);
      c[i] = Math.sign(y) * (a <= KNEE ? a : KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
    }
    return c;
  })();

  // Native methods kept at load time: a page that replaces them later does not affect us.
  const P = AudioNode.prototype;
  const nativeConnect = P.connect;
  const nativeDisconnect = P.disconnect;
  const nativePlay = HTMLMediaElement.prototype.play;
  const BAC = window.BaseAudioContext ? BaseAudioContext.prototype : AC.prototype;
  const createGain = BAC.createGain;
  const createWaveShaper = BAC.createWaveShaper;
  const createBiquad = BAC.createBiquadFilter;
  const createAnalyser = BAC.createAnalyser;
  const readTimeDomain = AnalyserNode.prototype.getFloatTimeDomainData;
  const createMediaElementSource = AC.prototype.createMediaElementSource;
  const getDestination = Object.getOwnPropertyDescriptor(BAC, "destination").get;
  const getContext = Object.getOwnPropertyDescriptor(P, "context").get;
  const getCurrentTime = Object.getOwnPropertyDescriptor(BAC, "currentTime").get;
  const OfflineAC = window.OfflineAudioContext;
  const DestinationNode = window.AudioDestinationNode;
  const setTimer = window.setInterval.bind(window);
  const clearTimer = window.clearInterval.bind(window);
  const now = () => performance.now();

  // Site settings, sent by bridge.js.
  let gain = 1;
  let normalize = false;
  let mono = false;
  let enabled = true;
  let active = false;

  const ownNodes = new WeakSet();
  const chains = new WeakMap(); // AudioContext -> chain
  const chainList = new Set(); // WeakRef<chain>
  let mediaContext = null;

  // ---------- Normalize: speech leveler ----------
  // ---- leveler:begin (pure code, also loaded by test/bench: keep it self-contained) ----
  // Slow automatic gain for speech, run every ~50 ms on the source level (before the volume).
  // Input: mean square of a weighted block (100 Hz high-pass, +4 dB above 1.5 kHz) and raw peak.
  // - Gate: a block is speech only above -50 dBFS and 10 dB above the noise floor (lowest block of the
  //   last half second). Pauses, breaths and steady background noise never raise the gain: a new steady
  //   noise passes the gate for half a second at most, too little to move the level (75th percentile).
  // - Level: 75th percentile of the speech blocks of a sliding window (the last 30 speech blocks, none older
  //   than 2.5 s). It ignores the dips between syllables, so the gain does not follow them (no pumping),
  //   and a new speaker replaces the previous one within about a second.
  // - Gain: target minus level, from -12 to +12 dB. It rises slowly (time constant 0.5 s, at most 8 dB/s)
  //   and falls faster (0.15 s). Its boost never pushes the source's recent peaks above -1 dBFS.
  // - Long pause (over 1 s): a boost relaxes toward 0 dB at 2 dB/s, a cut stays. So the gain never climbs
  //   in a silence, and a loud voice after a long pause does not start with the boost of a quiet one.
  function createLeveler() {
    const TARGET = -20; // dB, weighted level of speech blocks
    const MAX_BOOST = 12;
    const MAX_CUT = 12;
    const CEILING = -1; // dBFS, peak limit for the boost
    const GATE = -50; // dBFS
    const ABOVE_FLOOR = 10; // dB
    const FLOOR_BLOCKS = 10; // half a second
    const LEVEL_BLOCKS = 20; // about 1 s of speech
    const LEVEL_AGE = 2.5; // s
    const UP_TAU = 0.5; // s
    const UP_RATE = 8; // dB per second
    const DOWN_TAU = 0.15; // s
    const PEAK_FALL = 6; // dB per second
    const HOLD = 1; // s
    const RELAX = 2; // dB per second
    const toDb = (p) => 10 * Math.log10(p + 1e-12);
    const recent = [];
    const speech = [];
    let peakEnv = -Infinity;
    let pause = 0;
    let clock = 0;
    let g = 0;
    return {
      get gainDb() {
        return g;
      },
      step(meanSquare, peak, dt) {
        clock += dt;
        const lvl = toDb(meanSquare);
        const pk = toDb(peak * peak);
        recent.push(lvl);
        if (recent.length > FLOOR_BLOCKS) recent.shift();
        let floor = Infinity;
        for (const v of recent) if (v < floor) floor = v;
        peakEnv = Math.max(pk, peakEnv - PEAK_FALL * dt);
        if (lvl > GATE && lvl > floor + ABOVE_FLOOR) {
          pause = 0;
          speech.push({ t: clock, lvl });
          while (speech.length > LEVEL_BLOCKS || clock - speech[0].t > LEVEL_AGE) speech.shift();
          const sorted = speech.map((b) => b.lvl).sort((a, b) => a - b);
          const level = sorted[Math.floor(0.7 * (sorted.length - 1))];
          let want = Math.max(-MAX_CUT, Math.min(MAX_BOOST, TARGET - level));
          want = Math.min(want, Math.max(0, CEILING - peakEnv));
          if (want > g) g += Math.min((want - g) * (1 - Math.exp(-dt / UP_TAU)), UP_RATE * dt);
          else g += (want - g) * (1 - Math.exp(-dt / DOWN_TAU));
        } else {
          pause += dt;
          if (pause > HOLD && g > 0) g = Math.max(0, g - RELAX * dt);
        }
        // Whatever the gate says, a boost never pushes the current peak above the ceiling.
        if (g > 0) g = Math.min(g, Math.max(0, CEILING - pk));
        return g;
      },
    };
  }
  // ---- leveler:end ----

  const BLOCK = 2048; // analysed samples per step (43 ms at 48 kHz)
  const STEP_MS = 50;
  let levelTimer = null;

  function addLeveler(chain) {
    const ctx = chain.ctx;
    const node = createGain.call(ctx);
    const hp = createBiquad.call(ctx);
    hp.type = "highpass";
    hp.frequency.value = 100;
    hp.Q.value = Math.SQRT1_2;
    const shelf = createBiquad.call(ctx);
    shelf.type = "highshelf";
    shelf.frequency.value = 1500;
    shelf.gain.value = 4;
    const raw = createAnalyser.call(ctx);
    const weighted = createAnalyser.call(ctx);
    raw.fftSize = BLOCK;
    weighted.fftSize = BLOCK;
    for (const n of [node, hp, shelf, raw, weighted]) ownNodes.add(n);
    nativeConnect.call(hp, shelf);
    nativeConnect.call(shelf, weighted);
    chain.norm = {
      node,
      hp,
      raw,
      weighted,
      leveler: createLeveler(),
      bufRaw: new Float32Array(BLOCK),
      bufW: new Float32Array(BLOCK),
      last: now(),
    };
  }

  function levelStep() {
    let any = false;
    for (const ref of chainList) {
      const chain = ref.deref();
      const n = chain && chain.norm;
      if (!n || chain.ctx.state === "closed") continue;
      any = true;
      const t = now();
      const dt = Math.max(0.01, Math.min(0.25, (t - n.last) / 1000));
      n.last = t;
      if (chain.ctx.state !== "running" || gain <= 0) continue;
      readTimeDomain.call(n.raw, n.bufRaw);
      readTimeDomain.call(n.weighted, n.bufW);
      // The side chain sees the signal after the volume GainNode: undo the volume to measure the source.
      const k = RANGE / gain;
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) {
        const a = Math.abs(n.bufRaw[i]);
        if (a > peak) peak = a;
        sum += n.bufW[i] * n.bufW[i];
      }
      const before = n.leveler.gainDb;
      const g = n.leveler.step((sum / BLOCK) * k * k, peak * k, dt);
      if (g !== before) {
        try {
          n.node.gain.setTargetAtTime(Math.pow(10, g / 20), getCurrentTime.call(chain.ctx), g < before ? 0.01 : 0.03);
        } catch (e) {
          // ignored
        }
      }
    }
    if (!any && levelTimer !== null) {
      clearTimer(levelTimer);
      levelTimer = null;
    }
  }

  // ---------- Processing chain ----------

  function buildChain(ctx) {
    let chain = chains.get(ctx);
    if (chain) return chain;
    const input = createGain.call(ctx);
    const shaper = createWaveShaper.call(ctx);
    shaper.curve = CURVE;
    shaper.oversample = "none"; // oversampling filters would colour the signal below the knee
    input.gain.value = enabled ? gain / RANGE : 1;
    ownNodes.add(input);
    ownNodes.add(shaper);
    chain = { ctx, input, shaper, output: shaper, norm: null, layout: "", meter: null };
    chains.set(ctx, chain);
    chainList.add(new WeakRef(chain));
    wire(chain);
    return chain;
  }

  // Connects the chain for the current settings. Only touches the graph when the layout changes.
  // Off for the site: input (gain 1) -> output, nothing else.
  // Defaults: input -> shaper -> output, exactly as in 1.1.1.
  function wire(chain) {
    const useNorm = enabled && normalize;
    const layout = !enabled ? "bypass" : useNorm ? "norm" : "plain";
    const { ctx, input, shaper } = chain;
    // Mono: the volume GainNode mixes its input down to one channel (L + R) / 2, the output plays it on both sides.
    // Off: back to the GainNode defaults (2 channels, "max"), so the stream is untouched.
    const wantMono = enabled && mono;
    if (wantMono !== (input.channelCountMode === "explicit")) {
      input.channelCount = wantMono ? 1 : 2;
      input.channelCountMode = wantMono ? "explicit" : "max";
    }
    if (layout === chain.layout) return;
    if (useNorm && !chain.norm) addLeveler(chain);
    const dest = getDestination.call(ctx);
    // Connect the new path first, then remove the old one, so the sound is never cut.
    let out;
    if (layout === "bypass") {
      nativeConnect.call(input, dest);
      out = input;
    } else if (layout === "plain") {
      nativeConnect.call(input, shaper);
      out = shaper;
    } else {
      const n = chain.norm;
      nativeConnect.call(n.node, shaper);
      nativeConnect.call(input, n.node);
      nativeConnect.call(input, n.raw);
      nativeConnect.call(input, n.hp);
      out = shaper;
    }
    if (out === shaper && chain.layout !== "plain" && chain.layout !== "norm") nativeConnect.call(shaper, dest);
    const tryOff = (a, b) => {
      try {
        nativeDisconnect.call(a, b);
      } catch (e) {
        // not connected
      }
    };
    if (layout !== "bypass") tryOff(input, dest);
    if (layout !== "plain") tryOff(input, shaper);
    if (layout === "bypass") tryOff(shaper, dest);
    if (layout !== "norm" && chain.norm) {
      const n = chain.norm;
      tryOff(input, n.node);
      tryOff(input, n.raw);
      tryOff(input, n.hp);
      tryOff(n.node, shaper);
      chain.norm = null; // the next Normalize starts from a fresh leveler
    }
    if (chain.meter) {
      tryOff(chain.output, chain.meter.node);
      nativeConnect.call(out, chain.meter.node);
    }
    chain.output = out;
    chain.layout = layout;
    if (layout === "norm" && levelTimer === null) levelTimer = setTimer(levelStep, STEP_MS);
  }

  function applyToChains() {
    for (const ref of chainList) {
      const chain = ref.deref();
      if (!chain || chain.ctx.state === "closed") {
        chainList.delete(ref);
        continue;
      }
      const param = chain.input.gain;
      const t = getCurrentTime.call(chain.ctx);
      const target = enabled ? gain / RANGE : 1;
      try {
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
        param.setTargetAtTime(target, t, 0.015); // smooth change, no click
      } catch (e) {
        param.value = target;
      }
      try {
        wire(chain);
      } catch (e) {
        // the previous layout stays
      }
    }
  }

  // ---------- Audio made by the page with Web Audio ----------

  // Connections to the output of a page AudioContext: node -> [{ output, routed }]
  const destLinks = new WeakMap();
  const destNodes = new Set(); // WeakRef<AudioNode>

  function isRealtimeDestination(node) {
    if (!DestinationNode || !(node instanceof DestinationNode)) return false;
    const ctx = getContext.call(node);
    return !(OfflineAC && ctx instanceof OfflineAC);
  }

  function routeLink(node, link) {
    const ctx = getContext.call(node);
    if (ctx.state === "closed") return;
    const chain = buildChain(ctx);
    try {
      nativeDisconnect.call(node, getDestination.call(ctx), link.output, 0);
    } catch (e) {
      // already disconnected
    }
    nativeConnect.call(node, chain.input, link.output, 0);
    link.routed = true;
  }

  P.connect = function connect(target, output, input) {
    if (!ownNodes.has(this) && isRealtimeDestination(target)) {
      const out = output === undefined ? 0 : output;
      let links = destLinks.get(this);
      if (!links) {
        links = [];
        destLinks.set(this, links);
        destNodes.add(new WeakRef(this));
      }
      let link = links.find((l) => l.output === out);
      if (!link) {
        link = { output: out, routed: false };
        links.push(link);
      }
      if (active) {
        // Let the native method validate the arguments (and throw the expected error if they are wrong).
        const result = nativeConnect.apply(this, arguments);
        try {
          routeLink(this, link);
        } catch (e) {
          // on failure the native connection stays: the page is never silenced
        }
        return result;
      }
    }
    return nativeConnect.apply(this, arguments);
  };

  P.disconnect = function disconnect(target) {
    if (arguments.length === 0) {
      destLinks.delete(this);
    } else if (target && isRealtimeDestination(target)) {
      const links = destLinks.get(this);
      const out = arguments.length > 1 ? arguments[1] : undefined;
      const routed = links ? links.filter((l) => l.routed && (out === undefined || l.output === out)) : [];
      if (routed.length) {
        const chain = chains.get(getContext.call(this));
        for (const l of routed) {
          try {
            nativeDisconnect.call(this, chain.input, l.output, 0);
          } catch (e) {
            // already disconnected
          }
        }
        destLinks.set(this, links.filter((l) => !routed.includes(l)));
        return undefined;
      }
      if (links) destLinks.set(this, links.filter((l) => out !== undefined && l.output !== out));
    }
    return nativeDisconnect.apply(this, arguments);
  };

  function routeRecordedLinks() {
    for (const ref of destNodes) {
      const node = ref.deref();
      const links = node && destLinks.get(node);
      if (!links || !links.length) {
        destNodes.delete(ref);
        continue;
      }
      for (const link of links) {
        if (link.routed) continue;
        try {
          routeLink(node, link);
        } catch (e) {
          // left as is
        }
      }
    }
  }

  // ---------- <audio> and <video> elements ----------

  const seen = new WeakSet();
  const mediaList = new Set(); // WeakRef<HTMLMediaElement>
  const captured = new WeakSet();
  const fallback = new WeakMap(); // element -> original volume (lowering only)

  function track(el) {
    if (!seen.has(el)) {
      seen.add(el);
      mediaList.add(new WeakRef(el));
    }
    if (active) attach(el);
  }

  HTMLMediaElement.prototype.play = function play() {
    try {
      track(this);
    } catch (e) {
      // never block playback
    }
    return nativePlay.apply(this, arguments);
  };

  document.addEventListener(
    "play",
    (e) => {
      if (e.target instanceof HTMLMediaElement) track(e.target);
    },
    true
  );

  function isCrossOriginWithoutCors(el) {
    if (el.srcObject) return false; // MediaStream (WebRTC): never opaque
    const src = el.currentSrc || el.src;
    if (!src || /^(blob|data|mediasource):/i.test(src)) return false;
    try {
      return new URL(src, location.href).origin !== location.origin && el.crossOrigin === null;
    } catch (e) {
      return false;
    }
  }

  function needsFallback(el) {
    // DRM media or cross-origin media without CORS: once captured it would go silent.
    // Output device picked by the page (setSinkId): the AudioContext would ignore it.
    return Boolean(el.mediaKeys) || isCrossOriginWithoutCors(el) || Boolean(el.sinkId);
  }

  function applyFallback(el) {
    if (!fallback.has(el)) fallback.set(el, el.volume);
    try {
      el.volume = Math.max(0, Math.min(1, fallback.get(el) * (enabled ? Math.min(1, gain) : 1)));
    } catch (e) {
      // ignored
    }
  }

  function getMediaContext() {
    if (mediaContext && mediaContext.state !== "closed") return mediaContext;
    mediaContext = new AC(); // native rate: no sampleRate option
    buildChain(mediaContext);
    mediaContext.addEventListener("statechange", () => {
      if (mediaContext.state === "running" && active) attachAll();
    });
    mediaContext.resume().catch(() => {});
    // Autoplay policy: if the context stays suspended, the next gesture on the page wakes it up.
    const wake = () => {
      if (mediaContext && mediaContext.state === "suspended") mediaContext.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
    return mediaContext;
  }

  function attach(el) {
    if (captured.has(el)) return;
    if (fallback.has(el) || needsFallback(el)) {
      applyFallback(el);
      return;
    }
    if (!enabled) return; // turned off for the site: elements not captured yet stay untouched
    const ctx = getMediaContext();
    // Never capture into a context that is not running: the element would go silent.
    if (ctx.state !== "running") return;
    try {
      const source = createMediaElementSource.call(ctx, el);
      ownNodes.add(source);
      nativeConnect.call(source, chains.get(ctx).input);
      captured.add(el);
    } catch (e) {
      // InvalidStateError: the page already routes this element through its own AudioContext,
      // whose output goes through the chain thanks to the connect() hook above.
      captured.add(el);
    }
  }

  function attachAll() {
    try {
      document.querySelectorAll("audio, video").forEach((el) => track(el));
    } catch (e) {
      // ignored
    }
    for (const ref of mediaList) {
      const el = ref.deref();
      if (!el) {
        mediaList.delete(ref);
        continue;
      }
      attach(el);
    }
  }

  // ---------- Settings sent by the isolated content script ----------

  document.addEventListener("tab-volume-clean:settings", (e) => {
    let s;
    try {
      s = JSON.parse(String(e.detail));
    } catch (err) {
      return;
    }
    if (!s || typeof s !== "object") return;
    const g = Number(s.gain);
    gain = Number.isFinite(g) ? Math.max(0, Math.min(MAX_GAIN, g)) : 1;
    normalize = s.normalize === true;
    mono = s.mono === true;
    enabled = s.enabled !== false;
    if (enabled && (gain !== 1 || normalize || mono)) active = true;
    if (!active) return;
    applyToChains();
    if (enabled) {
      routeRecordedLinks();
      attachAll();
    }
    for (const ref of mediaList) {
      const el = ref.deref();
      if (el && fallback.has(el)) applyFallback(el);
    }
  });

  // ---------- Level meter for the popup ----------
  // An analyser is added on the chain output only while the popup asks for levels, removed 3 s after.

  let meterTimer = null;
  let meterAsked = 0;

  function readMeter() {
    meterAsked = now();
    let peak = 0;
    let found = false;
    let normDb = null;
    for (const ref of chainList) {
      const chain = ref.deref();
      if (!chain || chain.ctx.state !== "running") continue;
      found = true;
      if (!chain.meter) {
        const node = createAnalyser.call(chain.ctx);
        node.fftSize = 4096;
        ownNodes.add(node);
        nativeConnect.call(chain.output, node);
        chain.meter = { node, buf: new Float32Array(4096) };
      }
      readTimeDomain.call(chain.meter.node, chain.meter.buf);
      let p = 0;
      for (const v of chain.meter.buf) p = Math.max(p, Math.abs(v));
      if (chain.norm && (normDb === null || p >= peak)) normDb = chain.norm.leveler.gainDb;
      peak = Math.max(peak, p);
    }
    if (found && meterTimer === null) {
      meterTimer = setTimer(() => {
        if (now() - meterAsked < 3000) return;
        for (const ref of chainList) {
          const chain = ref.deref();
          if (!chain || !chain.meter) continue;
          try {
            nativeDisconnect.call(chain.output, chain.meter.node);
          } catch (e) {
            // ignored
          }
          chain.meter = null;
        }
        clearTimer(meterTimer);
        meterTimer = null;
      }, 1000);
    }
    return { processing: found, peak, normDb };
  }

  document.addEventListener("tab-volume-clean:meter", () => {
    let r;
    try {
      r = readMeter();
    } catch (e) {
      r = { processing: false, peak: 0, normDb: null };
    }
    document.dispatchEvent(new CustomEvent("tab-volume-clean:meter-reply", { detail: JSON.stringify(r) }));
  });

  // Probe for the automated tests (test/page.html): returns the output nodes, nothing else.
  document.addEventListener("tab-volume-clean:probe", (e) => {
    if (!e.detail || typeof e.detail.receive !== "function") return;
    const outputs = [];
    for (const ref of chainList) {
      const c = ref.deref();
      if (c) {
        outputs.push({
          context: c.ctx,
          output: c.output,
          media: c.ctx === mediaContext,
          layout: c.layout,
          mono: c.input.channelCountMode === "explicit",
          normDb: c.norm ? c.norm.leveler.gainDb : null,
        });
      }
    }
    e.detail.receive({ gain, normalize, mono, enabled, active, outputs });
  });
})();
