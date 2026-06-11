/**
 * Central editor store. Pure project mutations go through the timeline ops
 * (immutable); async side effects (import, save/load, export) are exposed as
 * methods on the context value.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Anim } from '../core/timeline/anim';
import type {
  ClipBackground,
  ClipFilters,
  ClipTransform,
  MusicItem,
  SfxItem,
  SpeedKey,
  Project,
  TextOverlay,
  Transition,
  TransitionKind,
} from '../core/timeline/types';
import {
  addMusic,
  addSynthSfx,
  addSampleSfx,
  updateSfx,
  removeSfx,
  addOverlay,
  addOverlayTrack,
  appendClipFromSource,
  createProject,
  deserializeProject,
  normalizeProject,
  moveClipStart,
  placeClipOnTrack,
  primaryTrack,
  patchAllCaptions,
  removeClip,
  removeMusic,
  removeOverlay,
  removeTrack,
  removeTransition,
  reorderClip,
  serializeProject,
  setCaptionOverlays,
  applySilenceCuts,
  setProjectFormat,
  setClipAnim,
  setClipAudio,
  setClipFilters,
  setClipFiltersAll,
  setClipFit,
  setClipBg,
  setClipRemoveBg,
  setClipSpeed,
  setClipSpeedCurve,
  setClipTransform,
  setTransitionAfter,
  splitAt,
  totalDuration,
  trimClip,
  updateMusic,
  updateOverlay,
  updateTransition,
} from '../core/timeline/project';
import { generateSubtitles, type SubtitleProgress } from '../core/ai/subtitles';
import { ensureSegmenter } from '../core/ai/segmentation';
import {
  analyzeBaseSilences,
  DEFAULT_SILENCE_OPTIONS,
  type SilenceOptions,
} from '../core/audio/silence';
import { getCachedTimelineAudio, timelineHasAudio } from '../core/media/audioTimeline';
import { pruneThumbnails } from '../core/media/thumbnails';
import {
  importFile,
  importAudio,
  importImage,
  relinkByName,
  isLinked,
  registerMediaForSource,
  clearRegistry,
  getMedia,
} from '../core/media/registry';
import {
  saveProject as persistProject,
  loadProject as loadPersistedProject,
  saveMediaBlob,
  loadMediaBlob,
  pruneMedia,
  clearAll as clearPersistence,
} from '../core/storage/persistence';

type State = {
  project: Project;
  selectedClipId: string | null;
  selectedOverlayId: string | null;
  selectedTransitionId: string | null;
  selectedMusicId: string | null;
  selectedSfxId: string | null;
  playhead: number;
  isPlaying: boolean;
  /** Non-null while a blocking media operation runs (import/restore/prepare). */
  status: string | null;
  /** Undo/redo history (project snapshots). */
  past: Project[];
  future: Project[];
  /** Key used to coalesce a continuous gesture (drag) into one history entry. */
  lastCoalesceKey: string | null;
};

type Action =
  | {
      type: 'project/set';
      project: Project;
      resetPlayhead?: boolean;
      /** Discrete edits push history; same coalesceKey merges into the last entry. */
      coalesceKey?: string;
      /** Reset history (load/new/restore) — not an undoable edit. */
      resetHistory?: boolean;
    }
  | { type: 'select'; clipId: string | null }
  | { type: 'selectOverlay'; overlayId: string | null }
  | { type: 'selectTransition'; transitionId: string | null }
  | { type: 'selectMusic'; musicId: string | null }
  | { type: 'selectSfx'; sfxId: string | null }
  | { type: 'playhead/set'; time: number }
  | { type: 'status/set'; status: string | null }
  | { type: 'history/undo' }
  | { type: 'history/redo' }
  | { type: 'history/seal' }
  | { type: 'play' }
  | { type: 'pause' };

