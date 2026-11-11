// Answers pages (and their frames): which site am I, which settings apply?
// The URL comes from the tab (sender.tab.url), so an embedded frame follows the main site's settings.
// Also handles the keyboard shortcuts and the toolbar badge.
"use strict";

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "tab-volume-clean:hello") return undefined;
  const site = tvcSiteKey((sender.tab && sender.tab.url) || sender.url);
  if (!site) return Promise.resolve({ site: null });
  return tvcLoad(site, tvcPrivateTab(sender.tab)).then((settings) => ({ site, settings }));
});

// ---------- Keyboard shortcuts ----------

const STEP = 5; // slider positions per key press (5% of the slider travel, about 2 dB around 100%)

async function tvcCommand(command, tab) {
  if (!tab) [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === "toggle-mute") {
    await browser.tabs.update(tab.id, { muted: !(tab.mutedInfo && tab.mutedInfo.muted) });
    return;
  }
  const site = tvcSiteKey(tab.url);
  if (!site) return;
  const privateTab = tvcPrivateTab(tab);
  const s = await tvcLoad(site, privateTab);
  const pos = Math.round(tvcGainToPosition(s.gain));
  let g;
  if (command === "volume-up") g = tvcPositionToGain(pos + STEP);
  else if (command === "volume-down") g = tvcPositionToGain(pos - STEP);
  else return;
  await tvcSet(site, "gain", g, privateTab);
}

browser.commands.onCommand.addListener((command, tab) => {
  tvcCommand(command, tab);
});

// ---------- Badge: the volume of the tab's site when it is not 100% ----------

async function badge(tab) {
  const site = tab && tvcSiteKey(tab.url);
  let text = "";
  if (site) {
    const s = await tvcLoad(site, tvcPrivateTab(tab));
    if (!s.enabled) text = "off";
    else if (s.gain !== 1) text = tvcPercentText(s.gain).replace("%", "");
  }
  try {
    await browser.action.setBadgeText({ tabId: tab.id, text });
  } catch (e) {
    // tab closed meanwhile
  }
}

// Every tab, or only the tabs of the given sites.
async function badgeAll(sites) {
  for (const tab of await browser.tabs.query({})) {
    if (!sites || sites.has(tvcSiteKey(tab.url))) badge(tab);
  }
}

browser.action.setBadgeBackgroundColor({ color: "#2f6fde" });
if (browser.action.setBadgeTextColor) browser.action.setBadgeTextColor({ color: "#ffffff" });
browser.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url || info.status === "loading") badge(tab);
});
// A slider drag writes many times per second: only the tabs of the changed site are updated.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session") {
    // Settings of a private tab: "tab<id>|<key>".
    const ids = new Set(Object.keys(changes).map(tabOfKey));
    for (const id of ids) browser.tabs.get(id).then(badge, () => {});
    return;
  }
  if (area !== "local") return;
  const sites = new Set();
  for (const key of Object.keys(changes)) {
    for (const prefix of Object.values(TVC_PREFIXES)) {
      if (key.startsWith(prefix)) sites.add(key.slice(prefix.length));
    }
  }
  if (sites.size) badgeAll(sites);
});
browser.runtime.onStartup.addListener(() => badgeAll());
browser.runtime.onInstalled.addListener(() => badgeAll());

// ---------- Private tabs: their settings go away with them ----------

// "tab<id>|<key>" -> id
const tabOfKey = (key) => Number(key.slice(3, key.indexOf("|")));

// Removes the settings of the closed tab, and of any other tab that no longer exists
// (the background script may have been asleep when it closed).
async function forgetClosedTabs(closed) {
  const keys = Object.keys(await browser.storage.session.get(null));
  if (!keys.length) return;
  const open = new Set((await browser.tabs.query({})).map((tab) => tab.id));
  const gone = keys.filter((key) => tabOfKey(key) === closed || !open.has(tabOfKey(key)));
  if (gone.length) await browser.storage.session.remove(gone);
}

browser.tabs.onRemoved.addListener((id) => {
  forgetClosedTabs(id).catch(() => {});
});
forgetClosedTabs(null).catch(() => {});
