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
import { clipEnd, type Clip, type Project } from '../timeline/types';

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
