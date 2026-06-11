/**
 * Silence detection + auto jump-cuts.
 *
 * Analyzes each base-track clip's source audio (RMS over short windows), finds
 * silences longer than a threshold, and returns the speech segments to keep.
 * The store then rebuilds the base track from those segments, dropping silence.
 */
import type { Project } from '../timeline/types';
import { clipDuration, type Clip } from '../timeline/types';
import { primaryTrack } from '../timeline/project';
import { getMedia } from '../media/registry';

const ANALYSIS_RATE = 16000; // mono, enough for energy detection and fast

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

export type SilenceCut = { clipId: string; segments: Segment[] };

export type SilenceResult = {
  cuts: SilenceCut[];
  removedSec: number;
  removedCount: number;
};

/** Render a clip's source audio range to a mono Float32 array at ANALYSIS_RATE. */
async function renderClipMono(
  clip: Clip,
): Promise<{ samples: Float32Array; rate: number } | null> {
  const media = getMedia(clip.sourceId);
  if (!media?.audioSink) return null;

  const dur = clipDuration(clip);
  const len = Math.ceil(dur * ANALYSIS_RATE);
  if (len <= 0) return null;

  const ctx = new OfflineAudioContext(1, len, ANALYSIS_RATE);
  for await (const { buffer, timestamp } of media.audioSink.buffers(
    clip.inPoint,
    clip.outPoint,
  )) {
    const playFromSrc = Math.max(timestamp, clip.inPoint);
    const playToSrc = Math.min(timestamp + buffer.duration, clip.outPoint);
    const segLen = playToSrc - playFromSrc;
    if (segLen <= 0) continue;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    try {
      node.start(playFromSrc - clip.inPoint, playFromSrc - timestamp, segLen);
    } catch {
      /* outside window */
    }
  }
  const rendered = await ctx.startRendering();
  return { samples: rendered.getChannelData(0).slice(), rate: ANALYSIS_RATE };
}

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

/** Analyze the base track and compute the segments to keep per clip. */
export async function analyzeBaseSilences(
  project: Project,
  opts: SilenceOptions,
): Promise<SilenceResult> {
  const cuts: SilenceCut[] = [];
  let removedSec = 0;
  let removedCount = 0;

  for (const clip of primaryTrack(project).clips) {
    const rendered = await renderClipMono(clip);
    if (!rendered) continue; // no audio → leave clip untouched

    const dur = clipDuration(clip);
    const local = detectSpeechSegments(rendered.samples, rendered.rate, dur, opts);
    if (local.length === 0) continue;

    // Map clip-relative segments to absolute source times.
    const segments = local.map((s) => ({
      inPoint: clip.inPoint + s.inPoint,
      outPoint: clip.inPoint + s.outPoint,
    }));

    const keptSec = segments.reduce((a, s) => a + (s.outPoint - s.inPoint), 0);
    const cutSec = dur - keptSec;
    if (cutSec > 0.05) {
      cuts.push({ clipId: clip.id, segments });
      removedSec += cutSec;
      removedCount += Math.max(0, segments.length - 1);
    }
  }

  return { cuts, removedSec, removedCount };
}
