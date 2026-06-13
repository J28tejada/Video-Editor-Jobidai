/**
 * Single source of truth for compositing one timeline frame at time `t`.
 * Used by both preview and export so they always look identical.
 *
 * Handles transitions by reading frames from both neighbouring clips across the
 * cut (straddling the boundary by durationSec/2 on each side) and blending them.
 * Reading slightly beyond a clip's trim is intentional and clamped to the
 * source's bounds.
 */
import type { Compositor } from './types';
import {
  activeClipInTrack,
  clipDuration,
  clipEnd,
  clipFilterCSS,
  clipSourceTime,
  type Clip,
  type Project,
  type TransitionKind,
} from '../timeline/types';
import { clipAtTime, primaryTrack } from '../timeline/project';
import { animState } from '../timeline/anim';
import { renderGlTransition } from './glTransitions';
import { segmentCutout } from '../ai/segmentation';

const intrinsic = (f: CanvasImageSource): { w: number; h: number } => {
  const o = f as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
  return { w: o.width ?? o.videoWidth ?? 0, h: o.height ?? o.videoHeight ?? 0 };
};
import { getMedia } from '../media/registry';
import { drawActiveOverlays } from './overlays';

type Layer = { clip: Clip; sourceTime: number };

type ComposePlan =
  | { type: 'single'; layer: Layer }
  | { type: 'transition'; kind: TransitionKind; progress: number; a: Layer; b: Layer };

const sourceTimeOf = (clip: Clip, t: number): number => clipSourceTime(clip, t);

/** Decide what to draw at time `t`: a single clip or a transition blend. */
export function composeAt(project: Project, t: number): ComposePlan | null {
  const clips = primaryTrack(project).clips;

  for (const tr of project.transitions) {
    const idx = clips.findIndex((c) => c.id === tr.afterClipId);
    if (idx === -1 || idx >= clips.length - 1) continue;
    const a = clips[idx];
    const b = clips[idx + 1];
    const boundary = clipEnd(a); // equals b.startInTimeline (contiguous)
    const d = Math.max(0.05, Math.min(tr.durationSec, clipDuration(a), clipDuration(b)));
    const half = d / 2;
    if (t >= boundary - half && t < boundary + half) {
      const progress = (t - (boundary - half)) / d; // 0..1
      return {
        type: 'transition',
        kind: tr.kind,
        progress,
        a: { clip: a, sourceTime: sourceTimeOf(a, t) },
        b: { clip: b, sourceTime: sourceTimeOf(b, t) },
      };
    }
  }

  const hit = clipAtTime(project, t);
  if (!hit) return null;
  return { type: 'single', layer: { clip: hit.clip, sourceTime: hit.sourceTime } };
}

/** Draw a transition between two frames at a given progress (0..1). */
function drawTransition(
  c: Compositor,
  fa: CanvasImageSource | null,
  fb: CanvasImageSource | null,
  kind: TransitionKind,
  p: number,
): void {
  const W = c.width;
  const H = c.height;

  // GL Transitions (gl-transitions library) run on a WebGL pass.
  if (kind.startsWith('gl:')) {
    const out = renderGlTransition(kind.slice(3), fa, fb, p, W, H);
    if (out) {
      c.drawFrame(out);
      return;
    }
    // Fall back to crossfade if WebGL/transition unavailable.
    c.drawFrame(fa);
    c.drawFrame(fb, { clear: false, alpha: p });
    return;
  }

  switch (kind) {
    case 'fade': {
      // Dip to black.
      c.drawFrame(null);
      if (p < 0.5) c.drawFrame(fa, { clear: false, alpha: 1 - p * 2 });
      else c.drawFrame(fb, { clear: false, alpha: (p - 0.5) * 2 });
      return;
    }
    case 'slide': {
      // A exits left, B enters from the right.
      c.drawFrame(null);
      c.drawFrame(fa, { clear: false, transform: { scale: 1, xNorm: 0.5 - p, yNorm: 0.5 } });
      c.drawFrame(fb, { clear: false, transform: { scale: 1, xNorm: 1.5 - p, yNorm: 0.5 } });
      return;
    }
    case 'wipe': {
      // B revealed left → right.
      c.drawFrame(fa);
      c.drawFrame(fb, { clear: false, clipRect: { x: 0, y: 0, w: W * p, h: H } });
      return;
    }
    case 'zoom': {
      // A zooms out behind; B zooms in while fading up.
      c.drawFrame(fa, { transform: { scale: 1 + 0.4 * p, xNorm: 0.5, yNorm: 0.5 } });
      c.drawFrame(fb, { clear: false, alpha: p, transform: { scale: 0.6 + 0.4 * p, xNorm: 0.5, yNorm: 0.5 } });
      return;
    }
    case 'blur': {
      // Whip blur: both blurred most at the midpoint, crossfading.
      const b = Math.sin(p * Math.PI) * 28;
      c.drawFrame(fa, { filter: `blur(${b}px)` });
      c.drawFrame(fb, { clear: false, alpha: p, filter: `blur(${b}px)` });
      return;
    }
    case 'crossfade':
    default: {
      c.drawFrame(fa);
      c.drawFrame(fb, { clear: false, alpha: p });
      return;
    }
  }
}

