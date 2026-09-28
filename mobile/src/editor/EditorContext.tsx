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
  addOverlay,
  appendClipFromSource,
  createProject,
  primaryTrack,
  removeClip,
  removeOverlay,
  setClipAudio,
  setClipFit,
  setClipSpeed,
  setProjectFormat,
  splitAt,
  totalDuration,
  trimClip,
  updateOverlay,
} from '@timeline/project';
import type { Project, TextOverlay } from '@timeline/types';
import type { VideoEngineViewRef } from '../../modules/video-engine';
import { toEngineComposition } from '../engine/composition';
import { clockTime, syncClock } from '../engine/playbackClock';
import { mediaUri, pickAndImportVideos, pruneMedia, type MediaFiles } from '../media/mediaLibrary';
import { loadState, saveState } from './persistence';

export type Selection = { kind: 'clip'; id: string } | { kind: 'text'; id: string } | null;

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
        const used = new Set(primaryTrack(saved.project).clips.map((c) => c.sourceId));
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
    if (selection.kind === 'clip') apply((p) => removeClip(p, selection.id));
    else apply((p) => removeOverlay(p, selection.id));
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

export function useEditor(): EditorValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor must be used inside <EditorProvider>');
  return ctx;
}
