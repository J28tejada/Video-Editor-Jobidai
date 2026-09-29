/**
 * Understanding layer (pure): turns per-source analysis into things the
 * editor and the agent can act on — words on the timeline, filler words,
 * shot boundaries and proactive suggestions.
 */
import { primaryTrack, totalDuration } from '../timeline/project';
import { clipEnd, clipSpeed, type Project } from '../timeline/types';
import type { SourceIndex } from './context';
import type { SourceRange } from './editOps';

/** A transcript word as it appears on the current timeline. */
export type TimelineWord = {
  text: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  clipId: string;
  sourceId: string;
  /** Source seconds. */
  srcStart: number;
  srcEnd: number;
};

export function timelineWords(project: Project, index: SourceIndex[]): TimelineWord[] {
  const out: TimelineWord[] = [];
  for (const c of primaryTrack(project).clips) {
    const words = index.find((i) => i.sourceId === c.sourceId)?.words;
    if (!words) continue;
    const speed = clipSpeed(c);
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid < c.inPoint || mid >= c.outPoint) continue;
      const s = Math.max(w.start, c.inPoint);
      const e = Math.min(w.end, c.outPoint);
      out.push({
        text: w.text,
        start: c.startInTimeline + (s - c.inPoint) / speed,
        end: Math.min(clipEnd(c), c.startInTimeline + (e - c.inPoint) / speed),
        clipId: c.id,
        sourceId: c.sourceId,
        srcStart: w.start,
        srcEnd: w.end,
      });
    }
  }
  return out;
}

const FILLERS = new Set([
  // es
  'eh', 'ehh', 'ehm', 'em', 'emm', 'mm', 'mmm', 'hmm', 'ah', 'ahh', 'osea',
  // en
  'um', 'umm', 'uh', 'uhh', 'er', 'erm',
  // pt
  'hã', 'ãh', 'né',
]);
const FILLER_PHRASES = [['o', 'sea']];

const norm = (t: string) =>
  t.toLowerCase().normalize('NFC').replace(/[.,!?¿¡;:"'«»…()-]/g, '').trim();

/**
 * Filler words ("eh", "um", "o sea"…) and stutters (a word immediately
 * repeated: "que que"). Returns the source spans to cut.
 */
export function findFillers(words: TimelineWord[]): SourceRange[] {
  const cuts: SourceRange[] = [];
  const push = (a: TimelineWord, b: TimelineWord = a) =>
    cuts.push({ sourceId: a.sourceId, start: a.srcStart, end: b.srcEnd });
  for (let i = 0; i < words.length; i++) {
    const w = norm(words[i].text);
    if (!w) continue;
    if (FILLERS.has(w)) {
      push(words[i]);
      continue;
    }
    const phrase = FILLER_PHRASES.find(
      (ph) => ph.every((p, k) => norm(words[i + k]?.text ?? '') === p) && words[i + ph.length - 1]?.sourceId === words[i].sourceId,
    );
    if (phrase) {
      push(words[i], words[i + phrase.length - 1]);
      i += phrase.length - 1;
      continue;
    }
    const next = words[i + 1];
    if (next && next.sourceId === words[i].sourceId && norm(next.text) === w && next.srcStart - words[i].srcEnd < 0.6) {
      push(words[i]); // keep the second take of a stuttered word
    }
  }
  return cuts;
}

/** Pauses between consecutive words longer than `minGap` seconds (timeline). */
export function longPauses(words: TimelineWord[], minGap = 1.2): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= minGap) out.push({ start: words[i - 1].end, end: words[i].start });
  }
  return out;
}

/**
 * Shot boundaries from frame-difference scores (0..1) sampled at `times`
 * (source seconds). A cut is a score well above the typical frame-to-frame
 * change; shots shorter than `minShot` are merged.
 */
export function detectShots(
  times: number[],
  scores: number[],
  duration: number,
  minShot = 0.8,
): { start: number; end: number }[] {
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const threshold = Math.max(0.28, median * 4);
  const cuts: number[] = [];
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] < threshold) continue;
    const t = times[i];
    if (t - (cuts[cuts.length - 1] ?? 0) >= minShot && duration - t >= minShot) cuts.push(t);
  }
  const bounds = [0, ...cuts, duration];
  const shots: { start: number; end: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) shots.push({ start: bounds[i], end: bounds[i + 1] });
  return shots;
}

