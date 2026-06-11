/**
 * Interactive transform box drawn over the preview for the selected overlay
 * clip (logo / PiP). Drag the box to move it, drag the corner handle to scale.
 * Maps pointer coordinates to the project's normalized space, accounting for the
 * letterboxing introduced by the canvas's `object-fit: contain`.
 */
import { useEffect, useState, type RefObject } from 'react';
import { useEditor } from '../../state/EditorContext';
import { clipEnd, DEFAULT_TRANSFORM } from '../../core/timeline/types';
import { getMedia } from '../../core/media/registry';

type Geometry = {
  offX: number;
  offY: number;
  contentW: number;
  contentH: number;
  scale: number; // displayed px per project px
};

export function PreviewTransformBox({
  canvasRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const { project, playhead, selectedClipId, setClipTransform, endGesture } = useEditor();
  const [, force] = useState(0);

  // Recompute on window resize (canvas display size changes).
  useEffect(() => {
    const onResize = () => force((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const canvas = canvasRef.current;
  if (!canvas || !selectedClipId) return null;

  // Selected clip must be on an overlay track AND visible at the playhead.
  const track = project.tracks.find(
    (t) => t.role === 'overlay' && t.clips.some((c) => c.id === selectedClipId),
  );
  const clip = track?.clips.find((c) => c.id === selectedClipId);
  if (!clip) return null;
  if (playhead < clip.startInTimeline || playhead >= clipEnd(clip)) return null;

  const geom = (): Geometry => {
    const rect = canvas.getBoundingClientRect();
    const s = Math.min(rect.width / project.width, rect.height / project.height);
    const contentW = project.width * s;
    const contentH = project.height * s;
    return {
      scale: s,
      contentW,
      contentH,
      offX: rect.left + (rect.width - contentW) / 2,
      offY: rect.top + (rect.height - contentH) / 2,
    };
  };

  const g = geom();
  const media = getMedia(clip.sourceId);
  const fw = media?.meta.width || project.width;
  const fh = media?.meta.height || project.height;
  const baseScale = Math.min(project.width / fw, project.height / fh);
  const tf = clip.transform ?? DEFAULT_TRANSFORM;

  const drawnW = fw * baseScale * tf.scale * g.scale;
  const drawnH = fh * baseScale * tf.scale * g.scale;
  const centerX = g.offX + tf.xNorm * g.contentW;
  const centerY = g.offY + tf.yNorm * g.contentH;
  const left = centerX - drawnW / 2;
  const top = centerY - drawnH / 2;

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  const startMove = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const gg = geom();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = clip.transform ?? DEFAULT_TRANSFORM;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / gg.contentW;
      const dy = (ev.clientY - startY) / gg.contentH;
      setClipTransform(clip.id, {
        xNorm: clamp01(start.xNorm + dx),
        yNorm: clamp01(start.yNorm + dy),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      endGesture();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = clip.transform ?? DEFAULT_TRANSFORM;
    const cx = centerX;
    const cy = centerY;
    const startDist = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const move = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const scale = Math.max(0.05, Math.min(1.5, (start.scale * dist) / startDist));
      setClipTransform(clip.id, { scale });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      endGesture();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="tbox-layer">
      <div
        className="tbox"
        style={{ left, top, width: drawnW, height: drawnH }}
        onPointerDown={startMove}
      >
        <div className="tbox__handle" onPointerDown={startResize} />
      </div>
    </div>
  );
}