const noSelection = {
  selectedClipId: null,
  selectedOverlayId: null,
  selectedTransitionId: null,
  selectedMusicId: null,
  selectedSfxId: null,
};
const HISTORY_LIMIT = 100;

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'project/set': {
      const playhead = action.resetPlayhead ? 0 : state.playhead;
      if (action.resetHistory) {
        return { ...state, project: action.project, playhead, past: [], future: [], lastCoalesceKey: null };
      }
      const key = action.coalesceKey ?? null;
      const canMerge = key !== null && key === state.lastCoalesceKey;
      if (canMerge) {
        // Same gesture: update present without adding a new history entry.
        return { ...state, project: action.project, playhead, future: [] };
      }
      const past = [...state.past, state.project].slice(-HISTORY_LIMIT);
      return { ...state, project: action.project, playhead, past, future: [], lastCoalesceKey: key };
    }
    case 'history/undo': {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        ...state,
        ...noSelection,
        project: prev,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, HISTORY_LIMIT),
        lastCoalesceKey: null,
      };
    }
    case 'history/redo': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ...state,
        ...noSelection,
        project: next,
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        lastCoalesceKey: null,
      };
    }
    case 'history/seal':
      return state.lastCoalesceKey === null ? state : { ...state, lastCoalesceKey: null };
    case 'select':
      return { ...state, ...noSelection, selectedClipId: action.clipId };
    case 'selectOverlay':
      return { ...state, ...noSelection, selectedOverlayId: action.overlayId };
    case 'selectTransition':
      return { ...state, ...noSelection, selectedTransitionId: action.transitionId };
    case 'selectMusic':
      return { ...state, ...noSelection, selectedMusicId: action.musicId };
    case 'selectSfx':
      return { ...state, ...noSelection, selectedSfxId: action.sfxId };
    case 'playhead/set':
      return { ...state, playhead: Math.max(0, action.time) };
    case 'status/set':
      return { ...state, status: action.status };
    case 'play':
      return { ...state, isPlaying: true };
    case 'pause':
      return { ...state, isPlaying: false };
  }
}

