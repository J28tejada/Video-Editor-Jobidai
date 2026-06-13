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
import { drawBaseClip } from '../../core/compositor/renderFrame';
import { drawActiveOverlays } from '../../core/compositor/overlays';
import { isStreamable, streamBaseFrames } from '../../core/compositor/streamPlayer';
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
    // Mobile: half-res offscreen compositor → 4× fewer pixels per decode-pump
    // iteration, significantly reducing Canvas 2D workload per frame.
    const mobile = typeof window !== 'undefined' && window.innerWidth <= 760;
    const baseScale = mobile ? 0.5 : 1;
    const base = new Canvas2DCompositor(
      Math.round(proj0.width * baseScale),
      Math.round(proj0.height * baseScale),
    );
    // Mobile: target 24 fps to give the hardware more decode budget per frame.
    const targetFps = mobile ? Math.min(proj0.fps, 24) : proj0.fps;
    const frameInterval = 1 / Math.max(1, targetFps);

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

      // Display loop seeks (React state) throttled to ~15fps on mobile to avoid
      // 60 re-renders/sec of Timeline & other consumers; canvas stays at 60fps.
      let lastSeekT = -Infinity;
      const seekHz = mobile ? 15 : 60;
      const seekThresh = 1 / seekHz;

      // ── Streaming path: forward decode via CanvasSink iterator (smoothest) ──
      // Used for simple projects (single base track, normal speed, no
      // transitions / overlay tracks / bg-removal). Decodes every packet once.
      if (isStreamable(projectRef.current)) {
        const playScale = mobile ? 0.4 : 1;
        // Pooled canvases are reused by the iterator, so copy the latest frame
        // into a stable canvas the display loop can read at any time.
        const hold = document.createElement('canvas');
        const holdCtx = hold.getContext('2d', { alpha: false });
        let holdClip: Parameters<typeof drawBaseClip>[2] | null = null;
        let hasFrame = false;

        // Producer: pull decoded frames, paced to the master clock.
        (async () => {
          try {
            for await (const f of streamBaseFrames(
              projectRef.current, startPlayhead, playScale, () => cancelled,
            )) {
              if (cancelled) return;
              // Don't run ahead of the clock: wait until it is (nearly) time.
              while (!cancelled && now() < f.timelineTime - 0.004) {
                await new Promise((r) => requestAnimationFrame(() => r(null)));
              }
              if (cancelled) return;
              // Drop badly-late frames so video can catch back up to audio.
              if (now() - f.timelineTime > 0.25) continue;
              if (holdCtx) {
                if (hold.width !== f.canvas.width || hold.height !== f.canvas.height) {
                  hold.width = f.canvas.width;
                  hold.height = f.canvas.height;
                }
                holdCtx.drawImage(f.canvas, 0, 0);
                holdClip = f.clip;
                hasFrame = true;
              }
            }
          } catch {
            // Stop producing on error; display loop keeps the last frame.
          }
        })();

        const draw = () => {
          if (cancelled) return;
          const t = now();
          if (t >= duration) { seek(duration); pause(); return; }
          if (hasFrame && holdClip) drawBaseClip(visible, hold, holdClip);
          drawActiveOverlays(visible, projectRef.current, t);
          if (t - lastSeekT >= seekThresh) { seek(t); lastSeekT = t; }
          raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
        return;
      }

      // ── Legacy path: per-frame compositor (transitions, overlays, images) ──
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

      const draw = () => {
        if (cancelled) return;
        const t = now();
        if (t >= duration) {
          seek(duration);
          pause();
          return;
        }
        visible.drawFrame(base.canvas, { clear: true });
        drawActiveOverlays(visible, projectRef.current, t);
        if (t - lastSeekT >= seekThresh) {
          seek(t);
          lastSeekT = t;
        }
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
