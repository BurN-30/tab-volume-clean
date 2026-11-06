// Offline Normalize bench: node test/bench/normalize.mjs [volume %]
// Uses the leveler code of hook.js itself. Offline rendering only (OfflineAudioContext), silent.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const hook = fs.readFileSync(path.join(ROOT, 'hook.js'), 'utf8');
const m = hook.match(/\/\/ ---- leveler:begin[^\n]*\n([\s\S]*?)\/\/ ---- leveler:end/);
if (!m) throw new Error('leveler markers not found in hook.js');
const gainPct = Number(process.argv[2] || 100);

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe',
  headless: true,
  extraPrefsFirefox: { 'media.cubeb.force_mock_context': true, 'media.volume_scale': '0.0' },
});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(import.meta.dirname, 'normalize.html')).href);
  const r = await page.evaluate((src, g) => window.runNormalize(src, g), m[1], gainPct);
  for (const k of ['off', 'on']) {
    console.log(`\n=== Normalize ${k} (volume ${gainPct}%)`);
    console.table(r[k].segments);
    console.table(r[k].summary);
  }
  console.log('\ngain trajectory (dB, every 0.5 s):', r.trajectory.join(' '));
} finally {
  await browser.close();
}
