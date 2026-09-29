/**
 * Applies one agent tool call to a project. Pure and synchronous: the device
 * tools (captions, silences…) are handled by the app before reaching here.
 *
 * Inputs come from the model, so everything is validated; problems are
 * returned as errors for the model to correct instead of throwing.
 */
import { FILTER_PRESETS } from '../timeline/filterPresets';
import {
  addOverlay,
  addSynthSfx,
  findClip,
  patchAllCaptions,
  primaryTrack,
  removeClip,
  removeMusic,
  removeOverlay,
  removeTransition,
  reorderClip,
  setClipAudio,
  setClipFilters,
  setClipFiltersAll,
  setClipFit,
  setClipSpeed,
  setClipTransform,
  setProjectFormat,
  setTransitionAfter,
  splitAt,
  totalDuration,
  transitionAfterClip,
  trimClip,
  updateMusic,
  updateOverlay,
  updateSfx,
} from '../timeline/project';
import type { ClipFilters, Project, TextOverlay } from '../timeline/types';
import { synthDuration } from '../audio/sfxList';
import type { SourceIndex } from './context';
import {
  addBroll,
  addEmphasisZoom,
  cutSourceRanges,
  deleteRange,
  keepRanges,
  timelineToSourceRanges,
} from './editOps';
import { findFillers, timelineWords } from './understanding';

export type ToolCall = { name: string; input: unknown };

export type ToolOutcome =
  | { ok: true; project: Project; summary: string }
  | { ok: false; error: string };

class InputError extends Error {}

type Input = Record<string, unknown>;

const PRESETS: Record<string, string> = {
  none: 'Ninguno',
  vivid: 'Vívido',
  warm: 'Cálido',
  cool: 'Frío',
  bw: 'B/N',
  cinematic: 'Cine',
};
const POSITIONS: Record<string, number> = { top: 0.15, center: 0.5, bottom: 0.85 };
const SIZES: Record<string, number> = { s: 0.04, m: 0.06, l: 0.08, xl: 0.11 };
const BACKGROUNDS: Record<string, string | null> = {
  none: null,
  dark: 'rgba(0,0,0,0.5)',
  light: 'rgba(255,255,255,0.85)',
};
const ASPECTS: Record<string, [number, number]> = {
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '16:9': [1920, 1080],
};

/** Extra data some tools need (e.g. transcripts for filler removal). */
export type ExecContext = { index?: SourceIndex[] };

export function executeTool(project: Project, call: ToolCall, ctx: ExecContext = {}): ToolOutcome {
  try {
    const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Input;
    const run = HANDLERS[call.name];
    if (!run) return { ok: false, error: `Unknown tool "${call.name}".` };
    return run(project, input, ctx);
  } catch (e) {
    return { ok: false, error: e instanceof InputError ? e.message : `Failed: ${(e as Error).message}` };
  }
}

// ---- validation helpers ----

function num(input: Input, key: string, min?: number, max?: number): number {
  const v = input[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InputError(`"${key}" must be a number.`);
  if ((min != null && v < min) || (max != null && v > max)) {
    throw new InputError(`"${key}" must be between ${min} and ${max}.`);
  }
  return v;
}
const optNum = (input: Input, key: string, min?: number, max?: number) =>
  input[key] == null ? undefined : num(input, key, min, max);

function str(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || !v.trim()) throw new InputError(`"${key}" must be a non-empty string.`);
  return v;
}
const optStr = (input: Input, key: string) => (input[key] == null ? undefined : str(input, key));

function oneOf<T extends string>(input: Input, key: string, values: readonly T[]): T | undefined {
  const v = input[key];
  if (v == null) return undefined;
  if (typeof v !== 'string' || !values.includes(v as T)) {
    throw new InputError(`"${key}" must be one of: ${values.join(', ')}.`);
  }
  return v as T;
}

/** Resolve ["all"] or explicit ids against a list, rejecting unknown ids. */
function pick(input: Input, key: string, all: string[], what: string): string[] {
  const v = input[key];
  if (!Array.isArray(v) || v.length === 0) throw new InputError(`"${key}" must be a non-empty list.`);
  if (v.includes('all')) return all;
  const unknown = v.filter((id) => typeof id !== 'string' || !all.includes(id));
  if (unknown.length) throw new InputError(`Unknown ${what} id(s): ${unknown.join(', ')}.`);
  return v as string[];
}

