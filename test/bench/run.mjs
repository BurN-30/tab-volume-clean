// Chain bench: node test/bench/run.mjs '{"name":{"shaper":true,"T":0.9}}'
// Without an argument (npm run bench): the plain linear gain against the chain the extension ships.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const cands = JSON.parse(process.argv[2] || '{"plain_gain":null,"shipped":{"shaper":true,"K":8,"T":0.9}}');
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe',
  headless: true,
  // Offline rendering only (OfflineAudioContext); real output muted anyway.
  extraPrefsFirefox: { 'media.cubeb.force_mock_context': true, 'media.volume_scale': '0.0' },
});
const page = await browser.newPage();
await page.goto(pathToFileURL(path.resolve(import.meta.dirname, 'bench.html')).href);
const res = await page.evaluate((c) => window.runBench(c), cands);
const names = Object.keys(res);
const keys = Object.keys(res[names[0]]);
console.log(['metric', ...names].join('\t'));
for (const k of keys) console.log([k, ...names.map((n) => res[n][k])].join('\t'));
await browser.close();
