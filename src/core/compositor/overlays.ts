/**
 * Draws all text overlays active at a given timeline time onto a compositor.
 * Shared by preview and export so they always match.
 */
import type { Compositor } from './types';
import type { Project } from '../timeline/types';
import { activeOverlays } from '../timeline/project';
import { animState } from '../timeline/anim';

export function drawActiveOverlays(
  compositor: Compositor,
  project: Project,
  timeSec: number,
): void {
  for (const o of activeOverlays(project, timeSec)) {
    let activeWordIndex = -1;
    if (o.words && o.words.length > 0) {
      // Last word whose start has passed; clamps to the final word once spoken.
      for (let i = 0; i < o.words.length; i++) {
        if (timeSec >= o.words[i].start) activeWordIndex = i;
        else break;
      }
    }
    const a = animState(o.startSec, o.endSec, o.enter, o.exit, timeSec);
    compositor.drawText({
      text: o.text,
      xNorm: o.xNorm,
      yNorm: o.yNorm,
      fontSizeNorm: o.fontSizeNorm,
      color: o.color,
      fontWeight: o.fontWeight,
      background: o.background,
      align: o.align,
      words: o.words,
      activeWordIndex,
      highlightColor: o.highlightColor,
      opacity: a.opacity,
      animScale: a.scale,
      offsetXNorm: a.offsetXNorm,
      offsetYNorm: a.offsetYNorm,
      strokeColor: o.strokeColor,
      strokeWidthNorm: o.strokeWidthNorm,
      glow: o.glow,
      glowColor: o.glowColor,
    });
  }
}
