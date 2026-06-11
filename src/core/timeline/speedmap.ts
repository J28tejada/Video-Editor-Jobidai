/**
 * Time remapping: turns a clip's variable-speed keyframes into a monotonic
 * mapping between timeline time (offset from clip start) and source time
 * (offset from inPoint). Built by integrating 1/speed over the source range.
 *
 * Memoized per clip content signature so the (cheap) lookups used everywhere
 * (clipDuration, clipSourceTime) stay fast.
 */
import type { Clip, SpeedKey } from './types';

type SpeedMap = {
  timelineDuration: number;
  // Parallel arrays: cumulative timeline offset -> source offset.
  tl: Float64Array;
  src: Float64Array;
};

const SAMPLES = 96;
const cache = new Map<string, SpeedMap>();

const clampSpeed = (s: number): number => Math.max(0.1, Math.min(8, s));

function signature(clip: Clip): string {
  const dur = clip.outPoint - clip.inPoint;
  const keys = (clip.speedKeyframes ?? []).map((k) => `${k.t.toFixed(3)}:${k.speed.toFixed(3)}`).join(',');
  return `${dur.toFixed(4)}|${keys}`;
}

/** Piecewise-linear speed at source fraction u (0..1). */
function speedAt(keys: SpeedKey[], u: number): number {
  if (keys.length === 0) return 1;
  if (u <= keys[0].t) return clampSpeed(keys[0].speed);
  const last = keys[keys.length - 1];
  if (u >= last.t) return clampSpeed(last.speed);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (u >= a.t && u <= b.t) {
      const f = b.t === a.t ? 0 : (u - a.t) / (b.t - a.t);
      return clampSpeed(a.speed + (b.speed - a.speed) * f);
    }
  }
  return clampSpeed(last.speed);
}

function build(clip: Clip): SpeedMap {
  const sourceDur = Math.max(0.0001, clip.outPoint - clip.inPoint);
  const keys = [...(clip.speedKeyframes ?? [])].sort((a, b) => a.t - b.t);
  const tl = new Float64Array(SAMPLES + 1);
  const src = new Float64Array(SAMPLES + 1);
  let cumT = 0;
  tl[0] = 0;
  src[0] = 0;
  for (let i = 1; i <= SAMPLES; i++) {
    const u0 = (i - 1) / SAMPLES;
    const u1 = i / SAMPLES;
    const dSource = sourceDur * (u1 - u0);
    const sMid = speedAt(keys, (u0 + u1) / 2);
    cumT += dSource / sMid; // timeline time to consume this source chunk
    tl[i] = cumT;
    src[i] = sourceDur * u1;
  }
  return { timelineDuration: cumT, tl, src };
}

function getMap(clip: Clip): SpeedMap {
  const sig = signature(clip);
  let m = cache.get(sig);
  if (!m) {
    m = build(clip);
    if (cache.size > 256) cache.clear();
    cache.set(sig, m);
  }
  return m;
}

/** Timeline duration of a clip with a speed curve. */
export function curveTimelineDuration(clip: Clip): number {
  return getMap(clip).timelineDuration;
}

/** Source offset (from inPoint) for a timeline offset (from clip start). */
export function curveSourceOffset(clip: Clip, tOffset: number): number {
  const { tl, src, timelineDuration } = getMap(clip);
  if (tOffset <= 0) return 0;
  if (tOffset >= timelineDuration) return src[src.length - 1];
  // Binary search tl for tOffset.
  let lo = 0;
  let hi = tl.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tl[mid] <= tOffset) lo = mid;
    else hi = mid;
  }
  const span = tl[hi] - tl[lo];
  const f = span <= 0 ? 0 : (tOffset - tl[lo]) / span;
  return src[lo] + (src[hi] - src[lo]) * f;
}
