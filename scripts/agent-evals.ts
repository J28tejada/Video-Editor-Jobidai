/**
 * End-to-end evals of the editing agent against the real Claude API: each
 * case runs the full loop (backend handler + on-device loop) on a synthetic
 * project and checks the resulting edit. Costs real tokens, so it only runs
 * with ANTHROPIC_API_KEY set:  ANTHROPIC_API_KEY=… npm run eval:agent
 */
import Anthropic from '@anthropic-ai/sdk';

import { handleAgent } from '../api/_lib/agent';
import { describeProject, type SourceIndex } from '../src/core/agent/context';
import { runAgent, type DeviceTool } from '../src/core/agent/loop';
import type { AgentResponse } from '../src/core/agent/protocol';
import { appendClipFromSource, createProject, totalDuration } from '../src/core/timeline/project';
import type { Project, SourceMeta } from '../src/core/timeline/types';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('ANTHROPIC_API_KEY no está configurada: evals omitidas.');
  process.exit(0);
}
const client = new Anthropic();

const src = (id: string, dur: number, w = 1920, h = 1080): SourceMeta => ({
  id, name: `${id}.mp4`, durationSec: dur, width: w, height: h, fps: 30, codec: 'avc1', kind: 'video',
});

/** A 20 s talking-head clip with a filler word and a long pause. */
const SPEECH =
  'Hola a todos eh hoy les voy a enseñar a preparar el mejor café de especialidad en casa ' +
  'primero necesitas granos frescos y un molino';
function talkingHead(): { project: Project; index: SourceIndex[] } {
  let project = createProject();
  project = appendClipFromSource(project, src('talk', 20));
  const words = SPEECH.split(' ').map((text, i) => {
    const start = 0.5 + i * 0.45 + (i >= 16 ? 3 : 0); // 3 s pause before "primero"
    return { text, start, end: start + 0.35 };
  });
  return { project, index: [{ sourceId: 'talk', words }] };
}

type Case = {
  name: string;
  prompt: string;
  setup: () => { project: Project; index: SourceIndex[] };
  check: (before: Project, after: Project, reply: string) => string | null;
};

const CASES: Case[] = [
  {
    name: 'quitar muletillas',
    prompt: 'Quita las muletillas.',
    setup: talkingHead,
    check: (b, a) => (totalDuration(a) < totalDuration(b) ? null : 'la duración no bajó'),
  },
  {
    name: 'vertical',
    prompt: 'Hazlo vertical para TikTok.',
    setup: talkingHead,
    check: (_b, a) => (a.height > a.width ? null : `formato ${a.width}×${a.height}`),
  },
  {
    name: 'título al inicio',
    prompt: 'Pon un título "Café en casa" al inicio, en amarillo.',
    setup: talkingHead,
    check: (_b, a) => {
      const t = a.overlays.find((o) => /caf[eé] en casa/i.test(o.text));
      if (!t) return 'no hay título';
      return t.startSec < 1 ? null : `empieza en ${t.startSec}`;
    },
  },
  {
    name: 'cortar por texto',
    prompt: 'Quita la frase "primero necesitas granos frescos y un molino".',
    setup: talkingHead,
    check: (b, a) => (totalDuration(b) - totalDuration(a) > 1.5 ? null : 'no se quitó la frase'),
  },
  {
    name: 'solo hashtags no edita',
    prompt: 'Dame un título y hashtags para publicar esto.',
    setup: talkingHead,
    check: (b, a, reply) =>
      a === b || JSON.stringify(a) === JSON.stringify(b)
        ? reply.includes('#')
          ? null
          : 'sin hashtags'
        : 'editó el proyecto',
  },
];

const send = async (messages: unknown): Promise<AgentResponse> => {
  const res = await handleAgent(
    client,
    new Request('http://local/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    }),
    {},
  );
  if (!res.ok) throw new Error(`backend ${res.status}: ${await res.text()}`);
  return (await res.json()) as AgentResponse;
};

// Device tools are stubbed: evals measure the model's decisions, not on-device ML.
const stub = (summary: string): DeviceTool => async (project) => ({ project, summary });
const deviceTools: Record<string, DeviceTool> = {
  analyze_media: stub('Los videos ya estaban analizados'),
  generate_captions: stub('12 líneas de subtítulos'),
  remove_silences: stub('0 cortes'),
  auto_reframe: stub('1 clip(s) llenan el cuadro'),
  sync_cuts_to_music: stub('sin música'),
  remember: stub('guardado'),
};

let passed = 0;
for (const c of CASES) {
  const { project, index } = c.setup();
  try {
    const r = await runAgent({
      history: [],
      userText: c.prompt,
      project,
      describe: (p) => describeProject(p, { playhead: 0, selection: null, index }),
      send,
      deviceTools,
      getIndex: () => index,
    });
    const fail = c.check(project, r.project, r.reply);
    console.log(`${fail ? 'FAIL' : 'PASS'} ${c.name}${fail ? `: ${fail}` : ''}`);
    console.log(`     ${r.changes.join(' | ') || '(sin cambios)'} — ${r.reply.slice(0, 140)}`);
    if (!fail) passed++;
  } catch (e) {
    console.log(`FAIL ${c.name}: ${(e as Error).message}`);
  }
}
console.log(`\n${passed}/${CASES.length} evals`);
