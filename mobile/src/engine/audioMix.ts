/**
 * Background music and sound effects → engine audio layers.
 *
 * Mirrors the web mix (src/core/media/audioTimeline.ts): music fades in/out,
 * ducks under speech (base clips with audible sound) and can loop to the end
 * of the video; effects play once at their volume. Everything that changes
 * gain over time is flattened here into one piecewise-linear envelope per
 * layer, so the native engines only interpolate.
 */
import { primaryTrack } from '@timeline/project';
import { clipEnd, clipGain, type MusicItem, type Project, type SfxItem } from '@timeline/types';
import type { EngineAudio, GainPoint } from '../../modules/video-engine';

type Interval = [number, number];

// Duck ramps: fall just before speech, recover shortly after (same as web).
const DUCK_ATTACK = 0.12;
const DUCK_RELEASE = 0.15;

/** Merged time ranges where the base clips' own audio is audible. */
export function speechIntervals(project: Project): Interval[] {
  const spans = primaryTrack(project)
    .clips.filter((c) => clipGain(c) > 0)
    .map((c): Interval => [c.startInTimeline, clipEnd(c)])
    .sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** Linear interpolation over sorted points; holds the ends. */
function valueAt(points: GainPoint[], t: number): number {
  if (points.length === 0) return 1;
  if (t <= points[0].t) return points[0].gain;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      return span <= 0 ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / span;
    }
  }
  return points[points.length - 1].gain;
}

export function musicEnvelope(
  item: MusicItem,
  start: number,
  end: number,
  speech: Interval[],
): GainPoint[] {
  const fadeIn = Math.min(item.fadeInSec, (end - start) / 2);
  const fadeOut = Math.min(item.fadeOutSec, (end - start) / 2);
  const fade: GainPoint[] = [
    { t: start, gain: fadeIn > 0 ? 0 : item.volume },
    { t: start + fadeIn, gain: item.volume },
    { t: end - fadeOut, gain: item.volume },
    { t: end, gain: fadeOut > 0 ? 0 : item.volume },
  ];

  const duck: GainPoint[] = [{ t: start, gain: 1 }];
  if (item.duck) {
    for (const [s, e] of speech) {
      const a = Math.max(s, start);
      const b = Math.min(e, end);
      if (b <= a) continue;
      duck.push({ t: Math.max(start, a - DUCK_ATTACK), gain: 1 });
      duck.push({ t: a, gain: item.duckLevel });
      duck.push({ t: b, gain: item.duckLevel });
      duck.push({ t: Math.min(end, b + DUCK_RELEASE), gain: 1 });
    }
  }
  duck.sort((x, y) => x.t - y.t);

  // Sample the product at every breakpoint of either curve (plus midpoints,
  // since fade × duck is not linear between them).
  const times = new Set<number>();
  for (const p of [...fade, ...duck]) times.add(clampTime(p.t, start, end));
  const sorted = [...times].sort((a, b) => a - b);
  const all = new Set(sorted);
  for (let i = 1; i < sorted.length; i++) all.add((sorted[i - 1] + sorted[i]) / 2);
  return [...all]
    .sort((a, b) => a - b)
    .map((t) => ({ t: round(t), gain: round(valueAt(fade, t) * valueAt(duck, t)) }));
}

export function toEngineAudio(
  project: Project,
  duration: number,
  resolveUri: (sourceId: string) => string | null,
  synthUri: (name: string) => string | null,
): EngineAudio[] {
  if (duration <= 0) return [];
  const speech = speechIntervals(project);
  const layers: EngineAudio[] = [];

  for (const m of project.music) {
    const uri = resolveUri(m.sourceId);
    if (!uri) continue;
    const segment = Math.max(0.05, m.outPoint - m.inPoint);
    const start = Math.max(0, m.startSec);
    const end = Math.min(duration, m.loop ? duration : start + segment);
    if (end <= start) continue;
    layers.push({
      id: m.id,
      uri,
      start,
      end,
      inPoint: m.inPoint,
      outPoint: m.outPoint,
      loop: m.loop,
      envelope: musicEnvelope(m, start, end, speech),
    });
  }

  for (const s of project.sfx) {
    const uri = sfxUri(s, resolveUri, synthUri);
    if (!uri) continue;
    const start = Math.max(0, s.startSec);
    const end = Math.min(duration, start + s.durationSec);
    if (end <= start) continue;
    layers.push({
      id: s.id,
      uri,
      start,
      end,
      inPoint: 0,
      outPoint: s.durationSec,
      loop: false,
      envelope: [
        { t: start, gain: s.volume },
        { t: end, gain: s.volume },
      ],
    });
  }
  return layers;
}

function sfxUri(
  s: SfxItem,
  resolveUri: (sourceId: string) => string | null,
  synthUri: (name: string) => string | null,
): string | null {
  if (s.synth) return synthUri(s.synth);
  return s.sourceId ? resolveUri(s.sourceId) : null;
}

const clampTime = (t: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, t));
const round = (v: number) => Math.round(v * 1000) / 1000;
