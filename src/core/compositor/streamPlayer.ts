/**
 * Streaming playback decoder for smooth preview.
 *
 * Instead of decoding one frame at a time targeting the wall-clock (which
 * re-seeks and wastes decode budget whenever the device falls behind), this
 * uses Mediabunny's CanvasSink.canvases() async iterator. That decodes every
 * packet at most once, in presentation order, and pre-decodes a few frames
 * ahead — the native way to play a video forward smoothly.
 *
 * Scope: only the common "simple" project is streamed (single base track,
 * normal speed, no transitions, no video-overlay tracks, no background
 * removal). Anything more complex falls back to the per-frame compositor in
 * Preview. Text overlays/captions are always drawn separately at 60fps, so
 * they work with the streaming path too.
 */
import { CanvasSink } from 'mediabunny';
import { getMedia } from '../media/registry';
import { primaryTrack } from '../timeline/project';
import {
  clipEnd,
  clipSourceTime,
  type Clip,
  type Project,
} from '../timeline/types';

/** A decoded base-track frame mapped to its timeline position. */
export type StreamFrame = {
  /** Timeline time (seconds) at which this frame should be shown. */
  timelineTime: number;
  /** The decoded canvas (reused from a pool — copy it if you need to hold it). */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** The clip this frame belongs to (for fit/filters/bg treatment). */
  clip: Clip;
};

/** Is this clip playable by the fast streaming path? */
function clipIsSimple(clip: Clip): boolean {
  const normalSpeed = (clip.speed ?? 1) === 1 && !clip.speedKeyframes?.length;
  return normalSpeed && !clip.removeBg;
}

/**
 * Whether `project` can use the streaming player. Conservative on purpose:
 * any feature the streamer doesn't composite forces the legacy path.
 */
export function isStreamable(project: Project): boolean {
  if (project.transitions.length > 0) return false;
  // No active overlay video tracks (logos / PiP).
  for (let i = 1; i < project.tracks.length; i++) {
    if (project.tracks[i].role === 'overlay' && project.tracks[i].clips.length > 0) {
      return false;
    }
  }
  const clips = primaryTrack(project).clips;
  if (clips.length === 0) return false;
  for (const c of clips) {
    if (!clipIsSimple(c)) return false;
    const media = getMedia(c.sourceId);
    // Streaming needs a decodable video track. Images have no sink → legacy path.
    if (!media || !media.videoTrack || !media.sink) return false;
  }
  return true;
}

/**
 * Yield base-track frames in timeline order from `startPlayhead`, streaming
 * each clip's source range via a dedicated reduced-resolution CanvasSink.
 *
 * @param scale  Decode resolution multiplier (e.g. 0.4 on mobile) — smaller
 *               frames decode and composite faster for smoother playback.
 */
export async function* streamBaseFrames(
  project: Project,
  startPlayhead: number,
  scale: number,
  isCancelled: () => boolean,
): AsyncGenerator<StreamFrame, void, unknown> {
  const clips = primaryTrack(project).clips;

  for (const clip of clips) {
    if (isCancelled()) return;
    // Skip clips that finish before we start.
    if (clipEnd(clip) <= startPlayhead) continue;

    const media = getMedia(clip.sourceId);
    if (!media?.videoTrack) continue;

    const w = Math.max(2, Math.round(media.meta.width * scale));
    const h = Math.max(2, Math.round(media.meta.height * scale));
    const sink = new CanvasSink(media.videoTrack, {
      width: w,
      height: h,
      fit: 'fill',
      poolSize: 8, // ring buffer big enough for the iterator's look-ahead + held frame
    });

    // Where to start within this clip's source range.
    const from =
      startPlayhead > clip.startInTimeline
        ? clipSourceTime(clip, startPlayhead)
        : clip.inPoint;

    for await (const wrapped of sink.canvases(from, clip.outPoint)) {
      if (isCancelled()) return;
      // Normal speed: timeline time advances 1:1 with source time.
      const timelineTime = clip.startInTimeline + (wrapped.timestamp - clip.inPoint);
      yield { timelineTime, canvas: wrapped.canvas, clip };
    }
  }
}
