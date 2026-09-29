/**
 * Timeline operations the agent needs on top of the editor's basic ones.
 * Pure: each returns a new Project.
 */
import {
  applySilenceCuts,
  primaryTrack,
  removeClip,
  splitAt,
} from '../timeline/project';
import { clipEnd, transformAt, type Clip, type Project, type TransformKey } from '../timeline/types';

const EPS = 0.005;

/** Remove the timeline span [start, end) from the base track. */
export function deleteRange(project: Project, start: number, end: number): Project {
  if (end - start < 0.02) return project;
  // Split at both edges (no-ops when they fall on a cut), then drop what's inside.
  let p = splitAt(project, end);
  p = splitAt(p, start);
  const inside = primaryTrack(p).clips.filter(
    (c) => c.startInTimeline >= start - EPS && clipEnd(c) <= end + EPS,
  );
  for (const c of inside) p = removeClip(p, c.id);
  return p;
}

/** A span of a source file, in source seconds. */
export type SourceRange = { sourceId: string; start: number; end: number };

/**
 * Cut source spans out of every base clip that uses them (e.g. words deleted
 * from the transcript). Clips are split around the removed spans; the base
 * track is re-packed.
 */
export function cutSourceRanges(project: Project, cuts: SourceRange[]): Project {
  if (cuts.length === 0) return project;
  const plan: { clipId: string; segments: { inPoint: number; outPoint: number }[] }[] = [];
  for (const clip of primaryTrack(project).clips) {
    const mine = cuts
      .filter((r) => r.sourceId === clip.sourceId && r.end > clip.inPoint && r.start < clip.outPoint)
      .sort((a, b) => a.start - b.start);
    if (mine.length === 0) continue;
    const segments: { inPoint: number; outPoint: number }[] = [];
    let cursor = clip.inPoint;
    for (const r of mine) {
      if (r.start > cursor + EPS) segments.push({ inPoint: cursor, outPoint: Math.min(r.start, clip.outPoint) });
      cursor = Math.max(cursor, r.end);
    }
    if (clip.outPoint > cursor + EPS) segments.push({ inPoint: cursor, outPoint: clip.outPoint });
    plan.push({ clipId: clip.id, segments: segments.filter((s) => s.outPoint - s.inPoint > 0.04) });
  }
  // applySilenceCuts keeps clips with an empty segment list; remove those explicitly.
  let p = applySilenceCuts(project, plan.filter((c) => c.segments.length > 0));
  for (const c of plan) if (c.segments.length === 0) p = removeClip(p, c.clipId);
  return p;
}

/**
 * Rebuild the base track from source spans in the given order (highlight
 * reels, re-ordering by story). Each new clip inherits the look of the first
 * existing base clip that uses the same source.
 */
export function keepRanges(project: Project, ranges: SourceRange[]): Project {
  const base = primaryTrack(project);
  const template = new Map<string, Clip>();
  for (const c of base.clips) if (!template.has(c.sourceId)) template.set(c.sourceId, c);
  const clips: Clip[] = [];
  let n = 0;
  for (const r of ranges) {
    const src = project.sources.find((s) => s.id === r.sourceId);
    if (!src) continue;
    const start = Math.max(0, r.start);
    const end = Math.min(src.durationSec, r.end);
    if (end - start < 0.1) continue;
    const t = template.get(r.sourceId);
    clips.push({
      ...(t ?? { kind: 'video' as const, sourceId: r.sourceId }),
      id: `clip_k${Date.now().toString(36)}${n++}`,
      sourceId: r.sourceId,
      inPoint: start,
      outPoint: end,
      startInTimeline: 0,
      speedKeyframes: undefined,
    } as Clip);
  }
  if (clips.length === 0) return project;
  let start = 0;
  const packed = clips.map((c) => {
    const placed = { ...c, startInTimeline: start };
    start += (c.outPoint - c.inPoint) / (c.speed && c.speed > 0 ? c.speed : 1);
    return placed;
  });
  const tracks = project.tracks.map((t) => (t.id === base.id ? { ...t, clips: packed } : t));
  return { ...project, tracks, transitions: [] };
}

