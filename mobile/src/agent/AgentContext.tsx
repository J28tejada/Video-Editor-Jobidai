/**
 * The editing agent in the app: conversation state, the loop runner wired to
 * the editor, device tools (captions, silences) and undoable change cards.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { describeProject, type SourceIndex } from '@agent/context';
import { runAgent, type AgentEvent, type DeviceTool } from '@agent/loop';
import type { AgentMessage } from '@agent/protocol';
import { groupWords } from '@ai/captionLines';
import { reframeKeys, setTransformKeys, snapCutsToBeats } from '@agent/editOps';
import {
  beatsOnTimeline,
  detectBeats,
  suggestEdits,
  timelineWords,
  type Suggestion,
} from '@agent/understanding';
import { applySilenceCuts, primaryTrack, setCaptionOverlays, totalDuration } from '@timeline/project';
import type { Project } from '@timeline/types';
import VideoEngine from '../../modules/video-engine';
import { generateCaptions } from '../ai/captions';
import { ANALYSIS_RATE, decodeMono } from '../ai/pcm';
import { analyzeSilences, DEFAULT_SILENCE_OPTIONS, type SilenceOptions } from '../ai/silences';
import { isModelDownloaded } from '../ai/whisperModel';
import { analyzeSource } from '../analysis/analyze';
import { loadIndex, loadMemory, saveIndex, saveMemory } from '../analysis/indexStore';
import { useEditor } from '../editor/EditorContext';
import { clockTime } from '../engine/playbackClock';
import { sendTurn } from './client';
import { agentConfigured } from './config';

export type LogEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'changes'; id: string; lines: string[]; before: Project; undone: boolean }
  | { kind: 'error'; id: string; text: string };

type AgentValue = {
  configured: boolean;
  log: LogEntry[];
  /** What the agent is doing right now, or null when idle. */
  status: string | null;
  run: (text: string) => Promise<void>;
  cancel: () => void;
  undoCard: (id: string) => void;
  reset: () => void;
  /** Understanding index (transcripts, shots) per source. */
  index: SourceIndex[];
  /** Data-backed suggestions for the current project. */
  suggestions: Suggestion[];
  /** Analyze the timeline's sources that aren't analyzed yet. */
  analyze: () => Promise<void>;
  /** Remembered style / brand preferences. */
  memory: string[];
  forget: (index: number) => void;
};

const AgentContext = createContext<AgentValue | null>(null);

const INTENSITY: Record<string, SilenceOptions> = {
  soft: { ...DEFAULT_SILENCE_OPTIONS, thresholdDb: -45, minSilenceSec: 0.7 },
  normal: DEFAULT_SILENCE_OPTIONS,
  strong: { ...DEFAULT_SILENCE_OPTIONS, thresholdDb: -35, minSilenceSec: 0.25 },
};

const TOOL_LABELS: Record<string, string> = {
  generate_captions: 'Transcribiendo el audio…',
  remove_silences: 'Buscando silencios…',
  analyze_media: 'Analizando tus videos…',
  auto_reframe: 'Siguiendo a la persona en el cuadro…',
  sync_cuts_to_music: 'Buscando el ritmo de la música…',
};

let seq = 0;
const nextId = () => `e${Date.now().toString(36)}${seq++}`;

