"use strict";

(async () => {
  const t = (id) => browser.i18n.getMessage(id);
  const siteEl = document.getElementById("site");
  const slider = document.getElementById("slider");
  const valueEl = document.getElementById("value");
  const reset = document.getElementById("reset");
  const note = document.getElementById("note");

  document.documentElement.lang = browser.i18n.getUILanguage();
  slider.setAttribute("aria-label", t("sliderLabel"));
  reset.textContent = t("reset");

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const site = tab ? tvcSiteKey(tab.url) : null;

  if (!site) {
    siteEl.textContent = t("unsupported");
    slider.disabled = true;
    reset.disabled = true;
    return;
  }

  const key = tvcStorageKey(site);
  siteEl.textContent = site === "file" ? t("localFiles") : site;
  siteEl.title = siteEl.textContent;

  function show(percent) {
    valueEl.textContent = percent + "%";
    note.textContent = percent > 100 ? t("boostNote") : "";
  }

  const stored = (await browser.storage.local.get(key))[key];
  const start = typeof stored === "number" ? Math.round(stored * 100) : 100;
  slider.value = String(start);
  show(start);

  function save(percent) {
    show(percent);
    if (percent === 100) return browser.storage.local.remove(key);
    return browser.storage.local.set({ [key]: percent / 100 });
  }

  slider.addEventListener("input", () => {
    let p = Number(slider.value);
    if (Math.abs(p - 100) <= 5) p = 100; // small detent at 100%
    save(p);
  });

  reset.addEventListener("click", () => {
    slider.value = "100";
    save(100);
  });
})();
