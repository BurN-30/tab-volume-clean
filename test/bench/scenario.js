// Video-call scenario and measurements for the Normalize bench (loaded by normalize.html and rt.html).
// Everything is computed on sample arrays: nothing is ever played.
"use strict";

const SCN_SR = 48000;

function scnRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Speech-like signal: syllables (vowel formants on a harmonic source, a few fricatives), short gaps between
// syllables, longer pauses between phrases. Peak normalised to peakDb.
function scnSpeech(sec, sr, peakDb, seed, f0) {
  const n = Math.round(sec * sr);
  const out = new Float32Array(n);
  const r = scnRng(seed);
  let t = 0.15 * r();
  let count = 0;
  let nextPause = 5 + Math.floor(r() * 5);
  let phase = 0;
  while (t < sec - 0.3) {
    const dur = 0.12 + 0.16 * r();
    const amp = Math.pow(10, (-6 * r()) / 20);
    const f1 = 300 + 500 * r();
    const f2 = 900 + 1300 * r();
    const fric = r() < 0.2;
    const pitch = f0 * (0.9 + 0.2 * r());
    const i0 = Math.round(t * sr);
    const len = Math.round(dur * sr);
    for (let i = 0; i < len && i0 + i < n; i++) {
      const u = i / len;
      const env = Math.pow(Math.sin(Math.PI * u), 0.7) * amp;
      let v = 0;
      if (fric) {
        v = (r() * 2 - 1) * 0.35;
      } else {
        const f = pitch * (1 + 0.04 * Math.sin(2 * Math.PI * 5 * (t + i / sr)));
        phase += (2 * Math.PI * f) / sr;
        for (let k = 1; k <= 30; k++) {
          const fk = f * k;
          if (fk > 7000) break;
          const w = Math.exp(-((fk - f1) ** 2) / 3e4) + 0.7 * Math.exp(-((fk - f2) ** 2) / 8e4) + 0.04;
          v += (w * Math.sin(k * phase + k)) / Math.sqrt(k);
        }
      }
      out[i0 + i] += v * env;
    }
    t += dur + 0.04 + 0.08 * r();
    if (++count >= nextPause) {
      t += 0.3 + 0.3 * r();
      count = 0;
      nextPause = 5 + Math.floor(r() * 5);
    }
  }
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  const k = Math.pow(10, peakDb / 20) / max;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

// Background noise (one-pole low-passed white noise, like a fan or a room), at a given RMS.
function scnNoise(sec, sr, rmsDb, seed) {
  const n = Math.round(sec * sr);
  const out = new Float32Array(n);
  const r = scnRng(seed);
  let y = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    y += 0.25 * (r() * 2 - 1 - y);
    out[i] = y;
    sum += y * y;
  }
  const k = Math.pow(10, rmsDb / 20) / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

// Loud speaker A (peaks -3 dBFS) and quiet speaker B (peaks -27 dBFS, 24 dB lower) alternate,
// with pauses, over a -60 dBFS room noise; louder noise (-45 dBFS, a fan) without speech after each of them.
function scnBuild(sr = SCN_SR) {
  const plan = [
    { name: "lead-in noise", kind: "silence", sec: 2 },
    { name: "A loud", kind: "speech", sec: 6, peak: -3, seed: 11, f0: 120 },
    { name: "pause 1", kind: "silence", sec: 3 },
    { name: "B quiet", kind: "speech", sec: 6, peak: -27, seed: 22, f0: 210 },
    { name: "pause 2 (after B)", kind: "silence", sec: 5 },
    { name: "A loud 2", kind: "speech", sec: 4, peak: -3, seed: 33, f0: 120 },
    { name: "B quiet 2", kind: "speech", sec: 4, peak: -27, seed: 44, f0: 210 },
    { name: "fan noise -45", kind: "silence", sec: 5, noise: -45 },
    { name: "A loud 3", kind: "speech", sec: 3, peak: -3, seed: 55, f0: 120 },
    { name: "fan noise after A", kind: "silence", sec: 4, noise: -45 },
  ];
  const total = plan.reduce((s, p) => s + p.sec, 0);
  const n = Math.round(total * sr);
  const x = new Float32Array(n);
  const speechOnly = new Float32Array(n);
  const room = scnNoise(total, sr, -60, 7);
  for (let i = 0; i < n; i++) x[i] = room[i];
  const segments = [];
  let start = 0;
  for (const p of plan) {
    const i0 = Math.round(start * sr);
    const len = Math.round(p.sec * sr);
    if (p.kind === "speech") {
      const s = scnSpeech(p.sec, sr, p.peak, p.seed, p.f0);
      for (let i = 0; i < len && i0 + i < n; i++) {
        x[i0 + i] += s[i];
        speechOnly[i0 + i] = s[i];
      }
    }
    if (p.noise) {
      const f = scnNoise(p.sec, sr, p.noise, 99);
      for (let i = 0; i < len && i0 + i < n; i++) x[i0 + i] += f[i];
    }
    segments.push({ ...p, start: i0, end: Math.min(n, i0 + len) });
    start += p.sec;
  }
  return { x, speechOnly, segments, sr };
}

const scnDb = (p) => 10 * Math.log10(p + 1e-20);
const scnR = (v, d = 1) => (Number.isFinite(v) ? +v.toFixed(d) : v);

// Finds the delay of y against x (-maxLag to +maxLag samples) on a loud stretch.
function scnLag(x, y, from, maxLag = 2400) {
  let best = -Infinity;
  let lag = 0;
  for (let L = -maxLag; L <= maxLag; L++) {
    let c = 0;
    for (let i = from; i < from + 24000; i += 2) c += x[i] * (y[i + L] || 0);
    if (c > best) {
      best = c;
      lag = L;
    }
  }
  return lag;
}

// Measurements of an output y against the scenario input (y already aligned on x).
// Blocks of 50 ms. Gain of a block = output power / input power.
function scnAnalyse(scn, y) {
  const { x, speechOnly, segments, sr } = scn;
  const B = Math.round(sr * 0.05);
  const blockPow = (a, s) => {
    let p = 0;
    for (let i = s; i < s + B; i++) p += a[i] * a[i];
    return p / B;
  };
  const res = { segments: [] };
  let sdrSig = 0;
  let sdrErr = 0;
  let over = 0;
  let peak = 0;
  for (const seg of segments) {
    const r = { name: seg.name };
    const blocks = [];
    for (let s = seg.start; s + B <= seg.end; s += B) {
      blocks.push({ s, t: (s - seg.start) / sr, px: blockPow(x, s), py: blockPow(y, s), sp: blockPow(speechOnly, s) });
    }
    if (seg.kind === "speech") {
      // Speech blocks: the speech is at least 10 dB above the noise in the block.
      const room = Math.pow(10, -60 / 10);
      const act = blocks.filter((b) => b.sp > 10 * room);
      const settled = act.filter((b) => b.t >= seg.sec - 2); // last 2 s of the segment
      const mean = (arr, f) => arr.reduce((s, b) => s + f(b), 0) / Math.max(1, arr.length);
      r.in_speech_dB = scnR(scnDb(mean(act, (b) => b.px)));
      r.out_speech_dB = scnR(scnDb(mean(act, (b) => b.py)));
      r.out_speech_settled_dB = scnR(scnDb(mean(settled, (b) => b.py)));
      const g = settled.map((b) => scnDb(b.py) - scnDb(b.px)).sort((a, b) => a - b);
      const q = (p) => g[Math.min(g.length - 1, Math.floor(p * g.length))];
      r.gain_settled_dB = scnR(q(0.5));
      r.gain_spread_p5_p95_dB = scnR(q(0.95) - q(0.05)); // pumping on the voice
      // Noise between words (blocks without speech): its level should not breathe.
      const gaps = blocks.filter((b) => b.sp < room * 0.1 && b.t >= seg.sec - 2).map((b) => scnDb(b.py) - scnDb(b.px)).sort((a, b) => a - b);
      r.gap_noise_gain_spread_dB = gaps.length > 4 ? scnR(gaps[Math.floor(0.95 * gaps.length) - 1] - gaps[Math.floor(0.05 * gaps.length)]) : null;
      // Distortion: per 10 ms, best scale of x, residual = what is not a gain change.
      const D = Math.round(sr * 0.01);
      let sig = 0;
      let err = 0;
      for (let s = seg.start; s + D <= seg.end; s += D) {
        let xy = 0;
        let xx = 0;
        for (let i = s; i < s + D; i++) {
          xy += x[i] * y[i];
          xx += x[i] * x[i];
        }
        const k = xx > 0 ? xy / xx : 0;
        for (let i = s; i < s + D; i++) {
          sig += (k * x[i]) ** 2;
          err += (y[i] - k * x[i]) ** 2;
        }
      }
      sdrSig += sig;
      sdrErr += err;
      r.sdr_dB = scnR(scnDb(sig) - scnDb(err));
    } else {
      const head = blocks.filter((b) => b.t < 0.5);
      const tail = blocks.filter((b) => b.t >= seg.end / sr - seg.start / sr - 0.5);
      const lvl = (arr) => scnDb(arr.reduce((s, b) => s + b.py, 0) / Math.max(1, arr.length));
      const lin = (arr) => scnDb(arr.reduce((s, b) => s + b.px, 0) / Math.max(1, arr.length));
      r.in_noise_dB = scnR(lin(blocks));
      r.out_noise_start_dB = scnR(lvl(head));
      r.out_noise_end_dB = scnR(lvl(tail));
      r.gain_start_dB = scnR(lvl(head) - lin(head));
      r.gain_end_dB = scnR(lvl(tail) - lin(tail));
      r.noise_rise_dB = scnR(r.gain_end_dB - r.gain_start_dB); // gain climbing during the pause
    }
    for (let i = seg.start; i < seg.end; i++) {
      const a = Math.abs(y[i]);
      if (a > peak) peak = a;
      if (a > 0.891) over++; // above -1 dBFS
    }
    res.segments.push(r);
  }
  const sp = (n) => res.segments.find((s) => s.name === n);
  res.summary = {
    in_A_minus_B_dB: scnR(sp("A loud").in_speech_dB - sp("B quiet").in_speech_dB),
    out_A_minus_B_dB: scnR(sp("A loud").out_speech_settled_dB - sp("B quiet").out_speech_settled_dB),
    out_A2_minus_B2_dB: scnR(sp("A loud 2").out_speech_dB - sp("B quiet 2").out_speech_dB),
    worst_voice_gain_spread_dB: Math.max(...res.segments.filter((s) => s.gain_spread_p5_p95_dB != null).map((s) => s.gain_spread_p5_p95_dB)),
    worst_noise_rise_in_pause_dB: Math.max(...res.segments.filter((s) => s.noise_rise_dB != null).map((s) => s.noise_rise_dB)),
    sdr_speech_dB: scnR(scnDb(sdrSig) - scnDb(sdrErr)),
    peak_dBFS: scnR(20 * Math.log10(peak + 1e-20), 2),
    samples_above_minus1dBFS: over,
  };
  return res;
}
