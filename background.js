// Answers pages (and their frames): which site am I, which volume applies?
// The URL comes from the tab (sender.tab.url), so an embedded frame follows the main site's value.
"use strict";

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "tab-volume-clean:hello") return undefined;
  const site = tvcSiteKey((sender.tab && sender.tab.url) || sender.url);
  if (!site) return Promise.resolve({ site: null, gain: 1 });
  const key = tvcStorageKey(site);
  return browser.storage.local.get(key).then((o) => ({
    site,
    gain: typeof o[key] === "number" ? o[key] : 1,
  }));
});
