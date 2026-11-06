// Storage keys, one set per site (host name without "www."):
//   site:<host>  volume as a gain (1 = 100%), absent at 100%
//   norm:<host>  true when Normalize is on
//   mono:<host>  true when Mono is on
//   off:<host>   true when the extension is turned off for the site
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

// Reads the settings of a site from storage.local, with the defaults for missing values.
async function tvcLoad(site) {
  const k = tvcKeys(site);
  const o = await browser.storage.local.get(Object.values(k));
  return {
    gain: typeof o[k.gain] === "number" ? o[k.gain] : 1,
    normalize: o[k.normalize] === true,
    mono: o[k.mono] === true,
    enabled: o[k.off] !== true,
  };
}

// Writes one setting; default values are removed instead of stored.
function tvcSave(site, name, value) {
  const k = tvcKeys(site);
  if (name === "gain") {
    return value === 1 ? browser.storage.local.remove(k.gain) : browser.storage.local.set({ [k.gain]: value });
  }
  if (name === "enabled") {
    return value ? browser.storage.local.remove(k.off) : browser.storage.local.set({ [k.off]: true });
  }
  return value ? browser.storage.local.set({ [k[name]]: true }) : browser.storage.local.remove(k[name]);
}

function tvcPercent(gain) {
  return Math.round(gain * 100);
}

// "+3.5 dB", "0.0 dB", "-inf dB" (the minus sign is U+2212).
function tvcDb(gain) {
  if (gain <= 0) return "−∞ dB";
  const db = 20 * Math.log10(gain);
  const r = Math.abs(db) < 0.05 ? 0 : db;
  return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toFixed(1) + " dB";
}
