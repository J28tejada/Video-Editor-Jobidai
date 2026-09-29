/**
 * Remove silences (jump cuts) on the base track, using the web editor's
 * detector on audio decoded natively.
 */
import {
  DEFAULT_SILENCE_OPTIONS,
  detectSpeechSegments,
  type Segment,
  type SilenceOptions,
} from '@audio/speechSegments';
import { primaryTrack } from '@timeline/project';
import { clipSpeed, type Project } from '@timeline/types';
import { ANALYSIS_RATE, decodeMono } from './pcm';

export { DEFAULT_SILENCE_OPTIONS, type SilenceOptions };

export type SilenceAnalysis = {
  cuts: { clipId: string; segments: Segment[] }[];
  /** Timeline seconds that would be removed. */
  removedSec: number;
  /** Number of new cuts. */
  removedCount: number;
};

export async function analyzeSilences(
  project: Project,
  resolveUri: (sourceId: string) => string | null,
  opts: SilenceOptions,
  onProgress?: (fraction: number) => void,
): Promise<SilenceAnalysis> {
  const clips = primaryTrack(project).clips;
  const cuts: SilenceAnalysis['cuts'] = [];
  let removedSec = 0;
  let removedCount = 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    onProgress?.(i / clips.length);
    const uri = resolveUri(clip.sourceId);
    if (!uri) continue;
    const samples = await decodeMono(uri, clip.inPoint, clip.outPoint);
    if (samples.length === 0) continue; // no audio → leave the clip as is

    // Segments are relative to the clip's source range (speed-independent).
    const sourceLen = clip.outPoint - clip.inPoint;
    const local = detectSpeechSegments(samples, ANALYSIS_RATE, sourceLen, opts);
    if (local.length === 0) continue;
    const segments = local.map((s) => ({
      inPoint: clip.inPoint + s.inPoint,
      outPoint: clip.inPoint + s.outPoint,
    }));
    const kept = segments.reduce((sum, s) => sum + (s.outPoint - s.inPoint), 0);
    const cutTimeline = (sourceLen - kept) / clipSpeed(clip);
    if (cutTimeline > 0.05) {
      cuts.push({ clipId: clip.id, segments });
      removedSec += cutTimeline;
      removedCount += Math.max(0, segments.length - 1);
    }
  }
  onProgress?.(1);
  return { cuts, removedSec, removedCount };
}
