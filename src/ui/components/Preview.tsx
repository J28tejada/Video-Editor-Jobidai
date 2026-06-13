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
  drawBaseClip,
} from '../../core/compositor/renderFrame';
import { drawActiveOverlays } from '../../core/compositor/overlays';
import { getCachedTimelineAudio, isTimelineAudioReady } from '../../core/media/audioTimeline';
import { waitForAudioContext } from '../../lib/audioContext';
import { PreviewTransformBox } from './PreviewTransformBox';
import { primaryTrack } from '../../core/timeline/project';
import { clipEnd, clipSourceTime, type Clip, type Project } from '../../core/timeline/types';
import { getMedia } from '../../core/media/registry';

/**
 * Can this project use the native <video> playback path?
 * Requires: no transitions, no video overlay tracks, no bg-removal,
 * no variable speed curves. All base clips must be video files.
 */
function isVideoPlayable(project: Project): boolean {
  if (project.transitions.length > 0) return false;
  for (let i = 1; i < project.tracks.length; i++) {
    if (project.tracks[i].clips.length > 0) return false;
  }
  const clips = primaryTrack(project).clips;
  if (clips.length === 0) return false;
  for (const c of clips) {
    if (c.removeBg || c.speedKeyframes?.length) return false;
    const m = getMedia(c.sourceId);
    if (!m?.file || !m.videoTrack) return false;
  }
  return true;
}

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
    // Used by the native <video> path (null in the legacy path).
    let videoEl: HTMLVideoElement | null = null;
    const videoSrcUrls: string[] = [];

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

      // React-state seek is throttled to limit re-renders (canvas stays 60fps).
      let lastSeekT = -Infinity;
      const seekHz = mobile ? 15 : 60;
      const seekThresh = 1 / seekHz;

      // ── Native <video> path (hardware decode — smoothest on mobile) ─────────
      // Used when the project is simple enough: single base track, normal speed,
      // no transitions, no video overlays, no bg-removal. The browser's hardware
      // decoder plays the video; we blit each frame to the canvas with drawFrame().
      // Audio is still driven by AudioContext (video element stays muted).
      if (isVideoPlayable(proj0)) {
        const clips = primaryTrack(proj0).clips;
        let activeClip: Clip =
          clips.find(c => startPlayhead >= c.startInTimeline && startPlayhead < clipEnd(c))
          ?? clips[0];
        const m0 = getMedia(activeClip.sourceId);
        if (m0?.file) {
          const srcUrl = URL.createObjectURL(m0.file);
          videoSrcUrls.push(srcUrl);
          videoEl = document.createElement('video');
          videoEl.muted = true;
          videoEl.playsInline = true;
          videoEl.preload = 'auto';
          videoEl.playbackRate = activeClip.speed ?? 1;
          videoEl.src = srcUrl;
          videoEl.currentTime = clipSourceTime(activeClip, startPlayhead);
          // Keep in DOM (off-screen) for iOS compatibility.
          videoEl.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;';
          document.body.appendChild(videoEl);

          // Wait until enough data is buffered to start playing.
          await new Promise<void>((resolve) => {
            if ((videoEl!.readyState ?? 0) >= 2) { resolve(); return; }
            videoEl!.addEventListener('canplay', () => resolve(), { once: true });
          });
          if (cancelled) return;

          videoEl.play().catch(() => {});

          const draw = () => {
            if (cancelled) return;
            const t = now();
            if (t >= duration) { seek(duration); pause(); return; }

            const next = clips.find(c => t >= c.startInTimeline && t < clipEnd(c));
            if (!next) {
              visible.drawFrame(null); // gap between clips
            } else {
              if (next.id !== activeClip.id) {
                // Advance to the next clip.
                const nm = getMedia(next.sourceId);
                if (nm?.file) {
                  if (next.sourceId !== activeClip.sourceId) {
                    const nu = URL.createObjectURL(nm.file);
                    videoSrcUrls.push(nu);
                    videoEl!.src = nu;
                  }
                  videoEl!.currentTime = clipSourceTime(next, t);
                  videoEl!.playbackRate = next.speed ?? 1;
                  videoEl!.play().catch(() => {});
                }
                activeClip = next;
              } else {
                // Gentle drift correction: only correct if > 200ms off.
                const exp = clipSourceTime(activeClip, t);
                if (Math.abs(videoEl!.currentTime - exp) > 0.2) videoEl!.currentTime = exp;
              }
              drawBaseClip(visible, videoEl!, activeClip);
            }

            drawActiveOverlays(visible, projectRef.current, t);
            if (t - lastSeekT >= seekThresh) { seek(t); lastSeekT = t; }
            raf = requestAnimationFrame(draw);
          };
          raf = requestAnimationFrame(draw);
          return; // skip legacy path
        }
      }

      // ── Legacy canvas path (transitions, overlay video, bg-removal, images) ──
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
      // Native <video> cleanup
      if (videoEl) {
        videoEl.pause();
        videoEl.src = '';
        try { document.body.removeChild(videoEl); } catch { /* already removed */ }
        videoEl = null;
      }
      for (const u of videoSrcUrls) URL.revokeObjectURL(u);
      videoSrcUrls.length = 0;
      try { node?.stop(); } catch { /* already stopped */ }
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
