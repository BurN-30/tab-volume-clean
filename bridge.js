// Isolated world: reads the site's settings and hands them to the audio engine (hook.js, page world)
// through DOM events. No window.postMessage, so page scripts are not disturbed.
// Also relays the level meter to the popup.
"use strict";

(() => {
  let site = null;
  let settings = null;
  // In a private window the tab's own settings are in storage.session, which pages cannot read:
  // they come from the background script (hello) and, after each change, from a settings message.
  const isPrivate = browser.extension.inIncognitoContext;
  // Settings requests are numbered: an answer older than the settings already applied is dropped.
  let asked = 0;
  let applied = 0;

  function apply(n, s) {
    if (n < applied) return;
    applied = n;
    settings = s;
    push();
  }

  function push() {
    document.dispatchEvent(new CustomEvent("tab-volume-clean:settings", { detail: JSON.stringify(settings) }));
  }

  const isDefault = (s) => s.gain === 1 && !s.normalize && !s.mono && s.enabled;

  function hello() {
    const n = ++asked;
    return browser.runtime
      .sendMessage({ type: "tab-volume-clean:hello" })
      .then((r) => {
        if (!r || !r.site) return;
        if (site === null) {
          site = r.site;
          if (isDefault(r.settings)) {
            applied = n;
            settings = r.settings; // nothing to process at the defaults
            return;
          }
        }
        apply(n, r.settings);
      })
      .catch(() => {});
  }
  hello();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !site) return;
    const k = tvcKeys(site);
    if (!Object.values(k).some((key) => key in changes)) return;
    if (isPrivate) {
      hello(); // the tab's own settings may override the saved ones
      return;
    }
    const n = ++asked;
    tvcLoad(site).then((s) => apply(n, s));
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
    if (msg && msg.type === "tab-volume-clean:settings") {
      // Private tab: settings changed in the popup or with a shortcut.
      if (site && msg.site === site) apply(++asked, msg.settings);
      return undefined;
    }
    if (!msg || msg.type !== "tab-volume-clean:meter") return undefined;
    reply = null;
    document.dispatchEvent(new CustomEvent("tab-volume-clean:meter")); // hook.js answers synchronously
    if (!reply || !reply.processing) return undefined;
    return Promise.resolve({ peak: reply.peak, normDb: reply.normDb });
  });
})();
