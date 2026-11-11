"use strict";

(async () => {
  const t = (id) => browser.i18n.getMessage(id);
  const $ = (id) => document.getElementById(id);
  const siteEl = $("site");
  const slider = $("slider");
  const valueEl = $("value");
  const dbEl = $("db");
  const reset = $("reset");
  const mute = $("mute");
  const enabledEl = $("enabled");
  const normalizeEl = $("normalize");
  const monoEl = $("mono");
  const fill = $("fill");
  const meterText = $("meterText");
  const note = $("note");

  document.documentElement.lang = browser.i18n.getUILanguage();
  slider.setAttribute("aria-label", t("sliderLabel"));
  reset.textContent = t("reset");
  $("enabledLabel").textContent = t("enabled");
  $("normalizeLabel").textContent = t("normalize");
  $("monoLabel").textContent = t("mono");
  normalizeEl.parentElement.title = t("normalizeHelp");
  monoEl.parentElement.title = t("monoHelp");
  enabledEl.parentElement.title = t("enabledHelp");

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const site = tab ? tvcSiteKey(tab.url) : null;
  // Private window: changes apply to this tab only and are not saved (see tvcPrivateTab in common.js).
  const privateTab = tvcPrivateTab(tab);

  // Mute is the browser's own tab mute: it silences everything the tab plays, nothing is stored.
  let muted = Boolean(tab && tab.mutedInfo && tab.mutedInfo.muted);
  function showMute() {
    mute.textContent = muted ? t("unmute") : t("mute");
    mute.setAttribute("aria-pressed", String(muted));
  }
  showMute();
  mute.addEventListener("click", async () => {
    if (!tab) return;
    muted = !muted;
    showMute();
    await browser.tabs.update(tab.id, { muted });
  });
  if (!tab) mute.disabled = true;

  if (!site) {
    siteEl.textContent = t("unsupported");
    for (const el of [slider, reset, enabledEl, normalizeEl, monoEl]) el.disabled = true;
    return;
  }

  siteEl.textContent = site === "file" ? t("localFiles") : site;
  siteEl.title = siteEl.textContent;

  const s = await tvcLoad(site, privateTab);
  let gain = s.gain;
  slider.value = String(Math.round(tvcGainToPosition(gain)));
  normalizeEl.checked = s.normalize;
  monoEl.checked = s.mono;
  enabledEl.checked = s.enabled;

  function show() {
    valueEl.textContent = tvcPercentText(gain);
    dbEl.textContent = tvcDb(gain);
    // The slider position is not a percentage (cubic curve): screen readers announce the real value.
    slider.setAttribute("aria-valuetext", valueEl.textContent + ", " + dbEl.textContent);
    const on = enabledEl.checked;
    for (const el of [slider, reset, normalizeEl, monoEl]) el.disabled = !on;
    document.body.classList.toggle("off", !on);
    note.textContent = !on ? t("offNote") : gain > 1 ? t("boostNote") : privateTab !== null ? t("privateNote") : "";
  }
  show();

  // While the user moves the slider, the popup is the only source of truth for the volume.
  // A drag fires dozens of input events per second and each one used to be written to storage at once:
  // the writes queued up, their storage.onChanged echoes came back late and out of step with the pointer,
  // and the listener below put the slider back on those old values (the value jumped back and forth).
  // Now there is at most one write in flight, the latest value waiting behind it, and the slider
  // never follows storage while it is held or while the popup's own writes are pending.
  let holding = false;
  let writing = false;
  let queued = null; // gain waiting for the write in flight
  let stale = false; // storage changed while the popup could not follow it

  async function flush() {
    writing = true;
    while (queued !== null) {
      const g = queued;
      queued = null;
      try {
        await tvcSet(site, "gain", g, privateTab);
      } catch (e) {
        // storage unavailable: the next move writes again
      }
    }
    writing = false;
    if (stale) follow();
  }
  function saveGain(g) {
    queued = g;
    if (!writing) flush();
  }

  slider.addEventListener("pointerdown", () => {
    holding = true;
  });
  const release = () => {
    if (!holding) return;
    holding = false;
    if (stale) follow();
  };
  slider.addEventListener("change", release);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);

  slider.addEventListener("input", () => {
    gain = tvcPositionToGain(Number(slider.value)); // small detent at 100%
    show();
    saveGain(gain);
  });
  reset.addEventListener("click", () => {
    gain = 1;
    slider.value = String(Math.round(tvcGainToPosition(1)));
    show();
    saveGain(1);
  });
  normalizeEl.addEventListener("change", () => tvcSet(site, "normalize", normalizeEl.checked, privateTab));
  monoEl.addEventListener("change", () => tvcSet(site, "mono", monoEl.checked, privateTab));
  enabledEl.addEventListener("change", () => {
    show();
    tvcSet(site, "enabled", enabledEl.checked, privateTab);
  });

  // The keyboard shortcuts can change the volume while the popup is open: follow storage, but only when
  // the user is not moving the slider and no write of the popup is pending. The value is read back from
  // storage (the latest one) rather than taken from the event, which may be an echo of an older write.
  let reads = 0;
  async function follow() {
    if (holding || writing) {
      stale = true;
      return;
    }
    stale = false;
    const read = ++reads;
    const s = await tvcLoad(site, privateTab);
    if (read !== reads) return; // a newer read is on its way
    if (holding || writing) {
      stale = true; // the user got there first: look again once they are done
      return;
    }
    if (s.gain === gain) return; // nothing new (echo of the popup's own last write)
    gain = s.gain;
    slider.value = String(Math.round(tvcGainToPosition(gain)));
    show();
  }
  browser.storage.onChanged.addListener((changes, area) => {
    const key = tvcStorageKey(site);
    if (area === "local" ? key in changes : area === "session" && privateTab !== null && tvcSessionPrefix(privateTab) + key in changes) follow();
  });

  // Peak meter: output level of the tab, read about 12 times per second, falls back smoothly.
  // Only shown while the extension processes the tab's audio (not at the defaults).
  let shown = -60;
  async function poll() {
    let r = null;
    try {
      r = await browser.tabs.sendMessage(tab.id, { type: "tab-volume-clean:meter" });
    } catch (e) {
      r = null;
    }
    if (!r) {
      fill.style.width = "0";
      meterText.textContent = enabledEl.checked ? t("meterIdle") : "";
      return;
    }
    const db = r.peak > 0 ? Math.max(-60, 20 * Math.log10(r.peak)) : -60;
    shown = db >= shown ? db : Math.max(db, shown - 1.5);
    fill.style.width = ((shown + 60) / 60) * 100 + "%";
    fill.classList.toggle("hot", shown > -1);
    let text = shown <= -60 ? "−∞ dBFS" : shown > -0.5 ? "0 dBFS" : "−" + Math.abs(shown).toFixed(0) + " dBFS";
    if (typeof r.normDb === "number") text += " · " + t("normalize") + " " + tvcDb(Math.pow(10, r.normDb / 20));
    meterText.textContent = text;
  }
  poll();
  setInterval(poll, 80);
})();
