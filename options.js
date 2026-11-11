"use strict";

// Lists the sites that have their own settings, with a button to forget each one.
(() => {
  const t = (id) => browser.i18n.getMessage(id);
  const $ = (id) => document.getElementById(id);
  document.documentElement.lang = browser.i18n.getUILanguage();
  for (const id of ["title", "colSite", "colVolume", "colOptions"]) $(id).textContent = t(id === "title" ? "optionsTitle" : id);
  document.title = t("optionsTitle");
  $("intro").textContent = t("optionsIntro");
  $("empty").textContent = t("optionsEmpty");
  $("forgetAll").textContent = t("forgetAll");
  $("shortcuts").textContent = t("shortcutsNote");

  function sitesOf(all) {
    const sites = new Set();
    for (const key of Object.keys(all)) {
      for (const prefix of Object.values(TVC_PREFIXES)) {
        if (key.startsWith(prefix)) sites.add(key.slice(prefix.length));
      }
    }
    return [...sites].sort();
  }

  async function forget(sites) {
    await browser.storage.local.remove(sites.flatMap((s) => Object.values(tvcKeys(s))));
  }

  async function render() {
    const all = await browser.storage.local.get(null);
    const sites = sitesOf(all);
    const rows = $("rows");
    rows.replaceChildren();
    for (const site of sites) {
      const k = tvcKeys(site);
      const gain = typeof all[k.gain] === "number" ? all[k.gain] : 1;
      const opts = [];
      if (all[k.off] === true) opts.push(t("stateOff"));
      if (all[k.normalize] === true) opts.push(t("normalize"));
      if (all[k.mono] === true) opts.push(t("mono"));
      const tr = document.createElement("tr");
      const cells = [site === "file" ? t("localFiles") : site, tvcPercentText(gain) + " (" + tvcDb(gain) + ")", opts.join(", ")];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      const td = document.createElement("td");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t("forget");
      b.addEventListener("click", () => forget([site]));
      td.append(b);
      tr.append(td);
      rows.append(tr);
    }
    $("table").hidden = sites.length === 0;
    $("forgetAll").hidden = sites.length === 0;
    $("empty").hidden = sites.length !== 0;
  }

  $("forgetAll").addEventListener("click", async () => {
    await forget(sitesOf(await browser.storage.local.get(null)));
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") render();
  });
  render();
})();
