/**
 * Silence detection on raw audio (pure): RMS over 20 ms windows, long
 * silences removed, speech padded and merged. Shared by the web editor
 * (Web Audio decoding) and the mobile app (native decoding).
 */
export type SilenceOptions = {
  /** RMS level below this (in dBFS) is considered silence. Default -40. */
  thresholdDb: number;
  /** Only silences at least this long (s) are cut. Default 0.4. */
  minSilenceSec: number;
  /** Keep this much padding (s) around kept speech. Default 0.08. */
  paddingSec: number;
  /** Drop speech segments shorter than this (s). Default 0.12. */
  minSpeechSec: number;
};

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  thresholdDb: -40,
  minSilenceSec: 0.4,
  paddingSec: 0.08,
  minSpeechSec: 0.12,
};

/** A range within a source (seconds) to keep. */
export type Segment = { inPoint: number; outPoint: number };

/**
 * Detect speech segments (seconds, relative to the clip) by removing long
 * silences. Returns segments to keep, padded.
 */
export function detectSpeechSegments(
  samples: Float32Array,
  rate: number,
  totalSec: number,
  opts: SilenceOptions,
): Segment[] {
  const win = Math.max(1, Math.floor(rate * 0.02)); // 20 ms windows
  const threshold = Math.pow(10, opts.thresholdDb / 20); // dBFS → linear RMS

  // RMS per window → silent? boolean.
  const silentWin: boolean[] = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(i + win, samples.length);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / (end - i));
    silentWin.push(rms < threshold);
  }
  const winSec = win / rate;

  // Collect long-silence intervals.
  const longSilences: Segment[] = [];
  let runStart = -1;
  for (let i = 0; i <= silentWin.length; i++) {
    const silent = i < silentWin.length && silentWin[i];
    if (silent && runStart === -1) runStart = i;
    else if (!silent && runStart !== -1) {
      const s = runStart * winSec;
      const e = i * winSec;
      if (e - s >= opts.minSilenceSec) longSilences.push({ inPoint: s, outPoint: e });
      runStart = -1;
    }
  }

  // Speech = complement of long silences over [0, totalSec].
  const speech: Segment[] = [];
  let cursor = 0;
  for (const sil of longSilences) {
    if (sil.inPoint > cursor) speech.push({ inPoint: cursor, outPoint: sil.inPoint });
    cursor = sil.outPoint;
  }
  if (cursor < totalSec) speech.push({ inPoint: cursor, outPoint: totalSec });

  // Pad, clamp, merge, drop tiny.
  const padded = speech.map((s) => ({
    inPoint: Math.max(0, s.inPoint - opts.paddingSec),
    outPoint: Math.min(totalSec, s.outPoint + opts.paddingSec),
  }));
  const merged: Segment[] = [];
  for (const s of padded) {
    const last = merged[merged.length - 1];
    if (last && s.inPoint <= last.outPoint) last.outPoint = Math.max(last.outPoint, s.outPoint);
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.outPoint - s.inPoint >= opts.minSpeechSec);
}
