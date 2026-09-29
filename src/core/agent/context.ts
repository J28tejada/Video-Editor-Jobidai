/**
 * Project → compact text the agent reads with every request: ids, timings
 * and settings of everything on the timeline, plus what the user has selected.
 * Transcripts and shot descriptions are appended when the media was analyzed.
 */
import { primaryTrack, totalDuration } from '../timeline/project';
import { clipDuration, clipEnd, clipGain, clipSpeed, type Clip, type Project } from '../timeline/types';

export type AgentSelection =
  | { kind: 'clip' | 'text' | 'music' | 'sfx' | 'transition'; id: string }
  | null;

/** Per-source analysis (source-time based, so it survives edits). */
export type SourceIndex = {
  sourceId: string;
  /** Word timings in source seconds. */
  words?: { text: string; start: number; end: number }[];
  /** Shot boundaries (source seconds) with short visual descriptions. */
  shots?: { start: number; end: number; description?: string }[];
  /** Face / subject center (0..1) over time, for reframing. */
  subjects?: { t: number; x: number; y: number }[];
};

export type ContextOptions = {
  playhead: number;
  selection: AgentSelection;
  index?: SourceIndex[];
  /** Brand / style preferences the user asked the agent to remember. */
  memory?: string[];
};

const f = (n: number) => (Math.round(n * 100) / 100).toString();
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function describeProject(project: Project, opts: ContextOptions): string {
  const lines: string[] = [];
  const aspect = aspectName(project.width, project.height);
  lines.push(
    `Formato ${aspect} (${project.width}×${project.height}), ${project.fps} fps, duración ${f(totalDuration(project))} s.`,
  );
  lines.push(`Cursor en ${f(opts.playhead)} s.`);
  if (opts.selection) lines.push(`Selección: ${opts.selection.kind} ${opts.selection.id}.`);

  const clips = primaryTrack(project).clips;
  lines.push('', `Clips (pista base, ${clips.length}):`);
  if (clips.length === 0) lines.push('  (vacía — el usuario debe importar videos)');
  clips.forEach((c, i) => lines.push(`  ${i}. ${describeClip(project, c)}`));

  const broll = project.tracks
    .filter((t) => t.role === 'overlay')
    .flatMap((t) => t.clips);
  if (broll.length) {
    lines.push('', 'B-roll (cubre la imagen, sin su audio):');
    for (const c of broll) {
      const name = project.sources.find((s) => s.id === c.sourceId)?.name ?? c.sourceId;
      lines.push(`  - ${c.id} "${name}" ${f(c.startInTimeline)}–${f(clipEnd(c))} s (fuente ${f(c.inPoint)}–${f(c.outPoint)})`);
    }
  }

  if (project.transitions.length) {
    lines.push('', 'Transiciones:');
    for (const t of project.transitions) {
      lines.push(`  - después de ${t.afterClipId}: ${t.kind} ${f(t.durationSec)} s`);
    }
  }

  const texts = project.overlays;
  if (texts.length) {
    const captions = texts.filter((o) => o.isCaption);
    const manual = texts.filter((o) => !o.isCaption);
    lines.push('', `Textos (${manual.length}) y subtítulos automáticos (${captions.length}):`);
    for (const o of manual) {
      lines.push(`  - ${o.id} "${o.text}" ${f(o.startSec)}–${f(o.endSec)} s, y=${f(o.yNorm)}, color ${o.color}`);
    }
    for (const o of captions.slice(0, 200)) {
      lines.push(`  - ${o.id} [sub] ${f(o.startSec)}–${f(o.endSec)} "${o.text}"`);
    }
    if (captions.length > 200) lines.push(`  … ${captions.length - 200} subtítulos más`);
  }

  if (project.music.length) {
    lines.push('', 'Música:');
    for (const m of project.music) {
      const name = project.sources.find((s) => s.id === m.sourceId)?.name ?? m.sourceId;
      lines.push(
        `  - ${m.id} "${name}" desde ${f(m.startSec)} s, volumen ${pct(m.volume)}, fades ${m.fadeInSec}/${m.fadeOutSec} s, ${m.duck ? `baja con voz a ${pct(m.duckLevel)}` : 'sin ducking'}, ${m.loop ? 'en bucle' : 'una vez'}`,
      );
    }
  }
  if (project.sfx.length) {
    lines.push('', 'Efectos de sonido:');
    for (const s of project.sfx) lines.push(`  - ${s.id} ${s.synth ?? 'muestra'} en ${f(s.startSec)} s`);
  }

  const library = project.sources.filter(
    (s) => s.kind !== 'audio' && !clips.some((c) => c.sourceId === s.id),
  );
  if (library.length) {
    lines.push('', 'Videos importados que no están en la pista base (biblioteca):');
    for (const s of library) lines.push(`  - ${s.id} "${s.name}" ${f(s.durationSec)} s`);
  }

  const transcript = describeTranscript(project, opts.index ?? []);
  if (transcript) lines.push('', transcript);
  const shots = describeShots(project, opts.index ?? []);
  if (shots) lines.push('', shots);

  if (opts.memory?.length) {
    lines.push('', 'Preferencias del usuario (recuérdalas):');
    for (const m of opts.memory) lines.push(`  - ${m}`);
  }
  return lines.join('\n');
}

