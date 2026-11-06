// End-to-end test in a real headless Firefox, fully silent:
// installs the extension (temporary add-on), opens the test page, sets the volume the way the popup does,
// and measures what actually comes out of the audio chain at 50, 100, 200, 400 and 600%.
//
// Usage: node test/run.mjs   (Firefox path from the FIREFOX variable, default C:/Program Files/Mozilla Firefox/firefox.exe)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIREFOX = process.env.FIREFOX || 'C:/Program Files/Mozilla Firefox/firefox.exe';
const EXT_ID = 'tab-volume-clean@burn-30';
const EXT_FILES = ['manifest.json', 'common.js', 'background.js', 'bridge.js', 'hook.js', 'popup.html', 'popup.css', 'popup.js'];

function toneWav(freq = 440, amp = 0.1, sec = 4, sr = 48000) {
  const n = sec * sr;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(32767 * amp * Math.sin((2 * Math.PI * freq * i) / sr)), 44 + i * 2);
  return buf;
}

const messages = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8'));
const wav = toneWav();
const server = http.createServer((req, res) => {
  const file = req.url.split('?')[0];
  if (file === '/tone.wav') {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
    return res.end(wav);
  }
  const types = { '.js': 'text/javascript', '.css': 'text/css' };
  if (['/popup.js', '/common.js', '/popup.css'].includes(file)) {
    res.writeHead(200, { 'content-type': types[path.extname(file)] + '; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, file)));
  }
  if (file === '/popup-test.html') {
    // Real popup.html/popup.js/common.js with a simulated "browser" API (tab, storage, i18n).
    const stub = `<script>
window.__store = {};
const __messages = ${JSON.stringify(messages)};
window.browser = {
  i18n: { getMessage: (id) => (__messages[id] || {}).message || '', getUILanguage: () => 'en' },
  tabs: { query: async () => [{ url: 'https://www.example.org/room' }] },
  storage: { local: {
    get: async (k) => (k in __store ? { [k]: __store[k] } : {}),
    set: async (o) => Object.assign(__store, o),
    remove: async (k) => { delete __store[k]; },
  } },
};
</script>`;
    const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8').replace('<script src="common.js">', stub + '<script src="common.js">');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(ROOT, 'test', 'page.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: FIREFOX,
  headless: true,
  extraPrefsFirefox: {
    // Silence guaranteed: no real audio device is opened (mock cubeb context) and the global volume is zero.
    // Levels are measured on Web Audio nodes (AnalyserNode), never on the sound card.
    'media.cubeb.force_mock_context': true,
    'media.volume_scale': '0.0',
    'media.autoplay.default': 0,
    'media.autoplay.block-webaudio': false,
    'media.peerconnection.ice.obfuscate_host_addresses': false,
    'media.peerconnection.ice.loopback': true,
  },
});

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? 'OK    ' : 'FAIL  ') + msg);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // Test copy of the extension: automation cannot open the popup (moz-extension://), so the copy gets a relay
  // that writes the value exactly like the popup does:
  // test page -> bridge.js -> background.js -> storage.local -> storage.onChanged -> bridge.js -> hook.js.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-volume-clean-test-'));
  for (const f of EXT_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(copy, f));
  for (const d of ['icons', '_locales']) fs.cpSync(path.join(ROOT, d), path.join(copy, d), { recursive: true });
  fs.appendFileSync(path.join(copy, 'background.js'), `
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'tab-volume-clean:test') return undefined;
  const key = tvcStorageKey(tvcSiteKey(sender.tab.url));
  const op = msg.percent === 100 ? browser.storage.local.remove(key) : browser.storage.local.set({ [key]: msg.percent / 100 });
  return op.then(() => browser.storage.local.get(null));
});
`);
  fs.appendFileSync(path.join(copy, 'bridge.js'), `
document.addEventListener('tab-volume-clean:test', (e) => {
  browser.runtime.sendMessage({ type: 'tab-volume-clean:test', percent: e.detail })
    .then((r) => document.dispatchEvent(new CustomEvent('tab-volume-clean:test-reply', { detail: JSON.stringify(r) })));
});
`);
  console.log('extension installed:', await browser.installExtension(copy));

  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto(`http://127.0.0.1:${port}/page.html`);
  console.log('sources:', await page.evaluate(() => startAll()));
  await wait(1000);

  const before = await page.evaluate(() => measure());
  check(before.chains && before.chains.length === 0 && before.active === false, 'at 100% by default nothing is captured (no chain)');

  const setPercent = async (p, target = page) => {
    const stored = await target.evaluate((v) => extSet(v), p);
    await wait(600);
    return stored;
  };

  const results = {};
  for (const p of [50, 100, 200, 400, 600]) {
    const stored = await setPercent(p);
    results[p] = await page.evaluate(() => measure());
    console.log(`\n--- ${p}% (stored: ${JSON.stringify(stored)})`);
    console.log(JSON.stringify(results[p]));
  }

  const media = (p) => results[p].chains.find((c) => c.media);
  const pageCh = (p) => results[p].chains.find((c) => !c.media);
  check(media(50) && pageCh(50), 'two chains: <audio>/<video> elements and page Web Audio');
  check(media(50).sampleRate === pageCh(50).sampleRate, `native rate: ${media(50).sampleRate} Hz, same as the page`);
  const d = (p, f, ch) => ch(p)[`dB${f}`] - ch(100)[`dB${f}`];
  const expect = { 50: -6.02, 200: 6.02, 400: 12.04 };
  for (const p of [50, 200, 400]) {
    // Sources peak at -14 dBFS combined (two 0.1 sines), so up to 400% they stay below the soft clipper's knee:
    // the chain must behave exactly like a plain linear gain.
    check(Math.abs(d(p, 440, media) - expect[p]) < 0.3, `classic <audio> ${p}%: ${d(p, 440, media).toFixed(2)} dB (expected ${expect[p]})`);
    check(Math.abs(d(p, 1000, media) - expect[p]) < 0.3, `WebRTC <audio> srcObject ${p}%: ${d(p, 1000, media).toFixed(2)} dB (expected ${expect[p]})`);
  }
  for (const p of [50, 200]) {
    check(Math.abs(d(p, 2000, pageCh) - expect[p]) < 0.3, `page Web Audio ${p}%: ${d(p, 2000, pageCh).toFixed(2)} dB (expected ${expect[p]})`);
  }
  check(media(600).peak <= 1 && pageCh(400).peak <= 1 && pageCh(600).peak <= 1,
    `overdriven (600% media, 400-600% page): peaks ${media(600).peak}, ${pageCh(400).peak}, ${pageCh(600).peak}, never above 1`);
  check(results[600].webrtcElement && !results[600].webrtcElement.paused, 'the WebRTC element keeps playing');

  // New visit: the remembered value applies by itself.
  await setPercent(150);
  const page2 = await browser.newPage();
  await page2.goto(`http://127.0.0.1:${port}/page.html?2`);
  await page2.evaluate(() => startAll());
  await wait(1500);
  const again = await page2.evaluate(() => measure());
  check(again.active === true && Math.abs(again.gain - 1.5) < 1e-9, `per-site value re-applied on load (gain ${again.gain})`);
  const stored = await setPercent(100, page2);
  check(Object.keys(stored).length === 0, 'back to 100%: nothing stored');

  const ui = await browser.newPage();
  await ui.goto(`http://127.0.0.1:${port}/popup-test.html`);
  await wait(300);
  check((await ui.$eval('#site', (e) => e.textContent)) === 'example.org', 'popup shows the site (www. removed)');
  check((await ui.$eval('#reset', (e) => e.textContent)) === 'Reset to 100%', 'popup text comes from _locales');
  await ui.focus('#slider');
  for (let i = 0; i < 20; i++) await ui.keyboard.press('ArrowRight');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '200%', 'popup slider with keyboard: 100 -> 200%');
  check((await ui.evaluate(() => window.__store['site:example.org'])) === 2, 'popup stores 200% as gain 2');
  await ui.keyboard.press('End');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '600%', 'popup maximum is 600%');
  await ui.screenshot({ path: path.join(ROOT, 'test', 'popup-600.png'), clip: { x: 0, y: 0, width: 290, height: 170 } });
  await ui.click('#reset');
  await wait(200);
  check(!('site:example.org' in (await ui.evaluate(() => window.__store))), 'popup reset clears the stored value');
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll good');
process.exit(failures ? 1 : 0);