export type EditorApi = State & {
  duration: number;
  importFiles: (files: FileList | File[]) => Promise<{ unlinked: string[] }>;
  select: (clipId: string | null) => void;
  seek: (time: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  split: () => void;
  trimSelected: (edge: 'in' | 'out', sourceTime: number) => void;
  trim: (clipId: string, edge: 'in' | 'out', sourceTime: number) => void;
  removeSelected: () => void;
  reorder: (clipId: string, toIndex: number) => void;
  addText: () => void;
  removeSilences: (
    opts?: Partial<SilenceOptions>,
  ) => Promise<{ removedSec: number; removedCount: number }>;
  selectOverlay: (overlayId: string | null) => void;
  patchOverlay: (id: string, patch: Partial<TextOverlay>) => void;
  patchAllCaptions: (patch: Partial<TextOverlay>) => void;
  generateCaptions: (opts?: {
    language?: string;
    model?: string;
    onProgress?: (p: SubtitleProgress) => void;
    signal?: AbortSignal;
  }) => Promise<number>;
  addTransitionAfter: (clipId: string, kind?: TransitionKind) => void;
  selectTransition: (transitionId: string | null) => void;
  patchTransition: (id: string, patch: Partial<Transition>) => void;
  addTrack: () => void;
  deleteTrack: (trackId: string) => void;
  importToTrack: (trackId: string, files: FileList | File[]) => Promise<void>;
  moveClip: (clipId: string, newStartSec: number) => void;
  setClipAudio: (clipId: string, patch: { volume?: number; muted?: boolean }) => void;
  setClipTransform: (clipId: string, patch: Partial<ClipTransform>) => void;
  setClipAnim: (clipId: string, patch: { enter?: Anim; exit?: Anim }) => void;
  setClipSpeed: (clipId: string, speed: number) => void;
  setClipSpeedCurve: (clipId: string, keys: SpeedKey[]) => void;
  setClipFilters: (clipId: string, patch: Partial<ClipFilters>) => void;
  setClipFiltersAll: (clipId: string, filters: ClipFilters | undefined) => void;
  setClipFit: (clipId: string, fit: 'contain' | 'cover') => void;
  setClipBg: (clipId: string, bg: ClipBackground) => void;
  setClipRemoveBg: (clipId: string, removeBg: boolean) => void;
  setFormat: (width: number, height: number) => void;
  importMusic: (files: FileList | File[]) => Promise<void>;
  selectMusic: (musicId: string | null) => void;
  patchMusic: (id: string, patch: Partial<MusicItem>) => void;
  addSfx: (synth: string, durationSec: number) => void;
  importSfx: (files: FileList | File[]) => Promise<void>;
  selectSfx: (sfxId: string | null) => void;
  patchSfx: (id: string, patch: Partial<SfxItem>) => void;
  saveProject: () => void;
  loadProject: (file: File) => Promise<void>;
  newProject: () => Promise<void>;
  setStatus: (status: string | null) => void;
  undo: () => void;
  redo: () => void;
  /** Seal the current gesture so the next edit starts a new undo entry. */
  endGesture: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSourceLinked: (sourceId: string) => boolean;
};

const EditorContext = createContext<EditorApi | null>(null);

/** Import a file picking the loader by MIME type (image vs video). */
function importByType(file: File): Promise<import('../core/timeline/types').SourceMeta> {
  return file.type.startsWith('image/') ? importImage(file) : importFile(file);
}

/** Decode the first frame so the preview is instant once import finishes. */
async function warmFirstFrame(sourceId: string): Promise<void> {
  const media = getMedia(sourceId);
  if (!media?.sink) return;
  try {
    await media.sink.getCanvas(0);
  } catch {
    /* decoder warm-up best effort */
  }
}

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    project: createProject(),
    selectedClipId: null,
    selectedOverlayId: null,
    selectedTransitionId: null,
    selectedMusicId: null,
    selectedSfxId: null,
    playhead: 0,
    isPlaying: false,
    status: null,
    past: [],
    future: [],
    lastCoalesceKey: null,
  }));

  // Keep refs so stable async callbacks always see the latest state.
  const projectRef = useRef(state.project);
  projectRef.current = state.project;
  const stateRef = useRef(state);
  stateRef.current = state;

  const [, force] = useState(0);

  const importFiles = useCallback<EditorApi['importFiles']>(async (files) => {
    const list = Array.from(files);
    const unlinked: string[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const label = list.length > 1 ? `Procesando video ${i + 1}/${list.length}…` : 'Procesando video…';
        dispatch({ type: 'status/set', status: label });

        // Try to relink to an unlinked source from a loaded project first.
        const proj = projectRef.current;
        const unlinkedSources = proj.sources.filter((s) => !isLinked(s.id));
        const relinkedId = await relinkByName(file, unlinkedSources);
        if (relinkedId) {
          void saveMediaBlob(relinkedId, file);
          force((n) => n + 1); // media became available; trigger re-render
          continue;
        }
        const meta = await importByType(file);
        void saveMediaBlob(meta.id, file);
        if (meta.kind !== 'image') {
          dispatch({ type: 'status/set', status: 'Preparando primera imagen…' });
          await warmFirstFrame(meta.id);
        }
        dispatch({
          type: 'project/set',
          project: appendClipFromSource(projectRef.current, meta),
        });
      }
    } finally {
      dispatch({ type: 'status/set', status: null });
    }
    return { unlinked };
  }, []);

  const select = useCallback((clipId: string | null) => dispatch({ type: 'select', clipId }), []);
  const seek = useCallback((time: number) => dispatch({ type: 'playhead/set', time }), []);
  const play = useCallback(() => dispatch({ type: 'play' }), []);
  const pause = useCallback(() => dispatch({ type: 'pause' }), []);
  const togglePlay = useCallback(
    () => dispatch(projectRef.current && state.isPlaying ? { type: 'pause' } : { type: 'play' }),
    [state.isPlaying],
  );

  const split = useCallback(() => {
    const preferId = stateRef.current.selectedClipId ?? undefined;
    dispatch({ type: 'project/set', project: splitAt(projectRef.current, stateRef.current.playhead, preferId) });
  }, []);

  const trimSelected = useCallback<EditorApi['trimSelected']>(
    (edge, sourceTime) => {
      const id = stateRef.current.selectedClipId;
      if (!id) return;
      dispatch({ type: 'project/set', project: trimClip(projectRef.current, id, edge, sourceTime) });
    },
    [],
  );

  const trim = useCallback<EditorApi['trim']>((clipId, edge, sourceTime) => {
    dispatch({
      type: 'project/set',
      project: trimClip(projectRef.current, clipId, edge, sourceTime),
      coalesceKey: `trim:${clipId}:${edge}`,
    });
  }, []);

  const removeSelected = useCallback(() => {
    const { selectedClipId, selectedOverlayId, selectedTransitionId, selectedMusicId, selectedSfxId } =
      stateRef.current;
    if (selectedSfxId) {
      dispatch({ type: 'project/set', project: removeSfx(projectRef.current, selectedSfxId) });
      dispatch({ type: 'selectSfx', sfxId: null });
      return;
    }
    if (selectedMusicId) {
      dispatch({ type: 'project/set', project: removeMusic(projectRef.current, selectedMusicId) });
      dispatch({ type: 'selectMusic', musicId: null });
      return;
    }
    if (selectedTransitionId) {
      dispatch({ type: 'project/set', project: removeTransition(projectRef.current, selectedTransitionId) });
      dispatch({ type: 'selectTransition', transitionId: null });
      return;
    }
    if (selectedOverlayId) {
      dispatch({ type: 'project/set', project: removeOverlay(projectRef.current, selectedOverlayId) });
      dispatch({ type: 'selectOverlay', overlayId: null });
      return;
    }
    if (selectedClipId) {
      dispatch({ type: 'project/set', project: removeClip(projectRef.current, selectedClipId) });
      dispatch({ type: 'select', clipId: null });
    }
  }, []);

  const addTransitionAfter = useCallback<EditorApi['addTransitionAfter']>(
    (clipId, kind = 'crossfade') => {
      const project = setTransitionAfter(projectRef.current, clipId, kind);
      dispatch({ type: 'project/set', project });
      const created = project.transitions.find((t) => t.afterClipId === clipId);
      if (created) dispatch({ type: 'selectTransition', transitionId: created.id });
    },
    [],
  );

  const selectTransition = useCallback(
    (transitionId: string | null) => dispatch({ type: 'selectTransition', transitionId }),
    [],
  );

  const patchTransition = useCallback<EditorApi['patchTransition']>((id, patch) => {
    dispatch({
      type: 'project/set',
      project: updateTransition(projectRef.current, id, patch),
      coalesceKey: `transition:${id}`,
    });
  }, []);

  const addTrack = useCallback(() => {
    const { project } = addOverlayTrack(projectRef.current);
    dispatch({ type: 'project/set', project });
  }, []);

  const deleteTrack = useCallback<EditorApi['deleteTrack']>((trackId) => {
    dispatch({ type: 'project/set', project: removeTrack(projectRef.current, trackId) });
  }, []);

  const importToTrack = useCallback<EditorApi['importToTrack']>(async (trackId, files) => {
    const at = stateRef.current.playhead;
    try {
      for (const file of Array.from(files)) {
        dispatch({ type: 'status/set', status: 'Procesando media…' });
        const meta = await importByType(file);
        void saveMediaBlob(meta.id, file);
        dispatch({
          type: 'project/set',
          project: placeClipOnTrack(projectRef.current, trackId, meta, at),
        });
      }
    } finally {
      dispatch({ type: 'status/set', status: null });
    }
  }, []);

  const moveClip = useCallback<EditorApi['moveClip']>((clipId, newStartSec) => {
    dispatch({
      type: 'project/set',
      project: moveClipStart(projectRef.current, clipId, newStartSec),
      coalesceKey: `move:${clipId}`,
    });
  }, []);

  const setClipAudioCb = useCallback<EditorApi['setClipAudio']>((clipId, patch) => {
    dispatch({
      type: 'project/set',
      project: setClipAudio(projectRef.current, clipId, patch),
      coalesceKey: `clipaudio:${clipId}`,
    });
  }, []);

  const setClipTransformCb = useCallback<EditorApi['setClipTransform']>((clipId, patch) => {
    dispatch({
      type: 'project/set',
      project: setClipTransform(projectRef.current, clipId, patch),
      coalesceKey: `cliptransform:${clipId}`,
    });
  }, []);

  const setClipAnimCb = useCallback<EditorApi['setClipAnim']>((clipId, patch) => {
    dispatch({
      type: 'project/set',
      project: setClipAnim(projectRef.current, clipId, patch),
      coalesceKey: `clipanim:${clipId}`,
    });
  }, []);

  const setClipSpeedCb = useCallback<EditorApi['setClipSpeed']>((clipId, speed) => {
    dispatch({
      type: 'project/set',
      project: setClipSpeed(projectRef.current, clipId, speed),
      coalesceKey: `clipspeed:${clipId}`,
    });
  }, []);

  const setClipSpeedCurveCb = useCallback<EditorApi['setClipSpeedCurve']>((clipId, keys) => {
    dispatch({
      type: 'project/set',
      project: setClipSpeedCurve(projectRef.current, clipId, keys),
      coalesceKey: `clipcurve:${clipId}`,
    });
  }, []);

  const setClipFiltersCb = useCallback<EditorApi['setClipFilters']>((clipId, patch) => {
    dispatch({
      type: 'project/set',
      project: setClipFilters(projectRef.current, clipId, patch),
      coalesceKey: `clipfilters:${clipId}`,
    });
  }, []);

  const setClipFiltersAllCb = useCallback<EditorApi['setClipFiltersAll']>((clipId, filters) => {
    dispatch({
      type: 'project/set',
      project: setClipFiltersAll(projectRef.current, clipId, filters),
    });
  }, []);

  const setClipFitCb = useCallback<EditorApi['setClipFit']>((clipId, fit) => {
    dispatch({ type: 'project/set', project: setClipFit(projectRef.current, clipId, fit) });
  }, []);

  const setClipBgCb = useCallback<EditorApi['setClipBg']>((clipId, bg) => {
    dispatch({ type: 'project/set', project: setClipBg(projectRef.current, clipId, bg) });
  }, []);

  const setClipRemoveBgCb = useCallback<EditorApi['setClipRemoveBg']>((clipId, removeBg) => {
    if (removeBg) {
      // Preload the segmentation model so the first frame is not a long stall.
      dispatch({ type: 'status/set', status: 'Cargando IA de fondo…' });
      void ensureSegmenter()
        .catch(() => {})
        .finally(() => dispatch({ type: 'status/set', status: null }));
    }
    dispatch({ type: 'project/set', project: setClipRemoveBg(projectRef.current, clipId, removeBg) });
  }, []);

  const setFormat = useCallback<EditorApi['setFormat']>((width, height) => {
    dispatch({ type: 'project/set', project: setProjectFormat(projectRef.current, width, height) });
  }, []);

  const importMusic = useCallback<EditorApi['importMusic']>(async (files) => {
    try {
      for (const file of Array.from(files)) {
        dispatch({ type: 'status/set', status: 'Procesando audio…' });
        const meta = await importAudio(file);
        void saveMediaBlob(meta.id, file);
        const { project, id } = addMusic(projectRef.current, meta, 0);
        dispatch({ type: 'project/set', project });
        dispatch({ type: 'selectMusic', musicId: id });
      }
    } catch (e) {
      alert(`Error al importar audio: ${(e as Error).message}`);
    } finally {
      dispatch({ type: 'status/set', status: null });
    }
  }, []);

  const selectMusic = useCallback(
    (musicId: string | null) => dispatch({ type: 'selectMusic', musicId }),
    [],
  );

  const patchMusic = useCallback<EditorApi['patchMusic']>((id, patch) => {
    dispatch({
      type: 'project/set',
      project: updateMusic(projectRef.current, id, patch),
      coalesceKey: `music:${id}`,
    });
  }, []);

  const addSfx = useCallback<EditorApi['addSfx']>((synth, durationSec) => {
    const { project, id } = addSynthSfx(projectRef.current, synth, stateRef.current.playhead, durationSec);
    dispatch({ type: 'project/set', project });
    dispatch({ type: 'selectSfx', sfxId: id });
  }, []);

  const importSfx = useCallback<EditorApi['importSfx']>(async (files) => {
    const at = stateRef.current.playhead;
    try {
      for (const file of Array.from(files)) {
        dispatch({ type: 'status/set', status: 'Procesando audio…' });
        const meta = await importAudio(file);
        void saveMediaBlob(meta.id, file);
        const { project, id } = addSampleSfx(projectRef.current, meta, at);
        dispatch({ type: 'project/set', project });
        dispatch({ type: 'selectSfx', sfxId: id });
      }
    } catch (e) {
      alert(`Error al importar SFX: ${(e as Error).message}`);
    } finally {
      dispatch({ type: 'status/set', status: null });
    }
  }, []);

  const selectSfx = useCallback((sfxId: string | null) => dispatch({ type: 'selectSfx', sfxId }), []);

  const patchSfx = useCallback<EditorApi['patchSfx']>((id, patch) => {
    dispatch({
      type: 'project/set',
      project: updateSfx(projectRef.current, id, patch),
      coalesceKey: `sfx:${id}`,
    });
  }, []);

  const addText = useCallback(() => {
    const { project, id } = addOverlay(projectRef.current, stateRef.current.playhead);
    dispatch({ type: 'project/set', project });
    dispatch({ type: 'selectOverlay', overlayId: id });
  }, []);

  const selectOverlay = useCallback(
    (overlayId: string | null) => dispatch({ type: 'selectOverlay', overlayId }),
    [],
  );

  const patchOverlay = useCallback<EditorApi['patchOverlay']>((id, patch) => {
    dispatch({
      type: 'project/set',
      project: updateOverlay(projectRef.current, id, patch),
      coalesceKey: `overlay:${id}`,
    });
  }, []);

  const patchAllCaptionsCb = useCallback<EditorApi['patchAllCaptions']>((patch) => {
    dispatch({
      type: 'project/set',
      project: patchAllCaptions(projectRef.current, patch),
      coalesceKey: 'captions:all',
    });
  }, []);

  const removeSilences = useCallback<EditorApi['removeSilences']>(async (opts) => {
    const options: SilenceOptions = { ...DEFAULT_SILENCE_OPTIONS, ...opts };
    dispatch({ type: 'status/set', status: 'Analizando silencios…' });
    try {
      const result = await analyzeBaseSilences(projectRef.current, options);
      if (result.cuts.length > 0) {
        dispatch({ type: 'project/set', project: applySilenceCuts(projectRef.current, result.cuts) });
      }
      return { removedSec: result.removedSec, removedCount: result.removedCount };
    } finally {
      dispatch({ type: 'status/set', status: null });
    }
  }, []);

  const generateCaptions = useCallback<EditorApi['generateCaptions']>(async (opts) => {
    const segments = await generateSubtitles(projectRef.current, opts);
    dispatch({ type: 'project/set', project: setCaptionOverlays(projectRef.current, segments) });
    return segments.length;
  }, []);

  const reorder = useCallback<EditorApi['reorder']>((clipId, toIndex) => {
    dispatch({ type: 'project/set', project: reorderClip(projectRef.current, clipId, toIndex) });
  }, []);

  const saveProject = useCallback(() => {
    const json = serializeProject(projectRef.current);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectRef.current.name.replace(/[^\w.-]+/g, '_') || 'proyecto'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const loadProject = useCallback<EditorApi['loadProject']>(async (file) => {
    const text = await file.text();
    const project = deserializeProject(text);
    dispatch({ type: 'project/set', project, resetPlayhead: true, resetHistory: true });
    dispatch({ type: 'select', clipId: null });
  }, []);

  const setStatus = useCallback((s: string | null) => dispatch({ type: 'status/set', status: s }), []);

  const undo = useCallback(() => dispatch({ type: 'history/undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'history/redo' }), []);
  const endGesture = useCallback(() => dispatch({ type: 'history/seal' }), []);

  const newProject = useCallback(async () => {
    clearRegistry();
    await clearPersistence();
    dispatch({ type: 'project/set', project: createProject(), resetPlayhead: true, resetHistory: true });
    dispatch({ type: 'select', clipId: null });
  }, []);

  // ---- Restore a persisted session on first mount ----
  const restoreStartedRef = useRef(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restoreStartedRef.current) return; // guard StrictMode double-invoke
    restoreStartedRef.current = true;
    (async () => {
      try {
        const rawSaved = await loadPersistedProject();
        const saved = rawSaved ? normalizeProject(rawSaved) : null;
        if (saved) {
          if (saved.sources.length > 0) {
            dispatch({ type: 'status/set', status: 'Restaurando sesión…' });
            // Re-link each source's media blob from IndexedDB.
            await Promise.all(
              saved.sources.map(async (s) => {
                const blob = await loadMediaBlob(s.id);
                if (!blob) return;
                try {
                  const kind = s.kind ?? (s.width === 0 && s.height === 0 ? 'audio' : 'video');
                  await registerMediaForSource(s.id, blob, kind);
                } catch {
                  /* corrupt/undecodable blob — leave the source unlinked */
                }
              }),
            );
          }
          dispatch({ type: 'project/set', project: saved, resetPlayhead: true, resetHistory: true });
          force((n) => n + 1);
        }
      } finally {
        dispatch({ type: 'status/set', status: null });
        // Only now is auto-save allowed, so we never overwrite a saved session
        // with the empty initial project before restore completes.
        setRestored(true);
      }
    })();
  }, []);

  // ---- Auto-save the project (debounced) once restore has completed ----
  useEffect(() => {
    if (!restored) return;
    const handle = setTimeout(() => {
      void persistProject(state.project);
      const ids = state.project.sources.map((s) => s.id);
      void pruneMedia(ids);
      pruneThumbnails(ids);
    }, 600);
    return () => clearTimeout(handle);
  }, [state.project, restored]);

  // ---- Warm the timeline audio in the background so play starts instantly ----
  useEffect(() => {
    if (!restored || state.isPlaying) return;
    if (!timelineHasAudio(state.project)) return;
    const handle = setTimeout(() => {
      void getCachedTimelineAudio(projectRef.current);
    }, 700);
    return () => clearTimeout(handle);
  }, [state.project, restored, state.isPlaying]);

  const value = useMemo<EditorApi>(
    () => ({
      ...state,
      duration: totalDuration(state.project),
      importFiles,
      select,
      seek,
      play,
      pause,
      togglePlay,
      split,
      trimSelected,
      trim,
      removeSelected,
      reorder,
      addText,
      removeSilences,
      selectOverlay,
      patchOverlay,
      patchAllCaptions: patchAllCaptionsCb,
      generateCaptions,
      addTransitionAfter,
      selectTransition,
      patchTransition,
      addTrack,
      deleteTrack,
      importToTrack,
      moveClip,
      setClipAudio: setClipAudioCb,
      setClipTransform: setClipTransformCb,
      setClipAnim: setClipAnimCb,
      setClipSpeed: setClipSpeedCb,
      setClipSpeedCurve: setClipSpeedCurveCb,
      setClipFilters: setClipFiltersCb,
      setClipFiltersAll: setClipFiltersAllCb,
      setClipFit: setClipFitCb,
      setClipBg: setClipBgCb,
      setClipRemoveBg: setClipRemoveBgCb,
      setFormat,
      importMusic,
      selectMusic,
      patchMusic,
      addSfx,
      importSfx,
      selectSfx,
      patchSfx,
      saveProject,
      loadProject,
      newProject,
      setStatus,
      undo,
      redo,
      endGesture,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      isSourceLinked: isLinked,
    }),
    [
      state,
      importFiles,
      select,
      seek,
      play,
      pause,
      togglePlay,
      split,
      trimSelected,
      trim,
      removeSelected,
      reorder,
      addText,
      removeSilences,
      selectOverlay,
      patchOverlay,
      patchAllCaptionsCb,
      generateCaptions,
      addTransitionAfter,
      selectTransition,
      patchTransition,
      addTrack,
      deleteTrack,
      importToTrack,
      moveClip,
      setClipAudioCb,
      setClipTransformCb,
      setClipAnimCb,
      setClipSpeedCb,
      setClipSpeedCurveCb,
      setClipFiltersCb,
      setClipFiltersAllCb,
      setClipFitCb,
      setClipBgCb,
      setClipRemoveBgCb,
      setFormat,
      importMusic,
      selectMusic,
      patchMusic,
      addSfx,
      importSfx,
      selectSfx,
      patchSfx,
      saveProject,
      loadProject,
      newProject,
      setStatus,
      undo,
      redo,
      endGesture,
    ],
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorApi {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor debe usarse dentro de <EditorProvider>.');
  return ctx;
}

export const trackClips = (project: Project) => primaryTrack(project).clips;