/** Timeline spans → the source spans they show (split at clip boundaries). */
export function timelineToSourceRanges(
  project: Project,
  spans: { start: number; end: number }[],
): SourceRange[] {
  const out: SourceRange[] = [];
  const clips = primaryTrack(project).clips;
  for (const span of spans) {
    for (const c of clips) {
      const a = Math.max(span.start, c.startInTimeline);
      const b = Math.min(span.end, clipEnd(c));
      if (b - a < 0.05) continue;
      const speed = c.speed && c.speed > 0 ? c.speed : 1;
      out.push({
        sourceId: c.sourceId,
        start: c.inPoint + (a - c.startInTimeline) * speed,
        end: c.inPoint + (b - c.startInTimeline) * speed,
      });
    }
  }
  return out;
}

/**
 * Emphasis "punch-in": zoom to `scale` around timeline time `at` for
 * `duration` seconds (quick ease in/out), on the clip under that time.
 */
export function addEmphasisZoom(project: Project, at: number, duration: number, scale: number): Project {
  const base = primaryTrack(project);
  const clip = base.clips.find((c) => at >= c.startInTimeline && at < clipEnd(c));
  if (!clip) return project;
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const toSrc = (t: number) => clip.inPoint + (t - clip.startInTimeline) * speed;
  const end = Math.min(clipEnd(clip), at + duration);
  const ramp = Math.min(0.2, (end - at) / 3);
  const baseT = transformAt(clip, toSrc(at));
  const zoomed = { ...baseT, scale: baseT.scale * scale };
  const keys: TransformKey[] = [...(clip.transformKeys ?? [])];
  if (keys.length === 0) {
    keys.push({ t: clip.inPoint, ...baseT }, { t: clip.outPoint, ...baseT });
  }
  const added: TransformKey[] = [
    { t: toSrc(at), ...baseT },
    { t: toSrc(at + ramp), ...zoomed },
    { t: toSrc(end - ramp), ...zoomed },
    { t: toSrc(end), ...baseT },
  ];
  const [from, to] = [added[0].t, added[3].t];
  const merged = [...keys.filter((k) => k.t < from || k.t > to), ...added].sort((a, b) => a.t - b.t);
  const clips = base.clips.map((c) => (c.id === clip.id ? { ...c, transformKeys: merged } : c));
  return { ...project, tracks: project.tracks.map((t) => (t.id === base.id ? { ...t, clips } : t)) };
}

/**
 * Auto-reframe: keys that keep a tracked subject centered when a clip fills
 * (cover) an output of a different aspect. `subjects` are subject centers
 * (0..1 of the source frame) at source times; the path is smoothed so the
 * virtual camera moves calmly, and clamped so the frame stays covered.
 */
export function reframeKeys(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  inPoint: number,
  outPoint: number,
  subjects: { t: number; x: number; y: number }[],
  zoom = 1,
): TransformKey[] {
  const cover = Math.max(outW / srcW, outH / srcH) * zoom;
  const fw = (srcW * cover) / outW; // fitted size relative to output
  const fh = (srcH * cover) / outH;
  const inRange = subjects.filter((s) => s.t >= inPoint - 0.5 && s.t <= outPoint + 0.5).sort((a, b) => a.t - b.t);
  const center = (fx: number, f: number) => {
    const v = 0.5 + f * (0.5 - fx);
    const lo = 1 - f / 2;
    const hi = f / 2;
    return Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi));
  };
  if (inRange.length === 0) return [];
  // Moving average over ±1 s, then sample every 0.5 s.
  const smooth = (t: number, axis: 'x' | 'y') => {
    const near = inRange.filter((s) => Math.abs(s.t - t) <= 1);
    const list = near.length ? near : [inRange.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))];
    return list.reduce((sum, s) => sum + s[axis], 0) / list.length;
  };
  const keys: TransformKey[] = [];
  for (let t = inPoint; t <= outPoint + 1e-6; t += 0.5) {
    keys.push({ t, scale: zoom, xNorm: center(smooth(t, 'x'), fw), yNorm: center(smooth(t, 'y'), fh) });
  }
  if (keys[keys.length - 1].t < outPoint) {
    keys.push({ ...keys[keys.length - 1], t: outPoint });
  }
  return keys;
}

/** Set a base clip's fit and animated transform keys (auto-reframe). */
export function setTransformKeys(
  project: Project,
  clipId: string,
  keys: TransformKey[],
  fit?: 'contain' | 'cover',
): Project {
  const base = primaryTrack(project);
  const clips = base.clips.map((c) =>
    c.id === clipId ? { ...c, transformKeys: keys.length ? keys : undefined, ...(fit ? { fit } : {}) } : c,
  );
  return { ...project, tracks: project.tracks.map((t) => (t.id === base.id ? { ...t, clips } : t)) };
}
