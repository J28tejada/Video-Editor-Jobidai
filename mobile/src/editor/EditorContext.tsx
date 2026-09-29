/**
 * Editor state: the project (shared timeline model from the web editor),
 * undo/redo history, selection, and a handle on the native engine.
 *
 * Every edit is a pure function from `@timeline/project` applied here, so the
 * mobile and web editors share one set of timeline semantics.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import {
  addMusic,
  addOverlay,
  addSampleSfx,
  addSynthSfx,
  appendClipFromSource,
  createProject,
  primaryTrack,
  removeClip,
  removeMusic,
  removeOverlay,
  removeSfx,
  removeTransition,
  setClipFilters,
  setClipFiltersAll,
  setClipTransform,
  setTransitionAfter,
  transitionAfterClip,
  updateTransition,
  setClipAudio,
  setClipFit,
  setClipSpeed,
  setProjectFormat,
  splitAt,
  totalDuration,
  trimClip,
  updateMusic,
  updateOverlay,
  updateSfx,
} from '@timeline/project';
import { synthDuration } from '@audio/sfxList';
import type {
  ClipFilters,
  ClipTransform,
  MusicItem,
  Project,
  SfxItem,
  TextOverlay,
  Transition,
} from '@timeline/types';
import type { VideoEngineViewRef } from '../../modules/video-engine';
import { toEngineComposition } from '../engine/composition';
import { clockTime, syncClock } from '../engine/playbackClock';
import {
  mediaUri,
  pickAndImportAudio,
  pickAndImportVideos,
  pruneMedia,
  type ImportedMedia,
  type MediaFiles,
} from '../media/mediaLibrary';
import { loadState, saveState } from './persistence';

export type Selection = {
  kind: 'clip' | 'text' | 'music' | 'sfx' | 'transition';
  id: string;
} | null;

type History = { past: Project[]; present: Project; future: Project[]; coalesceKey: string | null };

const HISTORY_LIMIT = 100;

type EditorValue = {
  ready: boolean;
  project: Project;
  duration: number;
  /** Engine description for the live preview (texts are drawn by RN on top). */
  previewJSON: string;
  /** Full description for export: clips plus burned-in texts. */
  exportJSON: () => string;
  resolveUri: (sourceId: string) => string | null;

  selection: Selection;
  select: (sel: Selection) => void;

  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  importVideos: () => Promise<number>;
  split: () => void;
  removeSelected: () => void;
  trim: (clipId: string, edge: 'in' | 'out', sourceTime: number) => void;
  setSpeed: (clipId: string, speed: number) => void;
  setVolume: (clipId: string, volume: number) => void;
  setFit: (clipId: string, fit: 'contain' | 'cover') => void;
  addText: () => void;
  patchText: (id: string, patch: Partial<TextOverlay>) => void;
  setFormat: (width: number, height: number) => void;
  newProject: () => void;

  /** Returns false when the user cancelled the picker. */
  importMusic: () => Promise<boolean>;
  importSfx: () => Promise<boolean>;
  addBuiltInSfx: (name: string) => void;
  patchMusic: (id: string, patch: Partial<MusicItem>) => void;
  patchSfx: (id: string, patch: Partial<SfxItem>) => void;
  /** Move the selected music / effect so it starts at the playhead. */
  moveSelectedToPlayhead: () => void;

  setFilters: (clipId: string, patch: Partial<ClipFilters>) => void;
  /** Replace all filters (presets / reset). */
  setAllFilters: (clipId: string, filters: ClipFilters | undefined) => void;
  setZoom: (clipId: string, patch: Partial<ClipTransform>) => void;
  /** Select the transition after a clip, creating a crossfade if none. */
  openTransitionAfter: (clipId: string) => void;
  patchTransition: (id: string, patch: Partial<Transition>) => void;

  engineRef: RefObject<VideoEngineViewRef | null>;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  /** Seek the preview. `exact` for final positions, false while scrubbing. */
  seek: (time: number, exact: boolean) => void;
};

