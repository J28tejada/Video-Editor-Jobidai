/**
 * Built-in sound effects, synthesized on device into small WAV files.
 *
 * Same recipes as the web editor (src/core/audio/sfx.ts), rendered directly
 * as PCM instead of through Web Audio nodes: oscillators with exponential
 * pitch sweeps, filtered noise and exponential gain envelopes. Each effect is
 * generated once and cached in the documents directory.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { SYNTH_SFX, type SynthName } from '@audio/sfxList';

export { SYNTH_SFX };

const SAMPLE_RATE = 44100;

const sfxDir = () => new Directory(Paths.document, 'sfx');

/** URI of the WAV for a built-in effect, generating it on first use. */
export function synthUri(name: string): string | null {
  if (!SYNTH_SFX.some((s) => s.name === name)) return null;
  const dir = sfxDir();
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, `${name}.wav`);
  if (!file.exists) {
    file.create();
    file.write(encodeWav(render(name as SynthName), SAMPLE_RATE));
  }
  return file.uri;
}

// ---- Synthesis ----

/** Exponential ramp between two positive values over [0, 1]. */
const expRamp = (from: number, to: number, x: number) =>
  from * Math.pow(to / from, Math.min(1, Math.max(0, x)));

const FLOOR = 0.0001;

function render(name: SynthName): Float32Array {
  switch (name) {
    case 'whoosh':
    case 'swoosh': {
      const dur = 0.45;
      const up = name === 'whoosh';
      return filteredNoise(dur, 'bandpass', 1.2, (x) => expRamp(up ? 400 : 4000, up ? 4000 : 400, x), (x) =>
        x < 0.4 ? expRamp(FLOOR, 1, x / 0.4) : expRamp(1, FLOOR, (x - 0.4) / 0.6),
      );
    }
    case 'pop':
      return sweep(0.14, (x) => expRamp(220, 90, x), (x) => expRamp(1, FLOOR, x));
    case 'ding': {
      const a = sweep(0.6, () => 880, (x) => expRamp(1, FLOOR, x));
      const b = sweep(0.6, () => 1760, (x) => expRamp(0.4, FLOOR, x));
      return normalize(a.map((v, i) => v + b[i]));
    }
    case 'click':
      return filteredNoise(0.06, 'highpass', 0.707, () => 2000, (x) => expRamp(1, FLOOR, x));
    case 'riser':
      return filteredNoise(1.0, 'bandpass', 2, (x) => expRamp(200, 6000, x), (x) => expRamp(FLOOR, 1, x));
    case 'boom':
      return sweep(0.7, (x) => expRamp(120, 40, x), (x) => expRamp(1, FLOOR, x));
  }
}

/** Sine oscillator with a frequency and gain curve over normalized time. */
function sweep(dur: number, freq: (x: number) => number, gain: (x: number) => number): Float32Array {
  const n = Math.floor(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    phase += (2 * Math.PI * freq(x)) / SAMPLE_RATE;
    out[i] = Math.sin(phase) * gain(x);
  }
  return out;
}

/** White noise through a time-varying RBJ biquad, with a gain curve. */
function filteredNoise(
  dur: number,
  type: 'bandpass' | 'highpass',
  q: number,
  freq: (x: number) => number,
  gain: (x: number) => number,
): Float32Array {
  const n = Math.floor(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const w0 = (2 * Math.PI * Math.min(freq(x), SAMPLE_RATE * 0.45)) / SAMPLE_RATE;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    let b0: number, b1: number, b2: number;
    if (type === 'bandpass') {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    const input = Math.random() * 2 - 1;
    const y = (b0 * input + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = input;
    y2 = y1;
    y1 = y;
    out[i] = y * gain(x);
  }
  return normalize(out);
}

function normalize(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return samples;
  const k = 0.9 / peak;
  return samples.map((v) => v * k);
}

/** 16-bit mono PCM WAV. */
function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}
