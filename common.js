// Storage keys, one set per site (host name without "www."):
//   site:<host>  volume as a gain (1 = 100%), absent at 100%
//   norm:<host>  true when Normalize is on
//   mono:<host>  true when Mono is on
//   off:<host>   true when the extension is turned off for the site
// Private windows write nothing to storage.local (see tvcPrivateTab below).
// Shared by the background script, the content bridge, the popup and the options page.
"use strict";

const TVC_PREFIXES = { gain: "site:", normalize: "norm:", mono: "mono:", off: "off:" };

function tvcSiteKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file";
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch (e) {
    return null;
  }
}

function tvcStorageKey(site) {
  return TVC_PREFIXES.gain + site;
}

function tvcKeys(site) {
  const k = {};
  for (const [name, prefix] of Object.entries(TVC_PREFIXES)) k[name] = prefix + site;
  return k;
}

// ---------- Private windows ----------
// storage.local is written to disk and outlives a private session. A setting changed in a private tab therefore
// goes to storage.session instead (kept in memory only, cleared when the browser quits), under
// "tab<id>|<key>": it applies to that tab and that site, and is removed when the tab closes.
// A private tab starts from the settings saved for the site in normal windows; it never changes them.

// The tab id when the tab is private, else null (normal tab, settings in storage.local).
function tvcPrivateTab(tab) {
  return tab && tab.incognito ? tab.id : null;
}

function tvcSessionPrefix(tabId) {
  return "tab" + tabId + "|";
}

// Reads the settings of a site, with the defaults for missing values.
// privateTab: tvcPrivateTab(tab); the private tab's own changes then take precedence over storage.local.
async function tvcLoad(site, privateTab = null) {
  const k = tvcKeys(site);
  const o = await browser.storage.local.get(Object.values(k));
  if (privateTab !== null) {
    const p = tvcSessionPrefix(privateTab);
    const own = await browser.storage.session.get(Object.values(k).map((key) => p + key));
    for (const key of Object.values(k)) if (p + key in own) o[key] = own[p + key];
  }
  return {
    gain: typeof o[k.gain] === "number" ? o[k.gain] : 1,
    normalize: o[k.normalize] === true,
    mono: o[k.mono] === true,
    enabled: o[k.off] !== true,
  };
}

// Writes one setting; default values are removed instead of stored.
// In a private tab the value goes to storage.session, explicitly (it may differ from the saved one).
function tvcSave(site, name, value, privateTab = null) {
  const k = tvcKeys(site);
  if (privateTab !== null) {
    const key = tvcSessionPrefix(privateTab) + (name === "enabled" ? k.off : k[name]);
    return browser.storage.session.set({ [key]: name === "gain" ? value : name === "enabled" ? !value : value === true });
  }
  if (name === "gain") {
    return value === 1 ? browser.storage.local.remove(k.gain) : browser.storage.local.set({ [k.gain]: value });
  }
  if (name === "enabled") {
    return value ? browser.storage.local.remove(k.off) : browser.storage.local.set({ [k.off]: true });
  }
  return value ? browser.storage.local.set({ [k[name]]: true }) : browser.storage.local.remove(k[name]);
}

// Pages cannot read storage.session: after a change in a private tab, its frames get the new settings
// in a message. One message at a time, each read after the previous one is sent, so the last one wins.
let tvcSendQueue = Promise.resolve();
function tvcSendPrivate(site, privateTab) {
  tvcSendQueue = tvcSendQueue
    .then(() => tvcLoad(site, privateTab))
    .then((settings) => browser.tabs.sendMessage(privateTab, { type: "tab-volume-clean:settings", site, settings }))
    .catch(() => {}); // tab closed, or a page without the content scripts
  return tvcSendQueue;
}

// Saves a setting changed by the user (popup, shortcut), and hands it to a private tab's frames.
async function tvcSet(site, name, value, privateTab = null) {
  await tvcSave(site, name, value, privateTab);
  if (privateTab !== null) await tvcSendPrivate(site, privateTab);
}

function tvcPercent(gain) {
  return Math.round(gain * 100);
}

// "100%", "37%", "<1%" (between 0 and 0.5%: very quiet but not silent), "0%" (silence).
function tvcPercentText(gain) {
  return gain > 0 && gain < 0.005 ? "<1%" : tvcPercent(gain) + "%";
}

// Slider position (0 to TVC_POSITIONS) <-> linear gain (0 to TVC_MAX_GAIN), on a cubic curve:
// gain = 6 * (position / 100)^3, the curve PulseAudio uses for its volume sliders. The ear hears levels in dB,
// so with a linear slider most of the travel sounds alike and the volume only drops in the last few pixels.
// With the cubic curve each step changes the level by roughly the same amount, 0 is true silence
// and 100% sits a little past the middle (position 55).
const TVC_MAX_GAIN = 6;
const TVC_POSITIONS = 100;

function tvcGainToPosition(gain) {
  return TVC_POSITIONS * Math.cbrt(Math.max(0, Math.min(TVC_MAX_GAIN, gain)) / TVC_MAX_GAIN);
}

function tvcPositionToGain(position) {
  const p = Math.max(0, Math.min(TVC_POSITIONS, position));
  // Detent: the positions next to 100% land exactly on 100%.
  if (Math.abs(p - Math.round(tvcGainToPosition(1))) <= 1) return 1;
  return Math.round(TVC_MAX_GAIN * Math.pow(p / TVC_POSITIONS, 3) * 1e6) / 1e6;
}

// "+3.5 dB", "0.0 dB", "-inf dB" (the minus sign is U+2212).
function tvcDb(gain) {
  if (gain <= 0) return "−∞ dB";
  const db = 20 * Math.log10(gain);
  const r = Math.abs(db) < 0.05 ? 0 : db;
  return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toFixed(1) + " dB";
}
