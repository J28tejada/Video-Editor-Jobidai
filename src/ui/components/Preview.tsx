/**
 * Preview surface: renders the timeline frame at the current playhead and
 * drives playback. Decoding is on-demand via the source CanvasSink; the
 * Canvas2D compositor draws the frame into the project-sized output canvas.
 *
 * Two distinct modes:
 *  - Scrubbing (paused): render the single frame at the current playhead,
 *    cancelling superseded decodes so the latest seek wins.
 *  - Playback (playing): a decode-paced async loop that advances the playhead
 *    by wall-clock time and draws every frame it manages to decode. We do NOT
 *    cancel in-flight decodes here — otherwise rapid playhead updates would
 *    supersede every decode before it resolves and the image would freeze.
 */
import { useEffect, useRef } from 'react';
import { useEditor } from '../../state/EditorContext';
import { Canvas2DCompositor } from '../../core/compositor/canvas2d';
import {
  renderTimelineFrame,
  renderTimelineBase,
} from '../../core/compositor/renderFrame';
import { drawActiveOverlays } from '../../core/compositor/overlays';
import { getCachedTimelineAudio, isTimelineAudioReady } from '../../core/media/audioTimeline';
import { waitForAudioContext } from '../../lib/audioContext';
import { PreviewTransformBox } from './PreviewTransformBox';

export function Preview() {
  const { project, playhead, isPlaying, duration, seek, pause, status, setStatus } = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<Canvas2DCompositor | null>(null);

  // Refs so the playback loop always sees the latest values without re-subscribing.
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const projectRef = useRef(project);
  projectRef.current = project;

  // (Re)create compositor when output dimensions change.
  useEffect(() => {
    if (!canvasRef.current) return;
    compositorRef.current?.dispose();
    compositorRef.current = new Canvas2DCompositor(
      project.width,
      project.height,
      canvasRef.current,
    );
  }, [project.width, project.height]);

  // Scrub render: only while paused. Renders the frame at the current playhead.
  useEffect(() => {
    if (isPlaying) return;
    const compositor = compositorRef.current;
    if (!compositor) return;
    renderTimelineFrame(compositor, project, playhead);
  }, [project, playhead, isPlaying]);

  // Playback. Decode and display are decoupled for smoothness:
  //  - A decode pump renders the (decode-bound) video layer into an offscreen
  //    base compositor, always targeting the latest clock time (dropping frames
  //    if it falls behind).
  //  - A requestAnimationFrame loop runs at the display rate, copying the latest
  //    base layer and drawing text/karaoke overlays on top — so the playhead and
  //    captions stay smooth at 60fps even if video decode is slower.
  // The Web Audio clock is the master when the timeline has audio.
  useEffect(() => {
    if (!isPlaying) return;
    const visible = compositorRef.current;
    if (!visible) return;

    const proj0 = projectRef.current;
    const base = new Canvas2DCompositor(proj0.width, proj0.height); // offscreen
    const frameInterval = 1 / Math.max(1, proj0.fps);

    let cancelled = false;
    let audioCtx: AudioContext | null = null;
    let node: AudioBufferSourceNode | null = null;
    let raf = 0;

    (async () => {
      const startPlayhead = playheadRef.current;

      // Resolve (cached) timeline audio and set up the master clock.
      // Wrapped in try/catch: if audio decoding fails on mobile (e.g. WebCodecs
      // audio unavailable) we gracefully fall back to a wall-clock timer so
      // video still plays (silently) rather than freezing the entire playback.
      let audio: AudioBuffer | null = null;
      try {
        const needsBuild = !isTimelineAudioReady(projectRef.current);
        if (needsBuild) setStatus('Preparando audio…');
        audio = await getCachedTimelineAudio(projectRef.current);
        if (needsBuild) setStatus(null);
      } catch {
        setStatus(null);
      }
      if (cancelled) return;

      let elapsed: () => number;
      if (audio && startPlayhead < audio.duration) {
        // waitForAudioContext() awaits the resume() Promise that was triggered
        // synchronously in the play button's click handler (unlockAudio()).
        // This eliminates a race where the context is still 'suspended' here
        // because the microtask-based resume hasn't resolved yet.
        audioCtx = await waitForAudioContext();
        node = audioCtx.createBufferSource();
        node.buffer = audio;
        node.connect(audioCtx.destination);
        const startAt = audioCtx.currentTime + 0.05;
        node.start(startAt, Math.max(0, startPlayhead));
        elapsed = () => audioCtx!.currentTime - startAt;
      } else {
        const t0 = performance.now();
        elapsed = () => (performance.now() - t0) / 1000;
      }
      const now = () => startPlayhead + Math.max(0, elapsed());

      // Prime the first base frame so there is no black flash on start.
      await renderTimelineBase(base, projectRef.current, now());
      if (cancelled) return;

      // Decode pump: keep the base layer as close to "now" as decode allows.
      (async () => {
        let lastDecoded = -1;
        while (!cancelled) {
          const t = now();
          if (t >= duration) break;
          if (Math.abs(t - lastDecoded) < frameInterval) {
            // Caught up; wait one display frame before checking again.
            await new Promise((r) => requestAnimationFrame(() => r(null)));
            continue;
          }
          lastDecoded = t;
          await renderTimelineBase(base, projectRef.current, t);
        }
      })();

      // Display loop: 60fps composite of base layer + text/karaoke overlays.
      const draw = () => {
        if (cancelled) return;
        const t = now();
        if (t >= duration) {
          seek(duration);
          pause();
          return;
        }
        seek(t);
        visible.drawFrame(base.canvas, { clear: true });
        drawActiveOverlays(visible, projectRef.current, t);
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      try {
        node?.stop();
      } catch {
        // already stopped
      }
      // Do not close audioCtx — it is a shared singleton.
      base.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, duration]);

  return (
    <div className="preview">
      <canvas ref={canvasRef} className="preview__canvas" />
      {!isPlaying && <PreviewTransformBox canvasRef={canvasRef} />}
      {status && (
        <div className="preview__loading">
          <div className="spinner" />
          <span>{status}</span>
        </div>
      )}
    </div>
  );
}
