/**
 * The editing agent in the app: conversation state, the loop runner wired to
 * the editor, device tools (captions, silences) and undoable change cards.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

import { describeProject, type SourceIndex } from '@agent/context';
import { runAgent, type AgentEvent, type DeviceTool } from '@agent/loop';
import type { AgentMessage } from '@agent/protocol';
import { applySilenceCuts, setCaptionOverlays } from '@timeline/project';
import type { Project } from '@timeline/types';
import { generateCaptions } from '../ai/captions';
import { analyzeSilences, DEFAULT_SILENCE_OPTIONS, type SilenceOptions } from '../ai/silences';
import { isModelDownloaded } from '../ai/whisperModel';
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
  /** Analysis results used as context (filled by the understanding layer). */
  setIndex: (index: SourceIndex[]) => void;
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
};

let seq = 0;
const nextId = () => `e${Date.now().toString(36)}${seq++}`;

export function AgentProvider({ children }: { children: ReactNode }) {
  const { getProject, commitProject, selection, resolveUri, pause } = useEditor();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const history = useRef<AgentMessage[]>([]);
  const indexRef = useRef<SourceIndex[]>([]);
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
    generate_captions: async (project, input, signal) => {
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
            describeProject(p, { playhead: clockTime(), selection, index: indexRef.current }),
          send: sendTurn,
          deviceTools,
          commit: (p) => commitProject(p, key),
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

  const setIndex = useCallback((index: SourceIndex[]) => {
    indexRef.current = index;
  }, []);

  return (
    <AgentContext.Provider
      value={{ configured: agentConfigured(), log, status, run, cancel, undoCard, reset, setIndex }}
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
