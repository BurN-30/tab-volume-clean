// Audio engine, runs in the page world at document_start.
//
// Chain: source -> GainNode (0 to 6, linear) -> WaveShaperNode (soft clipper) -> output.
//
// The gain is a plain linear multiplier, like extensions built on Chrome's tabCapture
// (capture -> GainNode -> output). Firefox has no tab capture API, so the audio is taken
// from inside the page instead. The soft clipper is the only addition: it is an exact identity
// up to -0.9 dBFS (bit-for-bit the same as a plain gain), then bends smoothly toward 1.0, so
// samples that a plain gain would hard-clip at the sound card are rounded off instead.
// It has no memory: no pumping, no level change on quiet passages, no added latency.
//
// The AudioContext is created without a sampleRate, so it runs at the device's native rate.
//
// Nothing is touched while a site is at 100%: no AudioContext, no captured element.
// Once another value arrives, the extension captures:
//   - classic <audio>/<video> elements and those playing a MediaStream (srcObject, WebRTC:
//     BigBlueButton, Jitsi...), through createMediaElementSource, which follows the element
//     even when the page swaps its stream;
//   - audio the page makes itself with Web Audio: its connections to the output go through the chain.
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
  const createMediaElementSource = AC.prototype.createMediaElementSource;
  const getDestination = Object.getOwnPropertyDescriptor(BAC, "destination").get;
  const getContext = Object.getOwnPropertyDescriptor(P, "context").get;
  const OfflineAC = window.OfflineAudioContext;
  const DestinationNode = window.AudioDestinationNode;

  let gain = 1;
  let active = false;

  const ownNodes = new WeakSet();
  const chains = new WeakMap(); // AudioContext -> chain
  const chainList = new Set(); // WeakRef<chain>
  let mediaContext = null;

  // ---------- Processing chain ----------

  function buildChain(ctx) {
    let chain = chains.get(ctx);
    if (chain) return chain;
    const input = createGain.call(ctx);
    const shaper = createWaveShaper.call(ctx);
    shaper.curve = CURVE;
    shaper.oversample = "none"; // oversampling filters would colour the signal below the knee
    input.gain.value = gain / RANGE;
    nativeConnect.call(input, shaper);
    nativeConnect.call(shaper, getDestination.call(ctx));
    ownNodes.add(input);
    ownNodes.add(shaper);
    chain = { ctx, input, output: shaper };
    chains.set(ctx, chain);
    chainList.add(new WeakRef(chain));
    return chain;
  }

  function applyGainToChains() {
    for (const ref of chainList) {
      const chain = ref.deref();
      if (!chain || chain.ctx.state === "closed") {
        chainList.delete(ref);
        continue;
      }
      const param = chain.input.gain;
      const t = chain.ctx.currentTime;
      try {
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
        param.setTargetAtTime(gain / RANGE, t, 0.015); // smooth change, no click
      } catch (e) {
        param.value = gain / RANGE;
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
      el.volume = Math.max(0, Math.min(1, fallback.get(el) * Math.min(1, gain)));
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

  // ---------- Value sent by the isolated content script ----------

  document.addEventListener("tab-volume-clean:gain", (e) => {
    const g = Number(e.detail);
    if (!Number.isFinite(g)) return;
    gain = Math.max(0, Math.min(MAX_GAIN, g));
    if (gain !== 1) active = true;
    if (!active) return;
    applyGainToChains();
    routeRecordedLinks();
    attachAll();
    for (const ref of mediaList) {
      const el = ref.deref();
      if (el && fallback.has(el)) applyFallback(el);
    }
  });

  // Probe for the automated tests (test/page.html): returns the output nodes, nothing else.
  document.addEventListener("tab-volume-clean:probe", (e) => {
    if (!e.detail || typeof e.detail.receive !== "function") return;
    const outputs = [];
    for (const ref of chainList) {
      const c = ref.deref();
      if (c) outputs.push({ context: c.ctx, output: c.output, media: c.ctx === mediaContext });
    }
    e.detail.receive({ gain, active, outputs });
  });
})();
