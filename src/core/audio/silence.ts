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
import {
  DEFAULT_SILENCE_OPTIONS,
  detectSpeechSegments,
  type Segment,
  type SilenceOptions,
} from './speechSegments';

export { DEFAULT_SILENCE_OPTIONS, detectSpeechSegments, type Segment, type SilenceOptions };

const ANALYSIS_RATE = 16000; // mono, enough for energy detection and fast

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
