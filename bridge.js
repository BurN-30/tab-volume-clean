// Isolated world: reads the site's settings and hands them to the audio engine (hook.js, page world)
// through DOM events. No window.postMessage, so page scripts are not disturbed.
// Also relays the level meter to the popup.
"use strict";

(() => {
  let site = null;
  let settings = null;

  function push() {
    document.dispatchEvent(new CustomEvent("tab-volume-clean:settings", { detail: JSON.stringify(settings) }));
  }

  const isDefault = (s) => s.gain === 1 && !s.normalize && !s.mono && s.enabled;

  browser.runtime
    .sendMessage({ type: "tab-volume-clean:hello" })
    .then((r) => {
      if (!r || !r.site) return;
      site = r.site;
      settings = r.settings;
      if (!isDefault(settings)) push();
    })
    .catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !site) return;
    const k = tvcKeys(site);
    if (!Object.values(k).some((key) => key in changes)) return;
    tvcLoad(site).then((s) => {
      settings = s;
      push();
    });
  });

  // Level meter: only the frame that processes audio answers, the others stay silent.
  let reply = null;
  document.addEventListener("tab-volume-clean:meter-reply", (e) => {
    try {
      reply = JSON.parse(String(e.detail));
    } catch (err) {
      reply = null;
    }
  });
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "tab-volume-clean:meter") return undefined;
    reply = null;
    document.dispatchEvent(new CustomEvent("tab-volume-clean:meter")); // hook.js answers synchronously
    if (!reply || !reply.processing) return undefined;
    return Promise.resolve({ peak: reply.peak, normDb: reply.normDb });
  });
})();
