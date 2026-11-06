// Storage key: one value per site (host name without "www.").
// Shared by the background script, the content bridge and the popup.
"use strict";

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
  return "site:" + site;
}