const baseIds = (p: Project) => primaryTrack(p).clips.map((c) => c.id);

function requireClip(p: Project, id: string) {
  const loc = findClip(p, id);
  if (!loc) throw new InputError(`Unknown clip id "${id}".`);
  return loc;
}

function textPatch(input: Input): Partial<TextOverlay> {
  const patch: Partial<TextOverlay> = {};
  const position = oneOf(input, 'position', ['top', 'center', 'bottom'] as const);
  if (position) {
    patch.yNorm = POSITIONS[position];
    patch.xNorm = 0.5;
  }
  const size = oneOf(input, 'size', ['s', 'm', 'l', 'xl'] as const);
  if (size) patch.fontSizeNorm = SIZES[size];
  const color = optStr(input, 'color');
  if (color) patch.color = color;
  const bg = oneOf(input, 'background', ['none', 'dark', 'light'] as const);
  if (bg) patch.background = BACKGROUNDS[bg];
  return patch;
}

const ok = (project: Project, summary: string): ToolOutcome => ({ ok: true, project, summary });
const s = (n: number) => `${Math.round(n * 10) / 10} s`;

// ---- handlers ----

const HANDLERS: Record<string, (p: Project, input: Input, ctx: ExecContext) => ToolOutcome> = {
  remove_filler_words(p, _input, ctx) {
    const words = timelineWords(p, ctx.index ?? []);
    if (words.length === 0) throw new InputError('No transcript yet: call analyze_media first.');
    const cuts = findFillers(words);
    if (cuts.length === 0) return ok(p, 'No se encontraron muletillas');
    const next = cutSourceRanges(p, cuts);
    return ok(next, `${cuts.length} muletilla(s) quitada(s) (${s(totalDuration(p) - totalDuration(next))})`);
  },

  keep_only(p, input) {
    const raw = input.segments;
    if (!Array.isArray(raw) || raw.length === 0) throw new InputError('"segments" must be a non-empty list.');
    const total = totalDuration(p);
    const spans = raw.map((seg, i) => {
      const o = (seg ?? {}) as Input;
      const start = num(o, 'start', 0, total);
      const end = Math.min(num(o, 'end', 0), total);
      if (end - start < 0.1) throw new InputError(`Segment ${i} is empty or reversed.`);
      return { start, end };
    });
    const next = keepRanges(p, timelineToSourceRanges(p, spans));
    return ok(next, `Nuevo montaje de ${spans.length} tramo(s), ${s(totalDuration(next))}`);
  },

  add_zoom(p, input) {
    const at = num(input, 'at', 0, totalDuration(p));
    const duration = optNum(input, 'duration', 0.3, 5) ?? 1.2;
    const scale = optNum(input, 'scale', 1.05, 2) ?? 1.25;
    const next = addEmphasisZoom(p, at, duration, scale);
    if (next === p) throw new InputError(`No clip at ${at}.`);
    return ok(next, `Zoom de énfasis en ${s(at)}`);
  },

  add_broll(p, input) {
    const sourceId = str(input, 'source_id');
    const source = p.sources.find((x) => x.id === sourceId && x.kind !== 'audio');
    if (!source) throw new InputError(`Unknown video source "${sourceId}".`);
    const at = num(input, 'at', 0, totalDuration(p));
    const duration = num(input, 'duration', 0.5, 15);
    const from = optNum(input, 'source_start', 0, source.durationSec) ?? 0;
    const next = addBroll(p, sourceId, from, at, duration);
    if (next === p) throw new InputError('No room for the cutaway there (past the end, or source too short).');
    return ok(next, `B-roll "${source.name}" en ${s(at)}`);
  },

  split_at(p, input) {
    const t = num(input, 'time', 0, totalDuration(p));
    const next = splitAt(p, t);
    if (next === p) throw new InputError(`No clip to cut at ${t} (it may already be a cut).`);
    return ok(next, `Corte en ${s(t)}`);
  },

  delete_range(p, input) {
    const start = num(input, 'start', 0);
    const end = num(input, 'end', 0);
    if (end <= start) throw new InputError('"end" must be after "start".');
    const next = deleteRange(p, start, Math.min(end, totalDuration(p)));
    return ok(next, `Quitado ${s(start)}–${s(end)} (${s(totalDuration(p) - totalDuration(next))})`);
  },

  delete_clip(p, input) {
    const id = str(input, 'clip_id');
    requireClip(p, id);
    return ok(removeClip(p, id), 'Clip borrado');
  },

  trim_clip(p, input) {
    const id = str(input, 'clip_id');
    const { clip } = requireClip(p, id);
    const src = p.sources.find((x) => x.id === clip.sourceId);
    const max = src?.durationSec ?? clip.outPoint;
    let next = p;
    const inPoint = optNum(input, 'in_point', 0, max);
    const outPoint = optNum(input, 'out_point', 0, max);
    if (inPoint == null && outPoint == null) throw new InputError('Give in_point and/or out_point.');
    if (inPoint != null && outPoint != null && outPoint <= inPoint) {
      throw new InputError('out_point must be after in_point.');
    }
    if (outPoint != null) next = trimClip(next, id, 'out', outPoint);
    if (inPoint != null) next = trimClip(next, id, 'in', inPoint);
    return ok(next, 'Clip recortado');
  },

  move_clip(p, input) {
    const id = str(input, 'clip_id');
    requireClip(p, id);
    const to = num(input, 'to_index', 0);
    return ok(reorderClip(p, id, Math.round(to)), 'Clip movido');
  },

  set_speed(p, input) {
    const speed = num(input, 'speed', 0.25, 4);
    const targets = pick(input, 'clip_ids', baseIds(p), 'clip');
    let next = p;
    for (const id of targets) next = setClipSpeed(next, id, speed);
    return ok(next, `Velocidad ${speed}× en ${targets.length} clip(s)`);
  },

  set_volume(p, input) {
    const volume = num(input, 'volume', 0, 2);
    const targets = pick(input, 'clip_ids', baseIds(p), 'clip');
    let next = p;
    for (const id of targets) next = setClipAudio(next, id, { volume, muted: volume === 0 });
    return ok(next, volume === 0 ? `${targets.length} clip(s) en silencio` : `Volumen ${Math.round(volume * 100)}%`);
  },

  set_look(p, input) {
    const targets = pick(input, 'clip_ids', baseIds(p), 'clip');
    const preset = oneOf(input, 'preset', Object.keys(PRESETS) as string[]);
    const patch: Partial<ClipFilters> = {};
    const b = optNum(input, 'brightness', 0.5, 1.5);
    const c = optNum(input, 'contrast', 0.5, 1.6);
    const sat = optNum(input, 'saturation', 0, 2);
    const warm = optNum(input, 'warmth', 0, 0.5);
    if (b != null) patch.brightness = b;
    if (c != null) patch.contrast = c;
    if (sat != null) patch.saturate = sat;
    if (warm != null) patch.sepia = warm;
    if (!preset && Object.keys(patch).length === 0) throw new InputError('Give a preset or an adjustment.');
    let next = p;
    for (const id of targets) {
      if (preset) {
        const found = FILTER_PRESETS.find(([name]) => name === PRESETS[preset]);
        const base = found && Object.keys(found[1]).length ? { ...found[1] } : undefined;
        next = setClipFiltersAll(next, id, base);
      }
      if (Object.keys(patch).length) next = setClipFilters(next, id, patch);
    }
    return ok(next, `Color ajustado en ${targets.length} clip(s)${preset ? ` (${PRESETS[preset]})` : ''}`);
  },

  set_framing(p, input) {
    const targets = pick(input, 'clip_ids', baseIds(p), 'clip');
    const fit = oneOf(input, 'fit', ['contain', 'cover'] as const);
    const zoom = optNum(input, 'zoom', 1, 3);
    const fx = optNum(input, 'focus_x', 0, 1);
    const fy = optNum(input, 'focus_y', 0, 1);
    let next = p;
    for (const id of targets) {
      if (fit) next = setClipFit(next, id, fit);
      const patch: { scale?: number; xNorm?: number; yNorm?: number } = {};
      if (zoom != null) patch.scale = zoom;
      if (fx != null) patch.xNorm = fx;
      if (fy != null) patch.yNorm = fy;
      if (Object.keys(patch).length) next = setClipTransform(next, id, patch);
    }
    return ok(next, `Encuadre ajustado en ${targets.length} clip(s)`);
  },

  set_transition(p, input) {
    const kind = oneOf(input, 'kind', ['none', 'crossfade', 'fade', 'slide'] as const)!;
    if (!kind) throw new InputError('"kind" is required.');
    const clips = primaryTrack(p).clips;
    const allCuts = clips.slice(0, -1).map((c) => c.id);
    const targets = pick(input, 'after_clip_ids', allCuts, 'clip (not the last one)');
    const duration = optNum(input, 'duration', 0.1, 2) ?? 0.5;
    let next = p;
    for (const id of targets) {
      if (kind === 'none') {
        const tr = transitionAfterClip(next, id);
        if (tr) next = removeTransition(next, tr.id);
      } else {
        next = setTransitionAfter(next, id, kind, duration);
      }
    }
    return ok(next, kind === 'none' ? 'Transiciones quitadas' : `${targets.length} transición(es)`);
  },

  add_text(p, input) {
    const text = str(input, 'text');
    const total = totalDuration(p);
    const start = num(input, 'start', 0, total);
    const end = Math.min(num(input, 'end', 0), total || Infinity);
    if (end <= start) throw new InputError('"end" must be after "start".');
    const created = addOverlay(p, start);
    const next = updateOverlay(created.project, created.id, {
      text,
      startSec: start,
      endSec: end,
      ...textPatch(input),
    });
    return ok(next, `Texto "${text}" (${created.id})`);
  },

  update_text(p, input) {
    const id = str(input, 'text_id');
    if (!p.overlays.some((o) => o.id === id)) throw new InputError(`Unknown text id "${id}".`);
    const patch = textPatch(input);
    const text = optStr(input, 'text');
    if (text) patch.text = text;
    const start = optNum(input, 'start', 0);
    const end = optNum(input, 'end', 0);
    if (start != null) patch.startSec = start;
    if (end != null) patch.endSec = end;
    return ok(updateOverlay(p, id, patch), 'Texto actualizado');
  },

  delete_texts(p, input) {
    const targets = pick(input, 'text_ids', p.overlays.map((o) => o.id), 'text');
    let next = p;
    for (const id of targets) next = removeOverlay(next, id);
    return ok(next, `${targets.length} texto(s) borrado(s)`);
  },

  style_captions(p, input) {
    if (!p.overlays.some((o) => o.isCaption)) throw new InputError('There are no auto-captions yet.');
    const patch = textPatch(input);
    const hl = optStr(input, 'highlight_color');
    if (hl) patch.highlightColor = hl;
    if (Object.keys(patch).length === 0) throw new InputError('Nothing to change.');
    return ok(patchAllCaptions(p, patch), 'Estilo de subtítulos actualizado');
  },

  set_music(p, input) {
    const targets = pick(input, 'music_ids', p.music.map((m) => m.id), 'music');
    const patch: Record<string, number | boolean> = {};
    const volume = optNum(input, 'volume', 0, 1);
    const fadeIn = optNum(input, 'fade_in', 0, 10);
    const fadeOut = optNum(input, 'fade_out', 0, 10);
    const start = optNum(input, 'start', 0);
    if (volume != null) patch.volume = volume;
    if (fadeIn != null) patch.fadeInSec = fadeIn;
    if (fadeOut != null) patch.fadeOutSec = fadeOut;
    if (start != null) patch.startSec = start;
    if (typeof input.duck === 'boolean') patch.duck = input.duck;
    if (typeof input.loop === 'boolean') patch.loop = input.loop;
    let next = p;
    for (const id of targets) next = updateMusic(next, id, patch);
    return ok(next, 'Música ajustada');
  },

  delete_music(p, input) {
    const targets = pick(input, 'music_ids', p.music.map((m) => m.id), 'music');
    let next = p;
    for (const id of targets) next = removeMusic(next, id);
    return ok(next, 'Música quitada');
  },

  add_sound_effect(p, input) {
    const name = oneOf(input, 'name', ['whoosh', 'swoosh', 'pop', 'ding', 'click', 'riser', 'boom'] as const);
    if (!name) throw new InputError('"name" is required.');
    const time = num(input, 'time', 0, totalDuration(p));
    const created = addSynthSfx(p, name, time, synthDuration(name));
    const volume = optNum(input, 'volume', 0, 1);
    const next = volume != null ? updateSfx(created.project, created.id, { volume }) : created.project;
    return ok(next, `Efecto ${name} en ${s(time)}`);
  },

  set_format(p, input) {
    const aspect = oneOf(input, 'aspect', Object.keys(ASPECTS) as string[]);
    if (!aspect) throw new InputError('"aspect" is required.');
    const [w, h] = ASPECTS[aspect];
    return ok(setProjectFormat(p, w, h), `Formato ${aspect}`);
  },
};
