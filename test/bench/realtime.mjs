// Real-time Normalize bench, fully silent: node test/bench/realtime.mjs
// Plays the video-call scenario (scenario.js) in headless Firefox with a mock audio device and volume 0,
// through the real extension, and records what the extension sends to the output (tap.js).
// Also measures the "Volume Control" extension the same way if its .xpi is given in VC_XPI
// (it is only unpacked into a temporary folder for the test, never shipped).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BENCH = import.meta.dirname;
const FIREFOX = process.env.FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe';
const VC_XPI = process.env.VC_XPI || '';
const EXT_FILES = ['manifest.json', 'common.js', 'background.js', 'bridge.js', 'hook.js', 'popup.html', 'popup.css', 'popup.js', 'options.html', 'options.css', 'options.js'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const f = req.url.split('?')[0].replace(/^\//, '') || 'rt.html';
  if (!['rt.html', 'scenario.js', 'rec.js'].includes(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(BENCH, f)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/rt.html`;

// Our extension, with the tap first and the site settings written at start-up.
function ours(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-rt-'));
  for (const f of EXT_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['icons', '_locales']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(BENCH, 'tap.js'), path.join(dir, 'tap.js'));
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.content_scripts[0].js.unshift('tap.js');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  fs.appendFileSync(path.join(dir, 'background.js'), `\nbrowser.storage.local.set(${JSON.stringify(settings)});\n`);
  return dir;
}

// Volume Control, unpacked, with the tap first and its Normalize turned on by default in the given mode.
function volumeControl(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-rt-'));
  // Windows' own tar (bsdtar) reads zip files.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'bsdtar';
  execFileSync(tar, ['-xf', VC_XPI, '-C', dir]);
  fs.rmSync(path.join(dir, 'META-INF'), { recursive: true, force: true });
  fs.copyFileSync(path.join(BENCH, 'tap.js'), path.join(dir, 'tap.js'));
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const main = m.content_scripts.find((c) => c.world === 'MAIN');
  main.js.unshift('tap.js');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  if (mode) {
    fs.appendFileSync(path.join(dir, 'background.js'), `\nsetTimeout(() => browser.storage.local.set({ normalizerDefaultEnabled: true, normalizerConfig: { mode: ${JSON.stringify(mode)}, targetDb: -16, maxBoostDb: 12, ceilingDb: -1, responseMs: 600 } }), 300);\n`);
  }
  return dir;
}

async function run(name, dir) {
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: FIREFOX,
    headless: true,
    extraPrefsFirefox: {
      // Silence guaranteed: mock audio device (no sound card opened) and global volume 0.
      'media.cubeb.force_mock_context': true,
      'media.volume_scale': '0.0',
      'media.autoplay.default': 0,
      'media.autoplay.block-webaudio': false,
    },
  });
  try {
    await browser.installExtension(dir);
    await wait(1500);
    const page = await browser.newPage();
    await page.goto(url);
    await wait(1500);
    const info = await page.evaluate(() => prepare());
    await page.evaluate(() => play());
    await wait(info.seconds * 1000);
    for (let i = 0; i < 600 && !(await page.evaluate(() => done())); i++) await wait(500);
    const r = await page.evaluate(() => collect());
    return { name, ...r };
  } finally {
    await browser.close();
  }
}

const runs = [
  ['Tab Volume Clean, defaults', ours({})],
  ['Tab Volume Clean, Normalize', ours({ 'norm:127.0.0.1': true })],
];
if (VC_XPI && fs.existsSync(VC_XPI)) {
  runs.push(['Volume Control 7.0, Normalize music', volumeControl('music')]);
  runs.push(['Volume Control 7.0, Normalize adaptive', volumeControl('adaptive')]);
} else {
  console.log('VC_XPI not set: Volume Control is not measured.');
}

// ONLY=text keeps the runs whose name contains it.
if (process.env.ONLY) runs.splice(0, runs.length, ...runs.filter(([n]) => n.includes(process.env.ONLY)));
const results = [];
try {
  for (const [name, dir] of runs) {
    console.log(`\n=== ${name}`);
    const r = await run(name, dir);
    console.table(r.segments);
    results.push(r);
  }
} finally {
  server.close();
}
const keys = Object.keys(results[0].summary);
const table = {};
for (const k of keys) table[k] = Object.fromEntries(results.map((r) => [r.name, r.summary[k]]));
console.log('\n=== Summary');
console.table(table);
