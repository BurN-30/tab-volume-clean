# Tab Volume Clean

**Install from Firefox Add-ons (AMO): https://addons.mozilla.org/firefox/addon/tab-volume-clean/**

Set the volume of the current tab from 0 to 600% in Firefox-based browsers (Firefox, Zen, LibreWolf...), including WebRTC calls such as BigBlueButton or Jitsi, without the distortion many volume boosters add. Optional voice normalizer for video calls, mono, mute, level meter, keyboard shortcuts.

Commercial use not permitted (see [License](#license)).

## Why

In Chromium browsers, good volume boosters capture the whole tab with `chrome.tabCapture` and run it through a single linear `GainNode`. Firefox has no tab audio capture API (no `tabCapture`, `tabs.captureTab` only takes screenshots, and `getDisplayMedia` returns no audio), so Firefox boosters have to work inside the page. Many of them then add an aggressive limiter or compressor, which pumps and distorts voices and changes the timbre as soon as the volume moves, or hook so much of the page that WebRTC audio breaks.

Tab Volume Clean keeps the processing as close as possible to the plain linear gain:

- **Chain:** source, then a `GainNode` (linear, 0 to 6), then a memoryless soft clipper (`WaveShaperNode`), then the output. No compressor anywhere: moving the slider changes the level, never the timbre.
- **Soft clipper:** an exact identity up to -0.9 dBFS, so the result is bit-for-bit the same as a plain gain. Above that it bends smoothly toward full scale instead of hard clipping. No pumping, no level change on quiet passages, no added latency.
- **Native sample rate:** the `AudioContext` runs at the output device's rate, so no extra resampling.
- **Nothing is processed at the defaults** (100%, Normalize and Mono off): no `AudioContext` is created and no element is captured.

## Features

- **Popup:** slider from 0 to 600% with the value in % and in dB, reset button, peak level meter (dBFS), Normalize, Mono, Mute tab, and an On switch for the site.
- **Slider curve:** the ear hears levels in dB, so the slider follows a cubic curve (gain = 6 × position³, as in PulseAudio) instead of a straight line: each step changes the level by about the same amount, 100% sits a little past the middle with a small detent, and 0% is true silence. Only the slider is curved; the processing stays a plain linear gain.
- **Normalize** (off by default): evens out loud and quiet voices, tuned for video calls. See [Normalize](#normalize).
- **Mono:** mixes left and right, (L + R) / 2, into both ears. Useful when a call or a video only plays on one side.
- **Mute tab:** the browser's own tab mute, so it silences everything the tab plays, protected media included.
- **On / off per site:** turned off, the site's sound passes untouched (gain 1, no clipper, no normalizer); a reload releases it completely.
- **Keyboard shortcuts:** Alt+Shift+Up and Alt+Shift+Down move the volume 5 steps along the slider curve (about 2 dB around 100%), Alt+Shift+M mutes or unmutes the tab. Change them in `about:addons`, gear icon, **Manage Extension Shortcuts**. The toolbar badge shows the volume when it is not 100%, or `off`.
- **Per-site memory:** volume, Normalize, Mono and On/off are remembered per site (host name without `www.`). The options page lists the sites with their own settings and forgets them, one by one or all at once.
- **Handled sources:**
  - classic `<audio>`/`<video>` elements;
  - elements playing a `MediaStream` (`srcObject`, WebRTC);
  - audio a page makes itself with Web Audio.
- **Languages:** English and French.
- **Privacy:** no data collected, no network request.

## Normalize

A slow automatic gain for speech, placed after the volume `GainNode` and before the soft clipper. A side chain (100 Hz high-pass and +4 dB shelf above 1.5 kHz, then two `AnalyserNode`s) only measures; it never feeds the output. Every 50 ms:

- **Gate:** a 43 ms block counts as speech only above -50 dBFS and 10 dB above the noise floor (the quietest block of the last half second). Pauses, breaths and steady background noise never raise the gain.
- **Level:** 75th percentile of a sliding window of speech blocks (the last 20, none older than 2.5 s). It ignores the dips between syllables, so the gain does not follow them, and a new speaker replaces the previous one within about a second.
- **Gain:** -20 dB minus that level, from -12 to +12 dB. It rises slowly (time constant 0.5 s, at most 8 dB/s) and falls faster (0.15 s). Its boost never pushes the source's recent peaks above -1 dBFS; the existing soft clipper stays after it.
- **Long pauses:** after 1 s without speech, a boost relaxes toward 0 dB at 2 dB/s and a cut stays, so the gain never climbs during a silence.

Measured on a video-call scenario (`npm run bench:realtime`, through the real extension, silent): a loud and a quiet voice 19.4 dB apart come out 7.2 dB apart (the quiet one gets the full +12 dB), the gain moves by 0 to 2.3 dB on a steady voice, rises by at most 0.9 dB when a fan noise starts and never during pauses, no sample goes above -1 dBFS and nothing is delayed.

With Normalize off, the chain is exactly the one of 1.1.1 (volume, soft clipper, output), so the output is bit-for-bit unchanged.

## Limits

- **Boosting a loud source:** above 100%, a source that already peaks near full scale cannot get louder without being shaped. A plain gain hard-clips there, while this extension rounds the peaks off, which still sounds harsh when pushed hard. Lower the value until it is clean. For more clean loudness, raise the system or headset volume.
- **Normalize is made for speech.** It has no look-ahead (that would delay the call), so the first syllable of a loud voice right after a boosted quiet one can be rounded by the soft clipper for about 50 ms. Continuous music without pauses keeps the gain it reached.
- **Media the extension cannot capture:** DRM-protected media, cross-origin media served without CORS, and media sent by the page to a specific output device (`setSinkId`). For these only lowering works, through `element.volume`, because capturing them would mute them or move them to the default device; when the page sets its own volume again, it is lowered too, so 0% stays silent. Normalize, Mono and the level meter do not apply to them; Mute does.
- **Level meter:** shown only while the tab's sound is processed (not at the defaults, where nothing is touched).
- **Tabs already open at install time** need a reload.
- **Other volume extensions:** disable them. Two extensions capturing the same element get in each other's way.

## Install

**Firefox Add-ons:** install it from [its addons.mozilla.org page](https://addons.mozilla.org/firefox/addon/tab-volume-clean/) (updates are automatic).

**One click from GitHub:** open [the latest signed release](https://github.com/BurN-30/tab-volume-clean/releases/latest/download/tab-volume-clean.xpi) in Firefox, Zen or LibreWolf and confirm. The file is signed by Mozilla, so no `about:config` change is needed.

### Other ways

Get `tab-volume-clean-<version>.xpi` from the Releases page, or build it yourself (see [Development](#development)).

### Zen, LibreWolf, Firefox Developer Edition / Nightly / ESR (unsigned install)

These builds accept unsigned extensions once signature checking is turned off. Firefox release and beta do not.

1. Open `about:config` and accept the warning.
2. Search for `xpinstall.signatures.required` and set it to `false`. This lets the browser install any unsigned extension you load by hand. Extensions from addons.mozilla.org stay signed.
3. Open `about:addons`, click the gear icon, then **Install Add-on From File...** and pick the `.xpi`.
4. Pin the button from the extensions menu (puzzle icon).
5. Reload the tabs that were already open.

### Firefox release

Firefox release only installs signed extensions. Two options:

- **Signed copy:** sign your own copy as an unlisted add-on on addons.mozilla.org (free, automatic). After changing `browser_specific_settings.gecko.id` in `manifest.json`, run `web-ext sign --channel=unlisted` with your API keys.
- **Temporary install** (removed on restart): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on...** and pick `manifest.json`.

## Development

```
npm install
npm run lint             # web-ext lint
npm test                 # end-to-end test in headless Firefox, fully silent
npm run bench            # offline chain bench (OfflineAudioContext)
npm run bench:normalize  # offline Normalize bench on a video-call scenario
npm run bench:realtime   # the same scenario through the real extension, in real time, silent
npm run build            # dist/tab-volume-clean-<version>.xpi
```

The tests never play sound. Firefox is started with a mock audio backend (`media.cubeb.force_mock_context`) and `media.volume_scale` set to 0, and levels are measured on Web Audio nodes (analysers, an AudioWorklet recorder without output, offline rendering). Set `FIREFOX` to the Firefox executable if it is not in the default Windows location.

`test/run.mjs` checks that:

- nothing is captured at the defaults;
- 0% is true silence;
- the gain is exact at 50%, 200% and 400% (-6, +6 and +12 dB) on a classic `<audio>`, a WebRTC `<audio>` (local `RTCPeerConnection` loop) and a page oscillator, with the 1.1.1 chain;
- peaks never go above full scale when overdriven at 600%;
- Normalize boosts a quiet voice, lowers a loud one, does not climb in a pause, and the chain goes back to the 1.1.1 one when it is turned off;
- Mono sends a left-only source to the right ear, and stops when turned off;
- turning the site off gives a plain pass-through, turning it on again restores the stored volume;
- the level meter answers through the same path as the popup;
- the shortcuts move the volume along the slider curve and mute the tab;
- the per-site value is re-applied on reload;
- the popup (slider curve and detent, % and dB, value announced to screen readers, options, mute, On switch, locale strings) and the options page work;
- the real popup slider, dragged back and forth with the mouse while the tab plays: nothing else moves the slider while it is held, and once released the shown value, the stored value and the gain applied in the tab match; a change made elsewhere still moves the open popup;
- slider position to gain and back: no drift over the whole travel;
- at 0%, cross-origin media lowered through its volume stays silent when the page sets its volume again, an element started by `autoplay` inside a closed shadow root is captured, and a page node disconnected with `disconnect(0)` is not reconnected.

`test/bench/compare.mjs` compares the chain with a plain linear gain on a speech-like signal: the level difference is 0.00 dB wherever the plain gain does not clip.

`test/bench/normalize.mjs` and `test/bench/realtime.mjs` play a video-call scenario (a loud and a quiet voice 20 dB apart, alternating, pauses with -60 dBFS room noise, -45 dBFS fan noise without speech) and report the level difference between the voices, the gain spread on a steady voice (pumping), the gain change during pauses (noise rise), the distortion and the peaks. `realtime.mjs` can also measure another extension the same way: set `VC_XPI` to its `.xpi`.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). Personal, educational and other noncommercial use is allowed. Commercial use is not permitted.

---

Built with AI assistance.
