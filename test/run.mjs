// End-to-end test in a real headless Firefox, fully silent:
// installs the extension (temporary add-on), opens the test page, changes the settings the way the popup does,
// and measures what actually comes out of the audio chain: volume at 50, 100, 200, 400 and 600%,
// Normalize, Mono, turning the extension off for the site, the level meter, the shortcuts, the popup and options page.
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
const EXT_FILES = ['manifest.json', 'common.js', 'background.js', 'bridge.js', 'hook.js', 'popup.html', 'popup.css', 'popup.js', 'options.html', 'options.css', 'options.js'];

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
  if (['/popup.js', '/common.js', '/popup.css', '/options.js', '/options.css'].includes(file)) {
    res.writeHead(200, { 'content-type': types[path.extname(file)] + '; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, file)));
  }
  if (file === '/popup-test.html' || file === '/options-test.html') {
    // Real popup/options page with a simulated "browser" API (tab, storage, i18n).
    const initial = file === '/options-test.html' ? { 'site:example.org': 2, 'norm:example.org': true, 'off:other.net': true, 'mono:file': true, unrelated: 1 } : {};
    const stub = `<script>
window.__store = ${JSON.stringify(initial)};
window.__calls = [];
const __messages = ${JSON.stringify(messages)};
const __keys = (k) => (k === null ? Object.keys(__store) : Array.isArray(k) ? k : [k]);
window.browser = {
  i18n: { getMessage: (id) => (__messages[id] || {}).message || '', getUILanguage: () => 'en' },
  tabs: {
    query: async () => [{ id: 7, url: 'https://www.example.org/room', mutedInfo: { muted: false } }],
    update: async (id, props) => { __calls.push(['update', id, props]); },
    sendMessage: async () => ({ peak: 0.5, normDb: 6 }),
  },
  storage: {
    onChanged: { addListener: (f) => (window.__onChanged = f) },
    local: {
      get: async (k) => Object.fromEntries(__keys(k).filter((x) => x in __store).map((x) => [x, __store[x]])),
      set: async (o) => Object.assign(__store, o),
      remove: async (k) => { for (const x of __keys(k)) delete __store[x]; if (window.__onChanged) window.__onChanged({}, 'local'); },
    },
  },
};
</script>`;
    const src = file === '/popup-test.html' ? 'popup.html' : 'options.html';
    const html = fs.readFileSync(path.join(ROOT, src), 'utf8').replace('<script src="common.js">', stub + '<script src="common.js">');
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
  if (!msg) return undefined;
  if (msg.type === 'tab-volume-clean:test-meter') return browser.tabs.sendMessage(sender.tab.id, { type: 'tab-volume-clean:meter' });
  if (msg.type !== 'tab-volume-clean:test') return undefined;
  const op = msg.command ? tvcCommand(msg.command) : tvcSave(tvcSiteKey(sender.tab.url), msg.name, msg.value);
  return op
    .then(() => Promise.all([browser.storage.local.get(null), browser.tabs.get(sender.tab.id)]))
    .then(([store, tab]) => ({ store, muted: tab.mutedInfo.muted }));
});
`);
  fs.appendFileSync(path.join(copy, 'bridge.js'), `
document.addEventListener('tab-volume-clean:test', (e) => {
  browser.runtime.sendMessage({ type: 'tab-volume-clean:test', ...JSON.parse(e.detail) })
    .then((r) => document.dispatchEvent(new CustomEvent('tab-volume-clean:test-reply', { detail: JSON.stringify(r) })));
});
document.addEventListener('tab-volume-clean:test-meter', () => {
  browser.runtime.sendMessage({ type: 'tab-volume-clean:test-meter' })
    .then((r) => document.dispatchEvent(new CustomEvent('tab-volume-clean:test-meter-reply', { detail: JSON.stringify(r === undefined ? null : r) })));
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
    const r = await target.evaluate((v) => extSet(v), p);
    await wait(600);
    return r.store;
  };
  const setOption = async (name, value, ms = 600) => {
    const r = await page.evaluate((n, v) => extSet(n, v), name, value);
    await wait(ms);
    return r;
  };
  const level = (res, media, f) => res.chains.find((c) => c.media === media)[`dB${f}`];

  const results = {};
  for (const p of [0, 50, 100, 200, 400, 600]) {
    const stored = await setPercent(p);
    results[p] = await page.evaluate(() => measure());
    console.log(`\n--- ${p}% (stored: ${JSON.stringify(stored)})`);
    console.log(JSON.stringify(results[p]));
  }

  const media = (p) => results[p].chains.find((c) => c.media);
  const pageCh = (p) => results[p].chains.find((c) => !c.media);
  check(media(50) && pageCh(50), 'two chains: <audio>/<video> elements and page Web Audio');
  check(media(0).peak === 0 && pageCh(0).peak === 0, `0% is true silence: peaks ${media(0).peak} (elements), ${pageCh(0).peak} (page Web Audio)`);
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
  check(results[200].layout.every((l) => l === 'plain'), 'Normalize and Mono off: chain is volume -> soft clipper -> output, as in 1.1.1');

  // ---------- Normalize ----------
  await setPercent(100);
  await page.evaluate(() => startVoice(0.01)); // quiet voice, peaks at -40 dBFS
  await setOption('normalize', true, 4500);
  const quiet = await page.evaluate(() => voiceGain());
  check(quiet && quiet.layout === 'norm' && quiet.normDb >= 10, `Normalize boosts a quiet voice: ${quiet && quiet.normDb.toFixed(1)} dB (max +12)`);
  await page.evaluate(() => setVoice(0.7)); // loud voice, peaks at -3 dBFS
  await wait(3000);
  const loud = await page.evaluate(() => voiceGain());
  check(loud.normDb <= -5, `Normalize lowers a loud voice: ${loud.normDb.toFixed(1)} dB`);
  await page.evaluate(() => setVoice(0.0003)); // pause: only a faint hiss at -70 dBFS
  await wait(3000);
  const pause = await page.evaluate(() => voiceGain());
  check(pause.normDb <= loud.normDb + 0.01, `in a pause the gain does not climb: ${loud.normDb.toFixed(1)} -> ${pause.normDb.toFixed(1)} dB`);
  const withNorm = await page.evaluate(() => measure());
  check(withNorm.chains.every((c) => c.peak <= 1), 'Normalize on: peaks never above 1');
  await page.evaluate(() => extMeter()); // the first request adds the meter on the output
  await wait(300);
  const meter = await page.evaluate(() => extMeter());
  check(meter && meter.peak > 0 && meter.peak <= 1, `level meter answers the popup: peak ${meter && meter.peak.toFixed(3)}`);
  await setOption('normalize', false);
  await setPercent(200);
  const back = await page.evaluate(() => measure());
  const dBack = level(back, true, 440) - level(results[100], true, 440);
  check(back.layout.every((l) => l === 'plain') && Math.abs(dBack - 6.02) < 0.3, `Normalize off again: plain chain, 200% = ${dBack.toFixed(2)} dB`);

  // ---------- Mono ----------
  const stereo = await page.evaluate(() => rightLevel());
  await setOption('mono', true);
  const monoR = await page.evaluate(() => rightLevel());
  // The left-only 3000 Hz source: the mono mix (L + R) / 2 is heard on both sides, 6 dB below the left channel.
  const left = level(back, false, 3000) + 6.02; // the analyser itself reads (L + R) / 2
  check(stereo.dB < -80 && monoR.mono && Math.abs(monoR.dB - (left - 6.02)) < 0.5,
    `Mono: a left-only source reaches the right ear (${stereo.dB} -> ${monoR.dB} dB)`);
  await setOption('mono', false);
  const unmono = await page.evaluate(() => rightLevel());
  check(!unmono.mono && unmono.dB < -80, 'Mono off: right channel silent again');

  // ---------- Off for the site ----------
  await setOption('enabled', false);
  const off = await page.evaluate(() => measure());
  const dOff = level(off, true, 440) - level(results[100], true, 440);
  check(off.enabled === false && off.layout.every((l) => l === 'bypass') && Math.abs(dOff) < 0.3, `off for the site: plain pass-through (${dOff.toFixed(2)} dB with 200% stored)`);
  await setOption('enabled', true);
  const on = await page.evaluate(() => measure());
  const dOn = level(on, true, 440) - level(results[100], true, 440);
  check(Math.abs(dOn - 6.02) < 0.3, `on again: the stored 200% applies (${dOn.toFixed(2)} dB)`);

  // ---------- Keyboard shortcuts ----------
  // The shortcuts move 5 positions on the cubic slider: 200% is position 69, 74 is 243%, 64 is 157%.
  let r = await setOption('command', 'volume-up');
  check(Math.abs(r.store['site:127.0.0.1'] - 2.431344) < 1e-9, 'shortcut volume up: 200 -> 243% (one step on the slider curve)');
  await setOption('command', 'volume-down');
  r = await setOption('command', 'volume-down');
  check(Math.abs(r.store['site:127.0.0.1'] - 1.572864) < 1e-9, 'shortcut volume down twice: 243 -> 197 -> 157%');
  r = await setOption('command', 'toggle-mute');
  check(r.muted === true, 'shortcut mute: the tab is muted');
  r = await setOption('command', 'toggle-mute');
  check(r.muted === false, 'shortcut mute again: the tab is unmuted');
  await setPercent(100);

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
  check((await ui.$eval('#db', (e) => e.textContent)) === '0.0 dB', 'popup shows dB next to %: 100% = 0.0 dB');
  await ui.focus('#slider');
  check((await ui.$eval('#slider', (e) => e.value)) === '55', 'popup: 100% sits at position 55 of 100 (cubic curve)');
  for (let i = 0; i < 5; i++) await ui.keyboard.press('ArrowRight');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '130%', 'popup slider with keyboard: 100 -> 130% in 5 steps');
  check((await ui.evaluate(() => window.__store['site:example.org'])) === 1.296, 'popup stores 130% as gain 1.296');
  check((await ui.$eval('#db', (e) => e.textContent)) === '+2.3 dB', 'popup: 130% = +2.3 dB');
  check((await ui.$eval('#slider', (e) => e.getAttribute('aria-valuetext'))) === '130%, +2.3 dB', 'popup slider announces the real value to screen readers');
  for (let i = 0; i < 6; i++) await ui.keyboard.press('ArrowLeft');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '100%' && !('site:example.org' in (await ui.evaluate(() => window.__store))),
    'popup detent: one step below 100% still gives exactly 100% (nothing stored)');
  await ui.keyboard.press('ArrowLeft');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '89%', 'popup: first step past the detent = 89% (-1.0 dB)');
  await ui.keyboard.press('Home');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '0%' && (await ui.evaluate(() => window.__store['site:example.org'])) === 0,
    'popup minimum is 0%, stored as gain 0 (silence)');
  await ui.keyboard.press('ArrowRight');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '<1%', 'popup: first step above 0 shows <1%, not 0%');
  await ui.click('#normalize');
  await ui.click('#mono');
  await wait(100);
  const st = await ui.evaluate(() => window.__store);
  check(st['norm:example.org'] === true && st['mono:example.org'] === true, 'popup Normalize and Mono are stored per site');
  await ui.click('#normalize');
  await ui.click('#mono');
  await wait(100);
  const st2 = await ui.evaluate(() => window.__store);
  check(!('norm:example.org' in st2) && !('mono:example.org' in st2), 'popup: unchecked options are removed, not stored');
  await ui.click('#mute');
  await wait(100);
  const calls = await ui.evaluate(() => window.__calls);
  check(JSON.stringify(calls[0]) === JSON.stringify(['update', 7, { muted: true }]) && (await ui.$eval('#mute', (e) => e.textContent)) === 'Unmute tab',
    'popup Mute uses the browser tab mute');
  await ui.click('#mute');
  check(/dBFS/.test(await ui.$eval('#meterText', (e) => e.textContent)), 'popup level meter shows the peak in dBFS');
  await ui.focus('#slider');
  await ui.keyboard.press('End');
  await wait(200);
  check((await ui.$eval('#value', (e) => e.textContent)) === '600%', 'popup maximum is 600%');
  await ui.screenshot({ path: path.join(ROOT, 'test', 'popup-600.png'), clip: { x: 0, y: 0, width: 310, height: 250 } });
  await ui.click('#reset');
  await wait(200);
  check(!('site:example.org' in (await ui.evaluate(() => window.__store))), 'popup reset clears the stored value');
  await ui.click('#enabled');
  await wait(100);
  check((await ui.evaluate(() => window.__store['off:example.org'])) === true && (await ui.$eval('#slider', (e) => e.disabled)),
    'popup On unchecked: site turned off, controls disabled');

  const opt = await browser.newPage();
  await opt.goto(`http://127.0.0.1:${port}/options-test.html`);
  await wait(300);
  const rowsText = await opt.$$eval('#rows tr', (trs) => trs.map((tr) => tr.textContent));
  check(rowsText.length === 3 && rowsText.some((t) => t.includes('example.org') && t.includes('200%') && t.includes('Normalize')) && rowsText.some((t) => t.includes('other.net') && t.includes('Off')),
    `options page lists the sites with their settings (${rowsText.length} rows)`);
  await opt.click('#rows tr button');
  await wait(200);
  check((await opt.$$eval('#rows tr', (trs) => trs.length)) === 2 && (await opt.evaluate(() => window.__store.unrelated)) === 1, 'options: Forget removes one site only');
  await opt.click('#forgetAll');
  await wait(200);
  check(!(await opt.$eval('#empty', (e) => e.hidden)), 'options: Forget all sites empties the list');

} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll good');
process.exit(failures ? 1 : 0);