function describeClip(project: Project, c: Clip): string {
  const src = project.sources.find((s) => s.id === c.sourceId);
  const parts = [
    `${c.id}: ${f(c.startInTimeline)}–${f(clipEnd(c))} s (${f(clipDuration(c))} s)`,
    `fuente ${c.sourceId}${src ? ` "${src.name}" ${src.width}×${src.height}` : ''} rango ${f(c.inPoint)}–${f(c.outPoint)} de ${f(src?.durationSec ?? c.outPoint)} s`,
  ];
  if (clipSpeed(c) !== 1) parts.push(`velocidad ${clipSpeed(c)}×`);
  if (clipGain(c) !== 1) parts.push(clipGain(c) === 0 ? 'silenciado' : `volumen ${pct(clipGain(c))}`);
  if (c.fit === 'cover') parts.push('llena el cuadro');
  if (c.transform && (c.transform.scale !== 1 || c.transform.xNorm !== 0.5 || c.transform.yNorm !== 0.5)) {
    parts.push(`zoom ${f(c.transform.scale)}× foco (${f(c.transform.xNorm)}, ${f(c.transform.yNorm)})`);
  }
  if (c.filters && Object.keys(c.filters).length) parts.push(`color ${JSON.stringify(c.filters)}`);
  return parts.join(' · ');
}

/**
 * Transcript of what is on the timeline, in timeline seconds, one line per
 * phrase (~8 words) so the agent can locate moments precisely.
 */
function describeTranscript(project: Project, index: SourceIndex[]): string | null {
  const out: string[] = [];
  for (const c of primaryTrack(project).clips) {
    const words = index.find((i) => i.sourceId === c.sourceId)?.words;
    if (!words?.length) continue;
    const inClip = words.filter((w) => w.end > c.inPoint && w.start < c.outPoint);
    for (let i = 0; i < inClip.length; i += 8) {
      const chunk = inClip.slice(i, i + 8);
      const t = c.startInTimeline + (Math.max(chunk[0].start, c.inPoint) - c.inPoint) / clipSpeed(c);
      out.push(`  [${f(t)}] ${chunk.map((w) => w.text).join(' ')}`);
    }
  }
  return out.length ? `Transcripción (segundos del timeline):\n${out.join('\n')}` : null;
}

function describeShots(project: Project, index: SourceIndex[]): string | null {
  const out: string[] = [];
  for (const src of project.sources) {
    const shots = index.find((i) => i.sourceId === src.id)?.shots;
    if (!shots?.length) continue;
    out.push(`  ${src.id} "${src.name}":`);
    for (const s of shots.slice(0, 60)) {
      out.push(`    ${f(s.start)}–${f(s.end)} s (fuente)${s.description ? `: ${s.description}` : ''}`);
    }
  }
  return out.length ? `Planos detectados por fuente:\n${out.join('\n')}` : null;
}

function aspectName(w: number, h: number): string {
  const r = w / h;
  if (Math.abs(r - 9 / 16) < 0.02) return '9:16';
  if (Math.abs(r - 1) < 0.02) return '1:1';
  if (Math.abs(r - 4 / 5) < 0.02) return '4:5';
  if (Math.abs(r - 16 / 9) < 0.02) return '16:9';
  return `${w}:${h}`;
}
