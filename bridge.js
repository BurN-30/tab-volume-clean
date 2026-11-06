// Isolated world: reads the site's value and hands it to the audio engine (hook.js, page world)
// through a DOM event. No window.postMessage, so page scripts are not disturbed.
"use strict";

(() => {
  let key = null;

  function push(gain) {
    const g = typeof gain === "number" && Number.isFinite(gain) ? gain : 1;
    document.dispatchEvent(new CustomEvent("tab-volume-clean:gain", { detail: g }));
  }

  browser.runtime
    .sendMessage({ type: "tab-volume-clean:hello" })
    .then((r) => {
      if (!r || !r.site) return;
      key = tvcStorageKey(r.site);
      if (r.gain !== 1) push(r.gain);
    })
    .catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !key || !(key in changes)) return;
    push(changes[key].newValue);
  });
})();