const EditorContext = createContext<EditorValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState<History>(() => ({
    past: [],
    present: createProject(),
    future: [],
    coalesceKey: null,
  }));
  const [media, setMedia] = useState<MediaFiles>({});
  const [selection, setSelection] = useState<Selection>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const engineRef = useRef<VideoEngineViewRef | null>(null);

  const project = history.present;

  // ---- Load / save ----

  useEffect(() => {
    (async () => {
      const saved = await loadState();
      if (saved) {
        // Drop media no clip references any more (history starts empty here).
        const used = new Set([
          ...primaryTrack(saved.project).clips.map((c) => c.sourceId),
          ...saved.project.music.map((m) => m.sourceId),
          ...saved.project.sfx.flatMap((s) => (s.sourceId ? [s.sourceId] : [])),
        ]);
        const kept: MediaFiles = {};
        for (const [id, file] of Object.entries(saved.media)) if (used.has(id)) kept[id] = file;
        pruneMedia(kept);
        setMedia(kept);
        setHistory({ past: [], present: saved.project, future: [], coalesceKey: null });
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => saveState({ project, media }), 400);
    return () => clearTimeout(t);
  }, [ready, project, media]);

  // ---- History ----

  /**
   * Apply an edit. Edits sharing a `coalesceKey` (e.g. typing into one text)
   * collapse into a single undo step.
   */
  const apply = useCallback((fn: (p: Project) => Project, coalesceKey: string | null = null) => {
    setHistory((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      if (coalesceKey && coalesceKey === h.coalesceKey) {
        return { ...h, present: next };
      }
      return {
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        coalesceKey,
      };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((h) =>
      h.past.length === 0
        ? h
        : {
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future],
            coalesceKey: null,
          },
    );
  }, []);

  const redo = useCallback(() => {
    setHistory((h) =>
      h.future.length === 0
        ? h
        : {
            past: [...h.past, h.present],
            present: h.future[0],
            future: h.future.slice(1),
            coalesceKey: null,
          },
    );
  }, []);

  // ---- Engine ----

  const resolveUri = useCallback(
    (sourceId: string) => (media[sourceId] ? mediaUri(media[sourceId]) : null),
    [media],
  );

  const duration = useMemo(() => totalDuration(project), [project]);

  // The preview only depends on clips and format, so editing texts never makes
  // the native engine rebuild its composition.
  const previewJSON = useMemo(() => {
    const { texts: _texts, ...rest } = toEngineComposition(project, resolveUri);
    return JSON.stringify({ ...rest, texts: [] });
  }, [project, resolveUri]);

  const exportJSON = useCallback(
    () => JSON.stringify(toEngineComposition(project, resolveUri)),
    [project, resolveUri],
  );

  const play = useCallback(() => {
    setIsPlaying(true);
    engineRef.current?.play();
  }, []);

  const pause = useCallback(() => {
    setIsPlaying(false);
    engineRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  const seek = useCallback(
    (time: number, exact: boolean) => {
      const t = Math.max(0, Math.min(time, duration));
      syncClock(t, false);
      engineRef.current?.seek(t, exact);
    },
    [duration],
  );

  // ---- Edits ----

  const importVideos = useCallback(async () => {
    const imported = await pickAndImportVideos();
    if (imported.length === 0) return 0;
    setMedia((m) => {
      const next = { ...m };
      for (const i of imported) next[i.meta.id] = i.fileName;
      return next;
    });
    apply((p) => imported.reduce((acc, i) => appendClipFromSource(acc, i.meta), p));
    return imported.length;
  }, [apply]);

  const split = useCallback(() => {
    const t = clockTime();
    const clipId = selection?.kind === 'clip' ? selection.id : undefined;
    apply((p) => splitAt(p, t, clipId));
  }, [apply, selection]);

  const removeSelected = useCallback(() => {
    if (!selection) return;
    const { kind, id } = selection;
    apply((p) =>
      kind === 'clip'
        ? removeClip(p, id)
        : kind === 'text'
          ? removeOverlay(p, id)
          : kind === 'music'
            ? removeMusic(p, id)
            : kind === 'sfx'
              ? removeSfx(p, id)
              : removeTransition(p, id),
    );
    setSelection(null);
  }, [apply, selection]);

  const trim = useCallback(
    (clipId: string, edge: 'in' | 'out', sourceTime: number) =>
      apply((p) => trimClip(p, clipId, edge, sourceTime)),
    [apply],
  );

  const setSpeed = useCallback(
    (clipId: string, speed: number) => apply((p) => setClipSpeed(p, clipId, speed)),
    [apply],
  );

  const setVolume = useCallback(
    (clipId: string, volume: number) =>
      apply((p) => setClipAudio(p, clipId, { volume, muted: volume === 0 })),
    [apply],
  );

  const setFit = useCallback(
    (clipId: string, fit: 'contain' | 'cover') => apply((p) => setClipFit(p, clipId, fit)),
    [apply],
  );

  const addText = useCallback(() => {
    // Build the overlay once (its id must be known to select it), then add it.
    const created = addOverlay(project, clockTime());
    const overlay = created.project.overlays.find((o) => o.id === created.id);
    if (!overlay) return;
    apply((p) => ({ ...p, overlays: [...p.overlays, overlay] }));
    setSelection({ kind: 'text', id: overlay.id });
  }, [apply, project]);

  const patchText = useCallback(
    (id: string, patch: Partial<TextOverlay>) =>
      apply((p) => updateOverlay(p, id, patch), `text:${id}:${Object.keys(patch).join(',')}`),
    [apply],
  );

  const setFormat = useCallback(
    (width: number, height: number) => apply((p) => setProjectFormat(p, width, height)),
    [apply],
  );

  // ---- Music & sound effects ----

  const registerMedia = useCallback((m: ImportedMedia) => {
    setMedia((prev) => ({ ...prev, [m.meta.id]: m.fileName }));
  }, []);

  const importMusic = useCallback(async () => {
    const m = await pickAndImportAudio();
    if (!m) return false;
    registerMedia(m);
    // Music starts at 0 and loops under the whole video by default.
    const created = addMusic(project, m.meta, 0);
    const item = created.project.music.find((x) => x.id === created.id);
    if (!item) return false;
    apply((p) => ({ ...p, sources: withSource(p, m), music: [...p.music, item] }));
    setSelection({ kind: 'music', id: item.id });
    return true;
  }, [apply, project, registerMedia]);

  const importSfx = useCallback(async () => {
    const m = await pickAndImportAudio();
    if (!m) return false;
    registerMedia(m);
    const created = addSampleSfx(project, m.meta, clockTime());
    const item = created.project.sfx.find((x) => x.id === created.id);
    if (!item) return false;
    apply((p) => ({ ...p, sources: withSource(p, m), sfx: [...p.sfx, item] }));
    setSelection({ kind: 'sfx', id: item.id });
    return true;
  }, [apply, project, registerMedia]);

  const addBuiltInSfx = useCallback(
    (name: string) => {
      const created = addSynthSfx(project, name, clockTime(), synthDuration(name));
      const item = created.project.sfx.find((x) => x.id === created.id);
      if (!item) return;
      apply((p) => ({ ...p, sfx: [...p.sfx, item] }));
      setSelection({ kind: 'sfx', id: item.id });
    },
    [apply, project],
  );

  const patchMusic = useCallback(
    (id: string, patch: Partial<MusicItem>) => apply((p) => updateMusic(p, id, patch)),
    [apply],
  );

  const patchSfx = useCallback(
    (id: string, patch: Partial<SfxItem>) => apply((p) => updateSfx(p, id, patch)),
    [apply],
  );

  const moveSelectedToPlayhead = useCallback(() => {
    if (!selection) return;
    const t = clockTime();
    if (selection.kind === 'music') apply((p) => updateMusic(p, selection.id, { startSec: t }));
    else if (selection.kind === 'sfx') apply((p) => updateSfx(p, selection.id, { startSec: t }));
  }, [apply, selection]);

  // ---- Look: color, zoom, transitions ----

  const setFilters = useCallback(
    (clipId: string, patch: Partial<ClipFilters>) =>
      apply((p) => setClipFilters(p, clipId, patch), `filters:${clipId}`),
    [apply],
  );

  const setAllFilters = useCallback(
    (clipId: string, filters: ClipFilters | undefined) =>
      apply((p) => setClipFiltersAll(p, clipId, filters)),
    [apply],
  );

  const setZoom = useCallback(
    (clipId: string, patch: Partial<ClipTransform>) =>
      apply((p) => setClipTransform(p, clipId, patch)),
    [apply],
  );

  const openTransitionAfter = useCallback(
    (clipId: string) => {
      const existing = transitionAfterClip(project, clipId);
      if (existing) {
        setSelection({ kind: 'transition', id: existing.id });
        return;
      }
      const next = setTransitionAfter(project, clipId, 'crossfade', 0.5);
      const created = transitionAfterClip(next, clipId);
      if (!created) return;
      apply((p) => ({
        ...p,
        transitions: [...p.transitions.filter((t) => t.afterClipId !== clipId), created],
      }));
      setSelection({ kind: 'transition', id: created.id });
    },
    [apply, project],
  );

  const patchTransition = useCallback(
    (id: string, patch: Partial<Transition>) => apply((p) => updateTransition(p, id, patch)),
    [apply],
  );

  const newProject = useCallback(() => {
    pause();
    setSelection(null);
    setMedia({});
    pruneMedia({});
    setHistory({ past: [], present: createProject(), future: [], coalesceKey: null });
  }, [pause]);

  const value: EditorValue = {
    ready,
    project,
    duration,
    previewJSON,
    exportJSON,
    resolveUri,
    selection,
    select: setSelection,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo,
    redo,
    importVideos,
    split,
    removeSelected,
    trim,
    setSpeed,
    setVolume,
    setFit,
    addText,
    patchText,
    setFormat,
    newProject,
    importMusic,
    importSfx,
    addBuiltInSfx,
    patchMusic,
    patchSfx,
    moveSelectedToPlayhead,
    setFilters,
    setAllFilters,
    setZoom,
    openTransitionAfter,
    patchTransition,
    engineRef,
    isPlaying,
    setIsPlaying,
    play,
    pause,
    togglePlay,
    seek,
  };

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

const withSource = (p: Project, m: ImportedMedia) =>
  p.sources.some((s) => s.id === m.meta.id) ? p.sources : [...p.sources, m.meta];

export function useEditor(): EditorValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor must be used inside <EditorProvider>');
  return ctx;
}
