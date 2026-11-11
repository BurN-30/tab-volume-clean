// Answers pages (and their frames): which site am I, which settings apply?
// The URL comes from the tab (sender.tab.url), so an embedded frame follows the main site's settings.
// Also handles the keyboard shortcuts and the toolbar badge.
"use strict";

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "tab-volume-clean:hello") return undefined;
  const site = tvcSiteKey((sender.tab && sender.tab.url) || sender.url);
  if (!site) return Promise.resolve({ site: null });
  return tvcLoad(site).then((settings) => ({ site, settings }));
});

// ---------- Keyboard shortcuts ----------

const STEP = 5; // slider positions per key press (5% of the slider travel, about 2 dB around 100%)

async function tvcCommand(command) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "toggle-mute") {
    await browser.tabs.update(tab.id, { muted: !(tab.mutedInfo && tab.mutedInfo.muted) });
    return;
  }
  const site = tvcSiteKey(tab.url);
  if (!site) return;
  const s = await tvcLoad(site);
  const pos = Math.round(tvcGainToPosition(s.gain));
  let g;
  if (command === "volume-up") g = tvcPositionToGain(pos + STEP);
  else if (command === "volume-down") g = tvcPositionToGain(pos - STEP);
  else return;
  await tvcSave(site, "gain", g);
}

browser.commands.onCommand.addListener((command) => {
  tvcCommand(command);
});

// ---------- Badge: the volume of the tab's site when it is not 100% ----------

async function badge(tab) {
  const site = tab && tvcSiteKey(tab.url);
  let text = "";
  if (site) {
    const s = await tvcLoad(site);
    if (!s.enabled) text = "off";
    else if (s.gain !== 1) text = tvcPercentText(s.gain).replace("%", "");
  }
  try {
    await browser.action.setBadgeText({ tabId: tab.id, text });
  } catch (e) {
    // tab closed meanwhile
  }
}

async function badgeAll() {
  for (const tab of await browser.tabs.query({})) badge(tab);
}

browser.action.setBadgeBackgroundColor({ color: "#2f6fde" });
if (browser.action.setBadgeTextColor) browser.action.setBadgeTextColor({ color: "#ffffff" });
browser.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url || info.status === "loading") badge(tab);
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local") badgeAll();
});
browser.runtime.onStartup.addListener(badgeAll);
browser.runtime.onInstalled.addListener(badgeAll);