/** Draw a base clip with its background removed: bg fill + person cutout. */
async function drawBaseClipCutout(
  compositor: Compositor,
  frame: CanvasImageSource,
  clip: Clip,
): Promise<void> {
  const { w, h } = intrinsic(frame);
  const cutout = await segmentCutout(frame, w, h);
  if (!cutout) {
    drawBaseClip(compositor, frame, clip);
    return;
  }
  const filter = clipFilterCSS(clip.filters);
  const bg = clip.bg ?? { type: 'black' as const };
  if (bg.type === 'blur') {
    compositor.drawFrame(frame, { fit: 'cover', filter: `blur(${bg.blur ?? 24}px)` });
  } else if (bg.type === 'color') {
    compositor.drawFrame(null, { clearColor: bg.color ?? '#000' });
  } else {
    compositor.drawFrame(null);
  }
  compositor.drawFrame(cutout, {
    clear: false,
    fit: clip.fit ?? 'contain',
    transform: clip.transform,
    filter,
  });
}

/** Draw a base-track clip with its background fill (black / blur / color). */
export function drawBaseClip(
  compositor: Compositor,
  frame: CanvasImageSource | null,
  clip: Clip,
): void {
  const filter = clipFilterCSS(clip.filters);
  const fit = clip.fit ?? 'contain';
  const bg = clip.bg;

  // Cover (fills the frame) or default black bg → single pass.
  if (fit === 'cover' || !frame || !bg || bg.type === 'black') {
    compositor.drawFrame(frame, { filter, fit, transform: clip.transform });
    return;
  }

  // Contain with a custom background: fill behind, then draw the frame on top.
  if (bg.type === 'color') {
    compositor.drawFrame(null, { clearColor: bg.color ?? '#000' });
  } else {
    // Blurred, enlarged copy of the same frame.
    compositor.drawFrame(frame, { fit: 'cover', filter: `blur(${bg.blur ?? 24}px)` });
  }
  compositor.drawFrame(frame, { clear: false, filter, fit: 'contain', transform: clip.transform });
}

async function frameFor(layer: Layer): Promise<CanvasImageSource | null> {
  const media = getMedia(layer.clip.sourceId);
  if (!media) return null;
  // Still images show the same bitmap regardless of time.
  if (media.image) return media.image;
  if (!media.sink) return null;
  const st = Math.max(0, Math.min(layer.sourceTime, media.meta.durationSec));
  const wrapped = await media.sink.getCanvas(st);
  return wrapped?.canvas ?? null;
}

/** Composite and draw the timeline frame at `t` (frame + transitions + overlays). */
export async function renderTimelineFrame(
  compositor: Compositor,
  project: Project,
  t: number,
): Promise<void> {
  await renderTimelineBase(compositor, project, t);
  drawActiveOverlays(compositor, project, t);
}

/**
 * Render everything EXCEPT text overlays: base track (with transitions) and
 * any video overlay tracks. Decode-bound, so playback decodes this into an
 * offscreen layer while text overlays/karaoke are drawn separately at 60fps.
 */
export async function renderTimelineBase(
  compositor: Compositor,
  project: Project,
  t: number,
): Promise<void> {
  // ---- Base track (with transitions), drawn first (clears the canvas) ----
  const plan = composeAt(project, t);
  if (!plan) {
    compositor.drawFrame(null);
  } else if (plan.type === 'single') {
    const clip = plan.layer.clip;
    const frame = await frameFor(plan.layer);
    if (clip.removeBg && frame) {
      await drawBaseClipCutout(compositor, frame, clip);
    } else {
      drawBaseClip(compositor, frame, clip);
    }
  } else {
    const [fa, fb] = await Promise.all([frameFor(plan.a), frameFor(plan.b)]);
    drawTransition(compositor, fa, fb, plan.kind, plan.progress);
  }

  // ---- Overlay tracks, composited on top in array order (bottom → top) ----
  for (let i = 1; i < project.tracks.length; i++) {
    const track = project.tracks[i];
    if (track.role !== 'overlay') continue;
    const clip = activeClipInTrack(track, t);
    if (!clip) continue;
    const sourceTime = clipSourceTime(clip, t);
    let frame = await frameFor({ clip, sourceTime });
    if (!frame) continue;
    if (clip.removeBg) {
      const { w, h } = intrinsic(frame);
      const cutout = await segmentCutout(frame, w, h);
      if (cutout) frame = cutout;
    }
    const a = animState(clip.startInTimeline, clipEnd(clip), clip.enter, clip.exit, t);
    const base = clip.transform ?? { scale: 1, xNorm: 0.5, yNorm: 0.5 };
    const transform = {
      scale: base.scale * a.scale,
      xNorm: base.xNorm + a.offsetXNorm,
      yNorm: base.yNorm + a.offsetYNorm,
    };
    compositor.drawFrame(frame, {
      clear: false,
      transform,
      alpha: a.opacity,
      filter: clipFilterCSS(clip.filters),
    });
  }
}
