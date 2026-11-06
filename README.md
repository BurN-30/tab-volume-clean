# Tab Volume Clean

Set the volume of the current tab from 0 to 600% in Firefox-based browsers (Firefox, Zen, LibreWolf...), including WebRTC calls such as BigBlueButton or Jitsi, without the distortion many volume boosters add.

Commercial use not permitted (see [License](#license)).

## Why

In Chromium browsers, good volume boosters capture the whole tab with `chrome.tabCapture` and run it through a single linear `GainNode`. Firefox has no tab audio capture API (no `tabCapture`, `tabs.captureTab` only takes screenshots, and `getDisplayMedia` returns no audio), so Firefox boosters have to work inside the page. Many of them then add an aggressive limiter or compressor, which pumps and distorts voices, or hook so much of the page that WebRTC audio breaks.

Tab Volume Clean keeps the processing as close as possible to the plain linear gain:

- **Chain:** source, then a `GainNode` (linear, 0 to 6), then a memoryless soft clipper (`WaveShaperNode`), then the output.
- **Soft clipper:** an exact identity up to -0.9 dBFS, so the result is bit-for-bit the same as a plain gain. Above that it bends smoothly toward full scale instead of hard clipping. No pumping, no level change on quiet passages, no added latency.
- **Native sample rate:** the `AudioContext` runs at the output device's rate, so no extra resampling.
- **Nothing is processed at 100%** (the default): no `AudioContext` is created and no element is captured.

## Features

- **Popup:** slider from 0 to 600% (step 5, small detent at 100%), and a reset button.
- **Per-site memory:** the value is remembered per site (host name without `www.`).
- **Handled sources:**
  - classic `<audio>`/`<video>` elements;
  - elements playing a `MediaStream` (`srcObject`, WebRTC);
  - audio a page makes itself with Web Audio.
- **Languages:** English and French.
- **Privacy:** no data collected, no network request.

## Limits

- **Boosting a loud source:** above 100%, a source that already peaks near full scale cannot get louder without being shaped. A plain gain hard-clips there, while this extension rounds the peaks off, which still sounds harsh when pushed hard. Lower the value until it is clean. For more clean loudness, raise the system or headset volume.
- **Media the extension cannot capture:** DRM-protected media, cross-origin media served without CORS, and media sent by the page to a specific output device (`setSinkId`). For these only lowering works, through `element.volume`, because capturing them would mute them or move them to the default device.
- **Tabs already open at install time** need a reload.
- **Other volume extensions:** disable them. Two extensions capturing the same element get in each other's way.

## Install

**One click:** open [the latest signed release](https://github.com/BurN-30/tab-volume-clean/releases/latest/download/tab-volume-clean.xpi) in Firefox, Zen or LibreWolf and confirm. The file is signed by Mozilla, so no `about:config` change is needed. A listing on addons.mozilla.org is pending review.

### Other ways

The extension is not on addons.mozilla.org. Get `tab-volume-clean-<version>.xpi` from the Releases page, or build it yourself (see [Development](#development)).

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
npm run lint    # web-ext lint
npm test        # end-to-end test in headless Firefox, fully silent
npm run bench   # offline chain bench (OfflineAudioContext)
npm run build   # dist/tab-volume-clean-<version>.xpi
```

The tests never play sound. Firefox is started with a mock audio backend (`media.cubeb.force_mock_context`) and `media.volume_scale` set to 0, and levels are measured on Web Audio nodes. Set `FIREFOX` to the Firefox executable if it is not in the default Windows location.

`test/run.mjs` checks that:

- nothing is captured at 100%;
- the gain is exact at 50%, 200% and 400% (-6, +6 and +12 dB) on a classic `<audio>`, a WebRTC `<audio>` (local `RTCPeerConnection` loop) and a page oscillator;
- peaks never go above full scale when overdriven at 600%;
- the per-site value is re-applied on reload;
- the popup works (slider, storage, reset, locale strings).

`test/bench/compare.mjs` compares the chain with a plain linear gain on a speech-like signal: the level difference is 0.00 dB wherever the plain gain does not clip.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). Personal, educational and other noncommercial use is allowed. Commercial use is not permitted.

---

Built with AI assistance; tested automatically, report issues.
