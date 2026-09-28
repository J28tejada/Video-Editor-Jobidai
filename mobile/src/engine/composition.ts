/**
 * Project → EngineComposition. The engine only receives this flattened,
 * render-ready description; the editable project model stays in JS.
 */
import { primaryTrack } from '@timeline/project';
import { clipDuration, clipGain, clipSpeed, type Project } from '@timeline/types';
import type { EngineComposition } from '../../modules/video-engine';

/**
 * Builds the engine description for the base track and text overlays.
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
    clips.push({
      id: clip.id,
      uri,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      start: cursor,
      speed: clipSpeed(clip),
      volume: clipGain(clip),
      fit: clip.fit ?? 'contain',
    });
    cursor += clipDuration(clip);
  }
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
    }));
  return { width: project.width, height: project.height, fps: project.fps, clips, texts };
}
