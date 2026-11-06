// Test-only content script (page world), injected before the audio hook of the extension under test.
// Every connection made to a real-time AudioContext output is mirrored into a per-context GainNode
// (window.__tapMix), which the bench page records with an AudioWorklet. The recorder has no output,
// and the browser runs with a mock audio device at volume 0: nothing is heard.
(() => {
  "use strict";
  const P = AudioNode.prototype;
  const connect = P.connect;
  const disconnect = P.disconnect;
  const mixes = new Map();
  const isDest = (n) =>
    n instanceof AudioDestinationNode && !(window.OfflineAudioContext && n.context instanceof OfflineAudioContext);

  function mix(ctx) {
    let m = mixes.get(ctx);
    if (!m) {
      m = ctx.createGain();
      mixes.set(ctx, m);
    }
    return m;
  }

  P.connect = function (target, output) {
    const res = connect.apply(this, arguments);
    if (isDest(target)) {
      try {
        connect.call(this, mix(target.context), output || 0, 0);
      } catch (e) {
        // ignored
      }
    }
    return res;
  };

  P.disconnect = function (target, output) {
    if (arguments.length && isDest(target)) {
      try {
        if (arguments.length > 1) disconnect.call(this, mix(target.context), output);
        else disconnect.call(this, mix(target.context));
      } catch (e) {
        // ignored
      }
    }
    return disconnect.apply(this, arguments);
  };

  window.__tapMix = (ctx) => mix(ctx);
  window.__tapConnect = (a, b) => connect.call(a, b);
})();
