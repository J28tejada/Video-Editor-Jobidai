/**
 * Project → EngineComposition. The engine only receives this flattened,
 * render-ready description; the editable project model stays in JS.
 */
import { primaryTrack } from '@timeline/project';
import { clipDuration, clipGain, clipSpeed, type Project } from '@timeline/types';
import type { EngineComposition, EngineTransitionKind } from '../../modules/video-engine';
import { synthUri } from '../media/synthSfx';
import { toEngineAudio } from './audioMix';
import { filtersToMatrix } from './colorMatrix';

/** Transition kinds the native engines render; others fall back to crossfade. */
const ENGINE_KINDS: EngineTransitionKind[] = ['crossfade', 'fade', 'slide'];

/**
 * Builds the engine description for the base track (with color, zoom and
 * transitions), text overlays and the music / sound-effect layers.
 * Clips whose media is missing are skipped (the timeline is re-packed so the
 * engine still sees contiguous clips).
 */
export function toEngineComposition(
  project: Project,
  resolveUri: (sourceId: string) => string | null,
): EngineComposition {
  let cursor = 0;
  const clips: EngineComposition['clips'] = [];
  for (const clip of primaryTrack(project).clips) {
    const uri = resolveUri(clip.sourceId);
    if (!uri) continue;
    const source = project.sources.find((x) => x.id === clip.sourceId);
    clips.push({
      id: clip.id,
      uri,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      start: cursor,
      speed: clipSpeed(clip),
      volume: clipGain(clip),
      fit: clip.fit ?? 'contain',
      colorMatrix: filtersToMatrix(clip.filters),
      transform: isNeutral(clip.transform) ? null : clip.transform!,
      transformKeys: clip.transformKeys?.length ? clip.transformKeys : null,
      srcWidth: source?.width || project.width,
      srcHeight: source?.height || project.height,
    });
    cursor += clipDuration(clip);
  }

  // Transitions are centered on the cut, clamped so they never exceed either
  // neighbouring clip (same rule as the web renderer).
  const baseClips = primaryTrack(project).clips;
  const transitions: EngineComposition['transitions'] = [];
  for (const tr of project.transitions) {
    const index = clips.findIndex((c) => c.id === tr.afterClipId);
    if (index === -1 || index >= clips.length - 1) continue;
    const a = baseClips.find((c) => c.id === clips[index].id);
    const b = baseClips.find((c) => c.id === clips[index + 1].id);
    if (!a || !b) continue;
    const d = Math.max(0.05, Math.min(tr.durationSec, clipDuration(a), clipDuration(b)));
    const kind = (ENGINE_KINDS as string[]).includes(tr.kind)
      ? (tr.kind as EngineTransitionKind)
      : 'crossfade';
    transitions.push({ index, kind, half: d / 2 });
  }
  transitions.sort((x, y) => x.index - y.index);
  const texts = project.overlays
    .filter((o) => o.text.trim().length > 0 && o.endSec > o.startSec)
    .map((o) => ({
      id: o.id,
      text: o.text,
      start: o.startSec,
      end: o.endSec,
      xNorm: o.xNorm,
      yNorm: o.yNorm,
      fontSizeNorm: o.fontSizeNorm,
      color: o.color,
      fontWeight: o.fontWeight,
      background: o.background,
      align: o.align,
      ...(o.words?.length ? { words: o.words, highlightColor: o.highlightColor ?? '#ffe600' } : {}),
    }));
  const audio = toEngineAudio(project, cursor, resolveUri, synthUri);

  // B-roll: overlay-track clips, full screen, within the base edit.
  const cutaways: EngineComposition['cutaways'] = [];
  for (const track of project.tracks) {
    if (track.role !== 'overlay') continue;
    for (const c of track.clips) {
      const uri = resolveUri(c.sourceId);
      const start = c.startInTimeline;
      const end = Math.min(cursor, start + clipDuration(c));
      if (!uri || end - start < 0.1) continue;
      const src = project.sources.find((x) => x.id === c.sourceId);
      cutaways.push({
        id: c.id,
        uri,
        start,
        end,
        inPoint: c.inPoint,
        fit: c.fit ?? 'cover',
        colorMatrix: filtersToMatrix(c.filters),
        srcWidth: src?.width || project.width,
        srcHeight: src?.height || project.height,
      });
    }
  }
  cutaways.sort((a, b) => a.start - b.start);
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    clips,
    texts,
    audio,
    transitions,
    cutaways,
  };
}

function isNeutral(t: { scale: number; xNorm: number; yNorm: number } | undefined): boolean {
  return !t || (t.scale === 1 && t.xNorm === 0.5 && t.yNorm === 0.5);
}