export function AgentProvider({ children }: { children: ReactNode }) {
  const { project, getProject, commitProject, selection, resolveUri, pause } = useEditor();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [index, setIndexState] = useState<SourceIndex[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const history = useRef<AgentMessage[]>([]);
  const indexRef = useRef<SourceIndex[]>([]);
  const [memory, setMemoryState] = useState<string[]>([]);
  const memoryRef = useRef<string[]>([]);

  useEffect(() => {
    loadIndex().then((loaded) => {
      indexRef.current = loaded;
      setIndexState(loaded);
    });
    loadMemory().then((loaded) => {
      memoryRef.current = loaded;
      setMemoryState(loaded);
    });
  }, []);

  const setMemory = useCallback((next: string[]) => {
    memoryRef.current = next;
    setMemoryState(next);
    saveMemory(next);
  }, []);

  const forget = useCallback(
    (i: number) => setMemory(memoryRef.current.filter((_, k) => k !== i)),
    [setMemory],
  );

  const updateIndex = useCallback((entries: SourceIndex[]) => {
    const merged = [
      ...indexRef.current.filter((i) => !entries.some((e) => e.sourceId === i.sourceId)),
      ...entries,
    ];
    indexRef.current = merged;
    setIndexState(merged);
    saveIndex(merged);
  }, []);

  /** Analyze base-track sources missing from the index. Returns how many. */
  const analyzeMissing = useCallback(
    async (p: Project, signal?: AbortSignal) => {
      // Timeline videos first, then library (B-roll) videos.
      const onTimeline = primaryTrack(p).clips.map((c) => c.sourceId);
      const library = p.sources.filter((s) => s.kind !== 'audio').map((s) => s.id);
      const ids = [...new Set([...onTimeline, ...library])].filter(
        (id) => !indexRef.current.some((i) => i.sourceId === id && i.words),
      );
      const done: SourceIndex[] = [];
      for (const id of ids) {
        const source = p.sources.find((x) => x.id === id);
        const uri = resolveUri(id);
        if (!source || !uri) continue;
        done.push(
          await analyzeSource(source, uri, { language: 'auto', signal, onProgress: setStatus }),
        );
        updateIndex(done.slice(-1));
      }
      return done.length;
    },
    [resolveUri, updateIndex],
  );
  const abortRef = useRef<AbortController | null>(null);
  /** Context for the model about things that happened outside the chat. */
  const noteRef = useRef('');

  const push = (entry: LogEntry) => setLog((l) => [...l, entry]);

  const deviceTools: Record<string, DeviceTool> = {
    remove_silences: async (project, input) => {
      const opts = INTENSITY[String(input.intensity)] ?? DEFAULT_SILENCE_OPTIONS;
      const r = await analyzeSilences(project, resolveUri, opts);
      return {
        project: r.cuts.length ? applySilenceCuts(project, r.cuts) : project,
        summary: `${r.removedCount} cortes, ${r.removedSec.toFixed(1)} s de silencio quitados`,
      };
    },
    analyze_media: async (project, _input, signal) => {
      const n = await analyzeMissing(project, signal);
      const words = timelineWords(project, indexRef.current).length;
      return {
        project,
        summary: n
          ? `${n} video(s) analizados: ${words} palabras transcritas y planos detectados`
          : 'Los videos ya estaban analizados',
      };
    },
    auto_reframe: async (project, input) => {
      const all = primaryTrack(project).clips;
      const wanted = Array.isArray(input.clip_ids) ? (input.clip_ids as string[]) : ['all'];
      const targets = wanted.includes('all') ? all : all.filter((c) => wanted.includes(c.id));
      if (targets.length === 0) throw new Error('No hay clips para reencuadrar.');
      const zoom = typeof input.zoom === 'number' ? Math.min(2, Math.max(1, input.zoom)) : 1;
      let next = project;
      let tracked = 0;
      for (const clip of targets) {
        const source = project.sources.find((x) => x.id === clip.sourceId);
        const uri = resolveUri(clip.sourceId);
        if (!source || !uri) continue;
        // Subjects are cached in the index by source time.
        const known = indexRef.current.find((i) => i.sourceId === clip.sourceId)?.subjects ?? [];
        const times: number[] = [];
        const step = Math.max(0.5, (clip.outPoint - clip.inPoint) / 120);
        for (let t = clip.inPoint; t <= clip.outPoint; t += step) {
          if (!known.some((k) => Math.abs(k.t - t) < step / 2)) times.push(t);
        }
        const found = times.length ? await VideoEngine.detectFacesAsync(uri, times) : [];
        const subjects = [...known, ...found].sort((a, b) => a.t - b.t);
        const entry = indexRef.current.find((i) => i.sourceId === clip.sourceId) ?? { sourceId: clip.sourceId };
        updateIndex([{ ...entry, subjects }]);
        const keys = reframeKeys(
          source.width, source.height, project.width, project.height,
          clip.inPoint, clip.outPoint, subjects, zoom,
        );
        if (keys.length) tracked++;
        next = setTransformKeys(next, clip.id, keys, 'cover');
      }
      return {
        project: next,
        summary: `${targets.length} clip(s) llenan el cuadro${tracked ? `; ${tracked} siguen a la persona` : ' (sin caras detectadas: centrado)'}`,
      };
    },
    sync_cuts_to_music: async (project, input) => {
      const music =
        project.music.find((m) => m.id === input.music_id) ?? project.music[0];
      if (!music) throw new Error('No hay música de fondo: añade una primero (set_music).');
      const uri = resolveUri(music.sourceId);
      if (!uri) throw new Error('No se encontró el archivo de la música.');
      const samples = await decodeMono(uri, music.inPoint, music.outPoint);
      // decodeMono starts at inPoint; beatsOnTimeline expects source seconds.
      const beats = detectBeats(samples, ANALYSIS_RATE).map((b) => b + music.inPoint);
      const onTimeline = beatsOnTimeline(beats, music, totalDuration(project));
      const next = snapCutsToBeats(project, onTimeline);
      const clips = primaryTrack(project).clips;
      const moved = primaryTrack(next).clips.filter(
        (c, i) => Math.abs(c.outPoint - clips[i].outPoint) > 0.001,
      ).length;
      return {
        project: next,
        summary: beats.length
          ? `${beats.length} golpes detectados; ${moved} corte(s) movidos al ritmo`
          : 'No se detectó un ritmo claro en la música',
      };
    },
    remember: async (project, input) => {
      const pref = String(input.preference ?? '').trim();
      if (!pref) throw new Error('Preferencia vacía.');
      if (!memoryRef.current.includes(pref)) setMemory([...memoryRef.current, pref].slice(-20));
      return { project, summary: `Recordaré: ${pref}` };
    },
    generate_captions: async (project, input, signal) => {
      // Reuse the analysis transcript when every clip has one (instant).
      const words = timelineWords(project, indexRef.current);
      const covered = primaryTrack(project).clips.every((c) =>
        indexRef.current.some((i) => i.sourceId === c.sourceId && i.words),
      );
      if (covered && words.length) {
        const lines = groupWords(words.map((w) => ({ text: w.text, start: w.start, end: w.end })));
        return { project: setCaptionOverlays(project, lines), summary: `${lines.length} líneas de subtítulos` };
      }
      const lines = await generateCaptions(project, resolveUri, {
        model: isModelDownloaded('small') ? 'small' : 'base',
        language: typeof input.language === 'string' ? input.language : 'es',
        signal,
        onProgress: (p) =>
          setStatus(
            p.stage === 'download'
              ? `Descargando modelo de voz… ${Math.round(p.value * 100)}%`
              : p.stage === 'audio'
                ? 'Preparando audio…'
                : `Transcribiendo… ${Math.round(p.value * 100)}%`,
          ),
      });
      return {
        project: setCaptionOverlays(project, lines),
        summary: lines.length ? `${lines.length} líneas de subtítulos` : 'No se detectó voz',
      };
    },
  };

  const run = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || status) return;
      pause();
      push({ kind: 'user', id: nextId(), text: trimmed });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const before = getProject();
      const key = `agent:${nextId()}`;
      setStatus('Pensando…');
      try {
        const note = noteRef.current;
        noteRef.current = '';
        const result = await runAgent({
          history: history.current,
          userText: note ? `(${note}) ${trimmed}` : trimmed,
          project: before,
          describe: (p) =>
            describeProject(p, {
              playhead: clockTime(),
              selection,
              index: indexRef.current,
              memory: memoryRef.current,
            }),
          send: sendTurn,
          deviceTools,
          commit: (p) => commitProject(p, key),
          getIndex: () => indexRef.current,
          signal: ctrl.signal,
          onEvent: (e: AgentEvent) => {
            if (e.type === 'thinking') setStatus('Pensando…');
            if (e.type === 'device') setStatus(TOOL_LABELS[e.name] ?? 'Trabajando…');
          },
        });
        history.current = result.history;
        if (result.reply) push({ kind: 'assistant', id: nextId(), text: result.reply });
        if (result.changes.length) {
          push({ kind: 'changes', id: nextId(), lines: result.changes, before, undone: false });
        }
      } catch (e) {
        if (ctrl.signal.aborted) {
          push({ kind: 'error', id: nextId(), text: 'Cancelado.' });
        } else {
          push({ kind: 'error', id: nextId(), text: (e as Error).message });
        }
        // The conversation may now end mid-exchange; start fresh next time.
        history.current = [];
      } finally {
        abortRef.current = null;
        setStatus(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, selection, resolveUri, getProject, commitProject, pause],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const undoCard = useCallback(
    (id: string) => {
      const card = log.find((e): e is Extract<LogEntry, { kind: 'changes' }> => e.kind === 'changes' && e.id === id);
      if (!card || card.undone) return;
      commitProject(card.before, null);
      setLog((l) => l.map((e) => (e.id === id && e.kind === 'changes' ? { ...e, undone: true } : e)));
      // Tell the agent on the next turn: the project it last saw changed.
      noteRef.current = 'Nota: el usuario deshizo tus últimos cambios; el proyecto actual va abajo.';
    },
    [log, commitProject],
  );

  const reset = useCallback(() => {
    history.current = [];
    setLog([]);
  }, []);

  const analyze = useCallback(async () => {
    if (status) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus('Analizando tus videos…');
    try {
      const n = await analyzeMissing(getProject(), ctrl.signal);
      push({
        kind: 'assistant',
        id: nextId(),
        text: n ? `Analicé ${n} video(s). Ya puedo editar por lo que se dice y por lo que se ve.` : 'Tus videos ya estaban analizados.',
      });
    } catch (e) {
      push({ kind: 'error', id: nextId(), text: ctrl.signal.aborted ? 'Cancelado.' : (e as Error).message });
    } finally {
      abortRef.current = null;
      setStatus(null);
    }
  }, [status, analyzeMissing, getProject]);

  const suggestions = suggestEdits(project, index);

  return (
    <AgentContext.Provider
      value={{
        configured: agentConfigured(),
        log,
        status,
        run,
        cancel,
        undoCard,
        reset,
        index,
        suggestions,
        analyze,
        memory,
        forget,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent(): AgentValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used inside <AgentProvider>');
  return ctx;
}
