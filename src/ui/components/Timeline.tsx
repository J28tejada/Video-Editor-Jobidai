/**
 * Multitrack timeline.
 * - One lane per video track (base at the bottom of the stack, overlays above).
 * - Base track: contiguous clips, cut markers (transitions), reorder buttons.
 * - Overlay tracks: clips positioned freely (drag the body to move in time),
 *   plus per-track import and remove-track controls.
 * - Text overlays get their own lane at the bottom.
 * - Click the ruler/empty area to seek; the playhead spans all lanes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X, ArrowLeftRight, ChevronLeft, ChevronRight, Volume2, Music } from 'lucide-react';
import { useEditor } from '../../state/EditorContext';
import {
  clipDuration,
  clipEnd,
  type Clip,
  type MusicItem,
  type TextOverlay,
  type Track,
} from '../../core/timeline/types';
import { getMedia } from '../../core/media/registry';
import { getThumb, getCachedThumb } from '../../core/media/thumbnails';
import { transitionAfterClip } from '../../core/timeline/project';

type Thumb = { left: number; width: number; url: string };

/** Decode a strip of thumbnails for a clip, filling its block width. */
function useClipThumbnails(
  sourceId: string,
  inPoint: number,
  outPoint: number,
  widthPx: number,
): Thumb[] {
  const wq = Math.round(widthPx / 24) * 24; // quantize to limit churn while trimming
  const [thumbs, setThumbs] = useState<Thumb[]>([]);

  useEffect(() => {
    const media = getMedia(sourceId);
    if (!media || (!media.videoTrack && !media.image)) {
      setThumbs([]);
      return;
    }
    let cancelled = false;
    const count = Math.max(1, Math.round(wq / 72));
    const slot = wq / count;
    const range = Math.max(0.001, outPoint - inPoint);
    const reqs = Array.from({ length: count }, (_, i) => ({
      left: i * slot,
      sourceTime: inPoint + ((i + 0.5) / count) * range,
    }));

    // Seed synchronously from cache so cached strips appear instantly.
    setThumbs(
      reqs
        .map((r) => ({ left: r.left, width: slot, url: getCachedThumb(sourceId, r.sourceTime) }))
        .filter((t): t is Thumb => t.url !== null),
    );

    (async () => {
      const acc: Thumb[] = [];
      for (const r of reqs) {
        const url = await getThumb(sourceId, r.sourceTime);
        if (cancelled) return;
        if (url) {
          acc.push({ left: r.left, width: slot, url });
          setThumbs([...acc]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sourceId, inPoint, outPoint, wq]);

  return thumbs;
}

const PPS = 80; // pixels per second
const LANE_H = 72;
const GUTTER = 60; // left gutter reserved for sticky lane labels/controls

export function Timeline() {
  const {
    project,
    playhead,
    duration,
    seek,
    addTrack,
    endGesture,
  } = useEditor();

  const trackRef = useRef<HTMLDivElement>(null);
  const timeDisplayRef = useRef<HTMLSpanElement>(null);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  // True while the user is actively scrolling the timeline.
  const userScrollingRef = useRef(false);

  const [halfWidth, setHalfWidth] = useState(() =>
    typeof window !== 'undefined' ? Math.round(window.innerWidth / 2) : 300,
  );

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHalfWidth(Math.round(el.clientWidth / 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sync scroll when playhead changes externally (playback, seek button).
  // Skipped while the user is actively dragging so we don't fight their finger.
  useEffect(() => {
    if (userScrollingRef.current) return;
    const el = trackRef.current;
    if (!el) return;
    el.scrollLeft = playhead * PPS;
  }, [playhead]);

  // During scroll, update the time display directly in the DOM via rAF.
  // This gives live time feedback without triggering seek() or any video decode.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (userScrollingRef.current && timeDisplayRef.current && trackRef.current) {
        timeDisplayRef.current.textContent = formatTime(
          Math.max(0, trackRef.current.scrollLeft / PPS),
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Called once when scroll ends — ONE frame decode for the final position.
  const flushSeek = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const t = Math.max(0, Math.min(duration, el.scrollLeft / PPS));
    if (Math.abs(t - playheadRef.current) > 0.0005) seek(t);
  }, [duration, seek]);

  // User scroll: mark scrolling, schedule a single seek+decode on end.
  // Guard against programmatic scrollLeft updates (from playback) via position comparison.
  const handleScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    if (Math.round(el.scrollLeft) === Math.round(playheadRef.current * PPS)) return;
    userScrollingRef.current = true;
    if (scrollEndTimerRef.current) clearTimeout(scrollEndTimerRef.current);
    scrollEndTimerRef.current = setTimeout(() => {
      userScrollingRef.current = false;
      flushSeek();
      endGesture();
    }, 150);
  }, [flushSeek, endGesture]);

  // Desktop: convert mouse pointer drag to scroll (touch uses native scroll).
  const dragRef = useRef<{ startX: number; startScroll: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const target = e.target as HTMLElement;
    if (target.closest('.clip, .lane__btn, .lane__head, .cut')) return;
    dragRef.current = { startX: e.clientX, startScroll: trackRef.current?.scrollLeft ?? 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const el = trackRef.current;
    if (!el) return;
    el.scrollLeft = dragRef.current.startScroll - (e.clientX - dragRef.current.startX);
  }, []);

  const handlePointerUp = useCallback(() => { dragRef.current = null; }, []);

  const videoTracks = [...project.tracks].reverse();
  const paddingLeft = Math.max(0, halfWidth - GUTTER);
  const paddingRight = halfWidth;
  const contentWidth = GUTTER + Math.max(duration * PPS + 40, 600);

  return (
    <div className="timeline">
      <div className="timeline__meta">
        <span ref={timeDisplayRef}>{formatTime(playhead)}</span>
        <span className="timeline__sep">/</span>
        <span>{formatTime(duration)}</span>
        <button className="timeline__addtrack toolbar__icon-label" onClick={addTrack}>
          <Plus size={13} /> Pista
        </button>
        <span className="timeline__hint">
          {project.tracks.length} pista{project.tracks.length === 1 ? '' : 's'} ·{' '}
          {project.width}×{project.height} · {project.fps}fps
        </span>
      </div>

      <div className="timeline__body">
        {/* Playhead fixed at the visual center; the timeline scrolls under it */}
        <div className="timeline__playhead-center" />

        <div
          className="timeline__scroll"
          ref={trackRef}
          onScroll={handleScroll}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className="timeline__lanes"
            style={{ width: contentWidth, paddingLeft, paddingRight }}
          >
            {videoTracks.map((track) => (
              <TrackLane key={track.id} track={track} />
            ))}

            <TextLane overlays={project.overlays} />

            {project.music.length > 0 && <MusicLane />}

            {project.sfx.length > 0 && <SfxLane />}
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackLane({ track }: { track: Track }) {
  const {
    project,
    selectedClipId,
    selectedTransitionId,
    select,
    reorder,
    trim,
    moveClip,
    addTransitionAfter,
    selectTransition,
    importToTrack,
    deleteTrack,
    endGesture,
  } = useEditor();

  const importRef = useRef<HTMLInputElement>(null);
  const isBase = track.role === 'base';

  return (
    <div className={`lane${isBase ? ' lane--base' : ''}`} style={{ height: LANE_H }}>
      <div className="lane__head" onPointerDown={(e) => e.stopPropagation()}>
        <span className="lane__name">{isBase ? 'Base' : 'Overlay'}</span>
        {!isBase && (
          <>
            <button
              className="lane__btn"
              title="Importar video en esta pista (en el cursor)"
              onClick={() => importRef.current?.click()}
            >
              <Plus size={13} />
            </button>
            <button
              className="lane__btn"
              title="Eliminar pista"
              onClick={() => deleteTrack(track.id)}
            >
              <X size={13} />
            </button>
            <input
              ref={importRef}
              type="file"
              accept="video/*,image/*"
              hidden
              multiple
              onChange={(e) => {
                if (e.target.files?.length) importToTrack(track.id, e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      <div className="lane__clips">
        {track.clips.map((clip, index) => (
          <ClipBlock
            key={clip.id}
            clip={clip}
            index={index}
            count={track.clips.length}
            isBase={isBase}
            selected={clip.id === selectedClipId}
            sourceName={getMedia(clip.sourceId)?.meta.name ?? '(sin vincular)'}
            onSelect={() => select(clip.id)}
            onReorder={(to) => reorder(clip.id, to)}
            onMove={(newStart) => moveClip(clip.id, newStart)}
            onTrim={(edge, sourceTime) => trim(clip.id, edge, sourceTime)}
            onGestureEnd={endGesture}
          />
        ))}

        {isBase &&
          track.clips.slice(0, -1).map((clip) => {
            const tr = transitionAfterClip(project, clip.id);
            const x = GUTTER + clipEnd(clip) * PPS;
            return (
              <button
                key={`cut_${clip.id}`}
                className={`cut${tr ? ' cut--active' : ''}${
                  tr && tr.id === selectedTransitionId ? ' cut--selected' : ''
                }`}
                style={{ left: x }}
                title={tr ? `Transición: ${tr.kind} (${tr.durationSec}s)` : 'Añadir transición'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() =>
                  tr ? selectTransition(tr.id) : addTransitionAfter(clip.id, 'crossfade')
                }
              >
                {tr ? <ArrowLeftRight size={11} /> : <Plus size={11} />}
              </button>
            );
          })}
      </div>
    </div>
  );
}

type ClipProps = {
  clip: Clip;
  index: number;
  count: number;
  isBase: boolean;
  selected: boolean;
  sourceName: string;
  onSelect: () => void;
  onReorder: (toIndex: number) => void;
  onMove: (newStartSec: number) => void;
  onTrim: (edge: 'in' | 'out', sourceTime: number) => void;
  onGestureEnd: () => void;
};

function ClipBlock({
  clip,
  index,
  count,
  isBase,
  selected,
  sourceName,
  onSelect,
  onReorder,
  onMove,
  onTrim,
  onGestureEnd,
}: ClipProps) {
  const width = Math.max(clipDuration(clip) * PPS, 8);
  const left = GUTTER + clip.startInTimeline * PPS;
  const thumbs = useClipThumbnails(clip.sourceId, clip.inPoint, clip.outPoint, width);

  const startEdgeDrag = (edge: 'in' | 'out') => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const startX = e.clientX;
    const startIn = clip.inPoint;
    const startOut = clip.outPoint;
    const move = (ev: PointerEvent) => {
      const deltaSec = (ev.clientX - startX) / PPS;
      if (edge === 'in') onTrim('in', startIn + deltaSec);
      else onTrim('out', startOut + deltaSec);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onGestureEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Overlay clips: drag the body to move in time.
  const startBodyDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect();
    if (isBase) return; // base clips reorder via buttons, not free drag
    const startX = e.clientX;
    const startStart = clip.startInTimeline;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const deltaSec = (ev.clientX - startX) / PPS;
      if (Math.abs(deltaSec) > 0.01) moved = true;
      if (moved) onMove(Math.max(0, startStart + deltaSec));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onGestureEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`clip${selected ? ' clip--selected' : ''}${isBase ? '' : ' clip--overlay'}`}
      style={{ left, width }}
      onPointerDown={startBodyDrag}
      title={`${sourceName}\nin ${clip.inPoint.toFixed(2)}s · out ${clip.outPoint.toFixed(2)}s`}
    >
      {thumbs.length > 0 && (
        <div className="clip__thumbs" aria-hidden>
          {thumbs.map((t) => (
            <img key={t.left} src={t.url} style={{ left: t.left, width: t.width }} draggable={false} />
          ))}
        </div>
      )}
      <div className="clip__handle clip__handle--left" onPointerDown={startEdgeDrag('in')} />
      <div className="clip__body">
        <span className="clip__name">{sourceName}</span>
        <span className="clip__dur">{clipDuration(clip).toFixed(2)}s</span>
        {isBase && selected && (
          <div className="clip__reorder">
            <button
              disabled={index === 0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onReorder(index - 1)}
            >
              <ChevronLeft size={12} />
            </button>
            <button
              disabled={index === count - 1}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onReorder(index + 1)}
            >
              <ChevronRight size={12} />
            </button>
          </div>
        )}
      </div>
      <div className="clip__handle clip__handle--right" onPointerDown={startEdgeDrag('out')} />
    </div>
  );
}

function TextLane({ overlays }: { overlays: TextOverlay[] }) {
  const { selectedOverlayId, selectOverlay, patchOverlay, endGesture } = useEditor();
  return (
    <div className="lane lane--text" style={{ height: 40 }}>
      <div className="lane__head">
        <span className="lane__name">Texto</span>
      </div>
      <div className="lane__clips">
        {overlays.map((o) => (
          <OverlayBlock
            key={o.id}
            overlay={o}
            selected={o.id === selectedOverlayId}
            onSelect={() => selectOverlay(o.id)}
            onMove={(deltaSec) => {
              const len = o.endSec - o.startSec;
              const start = Math.max(0, o.startSec + deltaSec);
              const applied = start - o.startSec; // clamped delta actually applied
              patchOverlay(o.id, {
                startSec: start,
                endSec: start + len,
                words: o.words?.map((w) => ({
                  ...w,
                  start: w.start + applied,
                  end: w.end + applied,
                })),
              });
            }}
            onGestureEnd={endGesture}
          />
        ))}
      </div>
    </div>
  );
}

type OverlayProps = {
  overlay: TextOverlay;
  selected: boolean;
  onSelect: () => void;
  onMove: (deltaSec: number) => void;
  onGestureEnd: () => void;
};

function SfxLane() {
  const { project, selectedSfxId, selectSfx, patchSfx, endGesture } = useEditor();
  return (
    <div className="lane lane--sfx" style={{ height: 34 }}>
      <div className="lane__head" onPointerDown={(e) => e.stopPropagation()}>
        <span className="lane__name">SFX</span>
      </div>
      <div className="lane__clips">
        {project.sfx.map((s) => {
          const left = GUTTER + s.startSec * PPS;
          const width = Math.max(s.durationSec * PPS, 14);
          const label = s.synth ?? getMedia(s.sourceId ?? '')?.meta.name ?? 'sfx';
          const startDrag = (e: React.PointerEvent) => {
            e.stopPropagation();
            selectSfx(s.id);
            const startX = e.clientX;
            let last = 0;
            const move = (ev: PointerEvent) => {
              const d = (ev.clientX - startX) / PPS;
              patchSfx(s.id, { startSec: Math.max(0, s.startSec + (d - last)) });
              last = d;
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
            <div
              key={s.id}
              className={`sfx-block${s.id === selectedSfxId ? ' sfx-block--selected' : ''}`}
              style={{ left, width }}
              onPointerDown={startDrag}
              title={label}
            >
              <span className="sfx-block__label"><Volume2 size={11} /> {label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MusicLane() {
  const { project, duration, selectedMusicId, selectMusic, patchMusic, endGesture } = useEditor();
  return (
    <div className="lane lane--music" style={{ height: 40 }}>
      <div className="lane__head" onPointerDown={(e) => e.stopPropagation()}>
        <span className="lane__name">Música</span>
      </div>
      <div className="lane__clips">
        {project.music.map((m) => {
          const end = m.loop ? duration : m.startSec + (m.outPoint - m.inPoint);
          const left = GUTTER + m.startSec * PPS;
          const width = Math.max((end - m.startSec) * PPS, 8);
          return (
            <MusicBlock
              key={m.id}
              item={m}
              left={left}
              width={width}
              name={getMedia(m.sourceId)?.meta.name ?? 'audio'}
              selected={m.id === selectedMusicId}
              onSelect={() => selectMusic(m.id)}
              onMove={(deltaSec) =>
                patchMusic(m.id, { startSec: Math.max(0, m.startSec + deltaSec) })
              }
              onGestureEnd={endGesture}
            />
          );
        })}
      </div>
    </div>
  );
}

function MusicBlock({
  item,
  left,
  width,
  name,
  selected,
  onSelect,
  onMove,
  onGestureEnd,
}: {
  item: MusicItem;
  left: number;
  width: number;
  name: string;
  selected: boolean;
  onSelect: () => void;
  onMove: (deltaSec: number) => void;
  onGestureEnd: () => void;
}) {
  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect();
    const startX = e.clientX;
    let last = 0;
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) / PPS;
      onMove(delta - last);
      last = delta;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onGestureEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`music-block${selected ? ' music-block--selected' : ''}`}
      style={{ left, width }}
      onPointerDown={startDrag}
      title={name}
    >
      <span className="music-block__label">
        <Music size={11} /> {name}
        {item.loop ? ' (loop)' : ''}
      </span>
    </div>
  );
}

function OverlayBlock({ overlay, selected, onSelect, onMove, onGestureEnd }: OverlayProps) {
  const left = GUTTER + overlay.startSec * PPS;
  const width = Math.max((overlay.endSec - overlay.startSec) * PPS, 8);

  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect();
    const startX = e.clientX;
    let lastDelta = 0;
    const move = (ev: PointerEvent) => {
      const deltaSec = (ev.clientX - startX) / PPS;
      onMove(deltaSec - lastDelta);
      lastDelta = deltaSec;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onGestureEnd();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`overlay-block${selected ? ' overlay-block--selected' : ''}`}
      style={{ left, width }}
      onPointerDown={startDrag}
      title={overlay.text}
    >
      <span className="overlay-block__label">T {overlay.text}</span>
    </div>
  );
}

function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
}