export type Suggestion = { id: string; label: string; prompt: string };

/** Proactive, data-backed suggestions for the assistant panel. */
export function suggestEdits(project: Project, index: SourceIndex[]): Suggestion[] {
  const out: Suggestion[] = [];
  const clips = primaryTrack(project).clips;
  if (clips.length === 0) return out;
  const words = timelineWords(project, index);
  const duration = totalDuration(project);

  if (words.length) {
    const fillers = findFillers(words).length;
    if (fillers > 0) {
      out.push({
        id: 'fillers',
        label: `Quitar ${fillers} muletilla${fillers === 1 ? '' : 's'}`,
        prompt: 'Quita las muletillas y las palabras repetidas.',
      });
    }
    const pauses = longPauses(words);
    if (pauses.length > 0) {
      out.push({
        id: 'pauses',
        label: `Quitar ${pauses.length} pausa${pauses.length === 1 ? '' : 's'} larga${pauses.length === 1 ? '' : 's'}`,
        prompt: 'Quita las pausas largas entre frases.',
      });
    }
    if (words[0].start > 1.5) {
      out.push({
        id: 'hook',
        label: `El habla empieza en ${words[0].start.toFixed(1)} s: recortar el inicio`,
        prompt: 'El video tarda en arrancar: recorta el inicio para que empiece directo con la primera frase.',
      });
    }
    if (!project.overlays.some((o) => o.isCaption)) {
      out.push({ id: 'captions', label: 'Añadir subtítulos', prompt: 'Añade subtítulos grandes y legibles.' });
    }
  } else {
    out.push({
      id: 'analyze',
      label: 'Analizar mis videos',
      prompt: 'Analiza mis videos (transcripción y planos) y dime qué mejorarías.',
    });
  }

  if (project.width > project.height) {
    out.push({ id: 'vertical', label: 'Hacerlo vertical para Reels', prompt: 'Hazlo vertical 9:16 para Reels y TikTok, llenando el cuadro.' });
  }
  if (duration > 45) {
    out.push({
      id: 'short',
      label: 'Versión corta de 30 s',
      prompt: 'Haz una versión de unos 30 segundos con los mejores momentos y un buen gancho al inicio.',
    });
  }
  if (!project.music.length) {
    out.push({ id: 'polish', label: 'Hacerlo más dinámico', prompt: 'Hazlo más dinámico: transiciones suaves, un look más vivo y efectos de sonido en los cortes.' });
  }
  if (words.length) {
    out.push({
      id: 'publish',
      label: 'Título y hashtags para publicar',
      prompt:
        'Escribe un título atractivo, una descripción corta y 8–10 hashtags para publicar este video (no edites nada).',
    });
  }
  return out.slice(0, 7);
}

/**
 * Beat / onset times (seconds) in mono audio: short-time energy that jumps
 * well above its recent average, at least `minGap` apart.
 */
export function detectBeats(samples: Float32Array, rate: number, minGap = 0.25): number[] {
  const hop = Math.max(1, Math.round(rate * 0.01)); // 10 ms
  const energies: number[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let j = i; j < i + hop; j++) sum += samples[j] * samples[j];
    energies.push(sum / hop);
  }
  const history = 50; // ~0.5 s of context
  const beats: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < energies.length; i++) {
    const from = Math.max(0, i - history);
    let avg = 0;
    for (let j = from; j < i; j++) avg += energies[j];
    avg /= i - from;
    const t = (i * hop) / rate;
    const rising = energies[i] > energies[i - 1];
    if (rising && energies[i] > avg * 1.8 && energies[i] > 1e-4 && t - last >= minGap) {
      beats.push(t);
      last = t;
    }
  }
  return beats;
}

/** Music source beats → timeline times (music placement, trim and looping). */
export function beatsOnTimeline(
  beats: number[],
  music: { startSec: number; inPoint: number; outPoint: number; loop: boolean },
  duration: number,
): number[] {
  const seg = music.outPoint - music.inPoint;
  if (seg <= 0) return [];
  const local = beats.filter((b) => b >= music.inPoint && b < music.outPoint).map((b) => b - music.inPoint);
  const out: number[] = [];
  for (let offset = music.startSec; offset < duration; offset += seg) {
    for (const b of local) if (offset + b < duration) out.push(offset + b);
    if (!music.loop) break;
  }
  return out;
}
