// Compares a chain with a plain linear gain (offline rendering, silent).
// Usage: node test/bench/compare.mjs '{"shaper":true,"T":0.9}'
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const p = JSON.parse(process.argv[2] || '{"shaper":true,"T":0.9}');
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe', headless: true,
  extraPrefsFirefox: { 'media.cubeb.force_mock_context': true, 'media.volume_scale': '0.0' } });
const page = await browser.newPage();
await page.goto(pathToFileURL(path.resolve(import.meta.dirname, 'bench.html')).href);
console.table(await page.evaluate((p) => window.runCompare(p, [0.0316, 0.1, 0.25, 0.89], [1, 2, 4, 6]), p));
await browser.close();
