/**
 * Agent tests (no network): tool executor, edit ops, project description and
 * the /api/agent handler with a fake Claude client.
 *   npm run test:agent
 */
import assert from 'node:assert/strict';

import { handleAgent, echoable } from '../api/_lib/agent';
import { handleDescribe } from '../api/_lib/describe';
import { detectShots, findFillers, longPauses, suggestEdits, timelineWords } from '../src/core/agent/understanding';
import { describeProject } from '../src/core/agent/context';
import { addEmphasisZoom, cutSourceRanges, deleteRange, keepRanges, reframeKeys, timelineToSourceRanges } from '../src/core/agent/editOps';
import { transformAt } from '../src/core/timeline/types';
import { executeTool } from '../src/core/agent/execute';
import { runAgent } from '../src/core/agent/loop';
import type { AgentMessage, AgentResponse } from '../src/core/agent/protocol';
import { AGENT_TOOLS, DEVICE_TOOLS } from '../src/core/agent/tools';
import { appendClipFromSource, createProject, primaryTrack, totalDuration } from '../src/core/timeline/project';
import type { Project, SourceMeta } from '../src/core/timeline/types';

const results: [string, boolean, string?][] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
}

const src = (id: string, dur: number): SourceMeta => ({
  id, name: `${id}.mp4`, durationSec: dur, width: 1920, height: 1080, fps: 30, codec: 'avc1', kind: 'video',
});

function sample(): Project {
  let p = createProject();
  p = appendClipFromSource(p, src('srcA', 10));
  p = appendClipFromSource(p, src('srcB', 6));
  return p;
}
const ids = (p: Project) => primaryTrack(p).clips.map((c) => c.id);
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

function run(p: Project, name: string, input: unknown): Project {
  const r = executeTool(p, { name, input });
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.project;
}

await test('every tool has a handler or is a device tool', () => {
  const project = sample();
  for (const t of AGENT_TOOLS.filter((x) => !DEVICE_TOOLS.has(x.name))) {
    const r = executeTool(project, { name: t.name, input: {} });
    if (!r.ok) assert.ok(!r.error.startsWith('Unknown tool'), `${t.name} has no handler`);
  }
});

await test('delete_range closes the gap', () => {
  const p = run(sample(), 'delete_range', { start: 2, end: 5 });
  assert.ok(near(totalDuration(p), 13));
  const [a, b] = primaryTrack(p).clips;
  assert.ok(near(a.outPoint, 2) && near(b.inPoint, 5));
});

await test('delete_range across a cut', () => {
  const p = deleteRange(sample(), 8, 12);
  assert.ok(near(totalDuration(p), 12));
});

await test('split_at + set_speed on all + set_volume', () => {
  let p = run(sample(), 'split_at', { time: 4 });
  assert.equal(ids(p).length, 3);
  p = run(p, 'set_speed', { clip_ids: ['all'], speed: 2 });
  assert.ok(near(totalDuration(p), 8));
  p = run(p, 'set_volume', { clip_ids: [ids(p)[0]], volume: 0 });
  assert.equal(primaryTrack(p).clips[0].muted, true);
});

await test('invalid inputs are reported, not thrown', () => {
  const p = sample();
  const bad = [
    executeTool(p, { name: 'set_speed', input: { clip_ids: ['nope'], speed: 2 } }),
    executeTool(p, { name: 'set_speed', input: { clip_ids: ['all'], speed: 9 } }),
    executeTool(p, { name: 'add_text', input: { text: 'x', start: 5, end: 2 } }),
    executeTool(p, { name: 'delete_range', input: { start: 'a', end: 3 } }),
  ];
  for (const r of bad) assert.equal(r.ok, false);
});

await test('look preset + adjustment', () => {
  const p = run(sample(), 'set_look', { clip_ids: ['all'], preset: 'vivid', warmth: 0.2 });
  const f = primaryTrack(p).clips[0].filters!;
  assert.equal(f.saturate, 1.3);
  assert.equal(f.sepia, 0.2);
});

await test('transitions on all cuts, then removed', () => {
  let p = run(sample(), 'set_transition', { after_clip_ids: ['all'], kind: 'fade', duration: 1 });
  assert.equal(p.transitions.length, 1);
  p = run(p, 'set_transition', { after_clip_ids: ['all'], kind: 'none' });
  assert.equal(p.transitions.length, 0);
});

await test('add_text with style, update, delete', () => {
  let p = run(sample(), 'add_text', { text: 'Hola', start: 1, end: 3, position: 'top', size: 'xl', background: 'none' });
  const t = p.overlays[0];
  assert.equal(t.text, 'Hola');
  assert.equal(t.yNorm, 0.15);
  assert.equal(t.background, null);
  p = run(p, 'update_text', { text_id: t.id, text: 'Adiós', color: '#facc15' });
  assert.equal(p.overlays[0].text, 'Adiós');
  p = run(p, 'delete_texts', { text_ids: ['all'] });
  assert.equal(p.overlays.length, 0);
});

await test('framing, format, sound effect', () => {
  let p = run(sample(), 'set_framing', { clip_ids: ['all'], fit: 'cover', zoom: 1.5, focus_x: 0.3 });
  const c = primaryTrack(p).clips[0];
  assert.equal(c.fit, 'cover');
  assert.equal(c.transform?.scale, 1.5);
  p = run(p, 'set_format', { aspect: '1:1' });
  assert.equal(p.width, p.height);
  p = run(p, 'add_sound_effect', { name: 'whoosh', time: 10 });
  assert.equal(p.sfx.length, 1);
});

await test('cutSourceRanges removes words from clips', () => {
  const p = cutSourceRanges(sample(), [
    { sourceId: 'srcA', start: 2, end: 3 },
    { sourceId: 'srcA', start: 5, end: 6.5 },
  ]);
  assert.ok(near(totalDuration(p), 16 - 2.5));
  assert.equal(primaryTrack(p).clips.length, 4);
});

await test('cutSourceRanges can remove a whole clip', () => {
  const p = cutSourceRanges(sample(), [{ sourceId: 'srcB', start: 0, end: 6 }]);
  assert.equal(primaryTrack(p).clips.length, 1);
});

await test('keepRanges builds a reel in order', () => {
  const p = keepRanges(sample(), [
    { sourceId: 'srcB', start: 1, end: 3 },
    { sourceId: 'srcA', start: 7, end: 9 },
  ]);
  const clips = primaryTrack(p).clips;
  assert.equal(clips.length, 2);
  assert.equal(clips[0].sourceId, 'srcB');
  assert.ok(near(clips[1].startInTimeline, 2));
});

await test('project description lists ids and transcript', () => {
  const p = sample();
  const [a] = primaryTrack(p).clips;
  const text = describeProject(p, {
    playhead: 3,
    selection: { kind: 'clip', id: a.id },
    index: [{ sourceId: 'srcA', words: [{ text: 'Hola', start: 0.5, end: 0.9 }, { text: 'mundo', start: 1, end: 1.4 }] }],
  });
  assert.ok(text.includes(a.id));
  assert.ok(text.includes('[0.5] Hola mundo'));
  assert.ok(text.includes('Selección: clip'));
});

await test('keep_only builds a reel from timeline spans in order', () => {
  const p = run(sample(), 'keep_only', { segments: [{ start: 11, end: 13 }, { start: 1, end: 3 }] });
  const clips = primaryTrack(p).clips;
  assert.equal(clips.length, 2);
  assert.equal(clips[0].sourceId, 'srcB');
  assert.ok(near(clips[0].inPoint, 1) && near(clips[1].inPoint, 1));
  assert.ok(near(totalDuration(p), 4));
});

await test('timelineToSourceRanges splits across clips and speed', () => {
  const p = run(sample(), 'set_speed', { clip_ids: ['all'], speed: 2 });
  const r = timelineToSourceRanges(p, [{ start: 4, end: 6 }]);
  assert.deepEqual(r.map((x) => [x.sourceId, x.start, x.end]), [['srcA', 8, 10], ['srcB', 0, 2]]);
});

await test('emphasis zoom animates and returns', () => {
  const p = addEmphasisZoom(sample(), 2, 1, 1.5);
  const c = primaryTrack(p).clips[0];
  assert.ok(near(transformAt(c, 2.5).scale, 1.5));
  assert.ok(near(transformAt(c, 1).scale, 1));
  assert.ok(near(transformAt(c, 3.5).scale, 1));
  assert.ok(run(sample(), 'add_zoom', { at: 12 }));
});

await test('reframe keeps a subject centered within the covered frame', () => {
  // 16:9 source into 9:16: fitted width is 3.16× the output width.
  const keys = reframeKeys(1920, 1080, 1080, 1920, 0, 2, [
    { t: 0, x: 0.5, y: 0.5 },
    { t: 2, x: 0.5, y: 0.5 },
  ]);
  assert.ok(keys.every((k) => near(k.xNorm, 0.5)));
  const left = reframeKeys(1920, 1080, 1080, 1920, 0, 2, [{ t: 1, x: 0.3, y: 0.5 }]);
  const fw = (1920 * (1920 / 1080)) / 1080;
  assert.ok(near(left[0].xNorm, 0.5 + fw * 0.2, 1e-9));
  // Subject at the very edge: clamped so the frame stays covered.
  const edge = reframeKeys(1920, 1080, 1080, 1920, 0, 2, [{ t: 1, x: 0.0, y: 0.5 }]);
  assert.ok(near(edge[0].xNorm, fw / 2, 1e-9));
});

// ---- understanding ----

const words = (list: [string, number, number][]) => list.map(([text, start, end]) => ({ text, start, end }));
const INDEX = [
  {
    sourceId: 'srcA',
    words: words([
      ['Hola,', 2.0, 2.3], ['eh,', 2.4, 2.6], ['que', 2.7, 2.8], ['que', 2.85, 3.0], ['tal', 3.1, 3.3],
      ['o', 3.4, 3.5], ['sea', 3.5, 3.7], ['bien.', 3.8, 4.1], ['Siguiente', 6.0, 6.5],
    ]),
  },
];

await test('timeline words follow speed and clip placement', () => {
  const p = run(sample(), 'set_speed', { clip_ids: ['all'], speed: 2 });
  const w = timelineWords(p, INDEX);
  assert.equal(w.length, 9);
  assert.ok(near(w[0].start, 1.0));
});

await test('fillers: "eh", stutter and "o sea"', () => {
  const cuts = findFillers(timelineWords(sample(), INDEX));
  assert.equal(cuts.length, 3);
  assert.deepEqual(cuts.map((c) => [c.start, c.end]), [[2.4, 2.6], [2.7, 2.8], [3.4, 3.7]]);
});

await test('remove_filler_words tool cuts them; errors without transcript', () => {
  const r = executeTool(sample(), { name: 'remove_filler_words', input: {} }, { index: INDEX });
  assert.ok(r.ok && near(totalDuration(r.project), 16 - 0.2 - 0.1 - 0.3));
  const none = executeTool(sample(), { name: 'remove_filler_words', input: {} }, {});
  assert.equal(none.ok, false);
});

await test('long pauses and suggestions', () => {
  const w = timelineWords(sample(), INDEX);
  assert.equal(longPauses(w).length, 1);
  const ids = suggestEdits(sample(), INDEX).map((x) => x.id);
  for (const id of ['fillers', 'pauses', 'hook', 'captions']) assert.ok(ids.includes(id), id);
  assert.ok(suggestEdits(sample(), []).some((x) => x.id === 'analyze'));
});

await test('shot detection from frame-difference scores', () => {
  const times = Array.from({ length: 20 }, (_, i) => i * 0.5);
  const scores = times.map((t) => (t === 3 || t === 7 ? 0.8 : 0.03));
  const shots = detectShots(times, scores, 10);
  assert.deepEqual(shots.map((x) => [x.start, x.end]), [[0, 3], [3, 7], [7, 10]]);
});

// ---- loop ----

await test('loop: tool round then reply; history alternates; device tool runs', async () => {
  const turns: AgentResponse[] = [
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'tool_use', id: 't1', name: 'delete_range', input: { start: 0, end: 2 } },
        { type: 'tool_use', id: 't2', name: 'remove_silences', input: { intensity: 'normal' } },
        { type: 'tool_use', id: 't3', name: 'set_speed', input: { clip_ids: ['bogus'], speed: 2 } },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Listo: quité 2 s.' }] },
  ];
  const seen: AgentMessage[][] = [];
  let commits = 0;
  let deviceCalls = 0;
  const result = await runAgent({
    history: [],
    userText: 'quita el inicio',
    project: sample(),
    describe: (p) => `dur ${totalDuration(p)}`,
    send: async (messages) => {
      seen.push(structuredClone(messages));
      return turns[seen.length - 1];
    },
    deviceTools: {
      remove_silences: async (project) => {
        deviceCalls++;
        return { project, summary: '0 silencios' };
      },
    },
    commit: () => commits++,
  });
  assert.ok(near(totalDuration(result.project), 14));
  assert.equal(deviceCalls, 1);
  assert.equal(commits, 1);
  assert.equal(result.reply, 'Listo: quité 2 s.');
  const roles = result.history.map((m) => m.role).join(',');
  assert.equal(roles, 'user,assistant,user,assistant');
  const toolResults = (result.history[2].content as { type: string; is_error?: boolean; text?: string }[]);
  assert.equal(toolResults.filter((b) => b.type === 'tool_result').length, 3);
  assert.equal(toolResults.find((b) => b.is_error) !== undefined, true);
  assert.ok(toolResults.at(-1)!.text!.includes('<project>'));
  // The assistant turn (with its reasoning block) is echoed back unchanged.
  assert.equal((seen[1][1].content as { type: string }[])[0].type, 'thinking');
});

await test('loop: cut-off tool calls are not executed', async () => {
  const result = await runAgent({
    history: [],
    userText: 'x',
    project: sample(),
    describe: () => '',
    send: async () => ({
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', id: 't1', name: 'delete_clip', input: {} }],
    }),
  });
  assert.equal(primaryTrack(result.project).clips.length, 2);
  assert.equal(result.history.at(-1)!.role, 'user');
});

// ---- backend ----

type Captured = Record<string, unknown>;
function fakeClient(reply: unknown, captured: Captured[] = []) {
  return {
    beta: {
      messages: {
        stream(params: Captured) {
          captured.push(params);
          return { finalMessage: async () => reply };
        },
      },
    },
  } as never;
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

await test('backend: forwards tools, caching, effort, fallbacks', async () => {
  const captured: Captured[] = [];
  const reply = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
  const res = await handleAgent(fakeClient(reply, captured), post({ messages: [{ role: 'user', content: 'hola' }] }), {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { content: { text: string }[]; stop_reason: string };
  assert.equal(body.content[0].text, 'ok');
  const params = captured[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal((params.tools as unknown[]).length, AGENT_TOOLS.length);
  assert.deepEqual(params.output_config, { effort: 'medium' });
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.cache_control, { type: 'ephemeral' });
});

await test('backend: app key required when configured', async () => {
  const reply = { content: [], stop_reason: 'end_turn' };
  const body = { messages: [{ role: 'user', content: 'hola' }] };
  assert.equal((await handleAgent(fakeClient(reply), post(body), { appKey: 'k' })).status, 401);
  assert.equal((await handleAgent(fakeClient(reply), post(body, { 'x-app-key': 'k' }), { appKey: 'k' })).status, 200);
});

await test('backend: rejects bad bodies', async () => {
  const reply = { content: [], stop_reason: 'end_turn' };
  assert.equal((await handleAgent(fakeClient(reply), post({ messages: [] }), {})).status, 400);
  assert.equal((await handleAgent(fakeClient(reply), post({ messages: [{ role: 'assistant', content: 'x' }] }), {})).status, 400);
  const get = new Request('http://x/api/agent');
  assert.equal((await handleAgent(fakeClient(reply), get, {})).status, 405);
});

await test('backend: echoable drops pre-fallback reasoning and tool calls', () => {
  const out = echoable([
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 'a' },
    { type: 'text', text: 'partial' },
    { type: 'fallback', from: {}, to: {} },
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 'b' },
  ]);
  assert.deepEqual(out.map((b) => b.type), ['text', 'thinking', 'tool_use']);
});

await test('describe: returns parsed descriptions; validates frames', async () => {
  const fake = {
    messages: {
      parse: async (params: { model: string }) => {
        assert.equal(params.model, 'claude-haiku-4-5');
        return { parsed_output: { frames: [{ id: 'f1', description: 'Persona hablando a cámara' }] } };
      },
    },
  } as never;
  const res = await handleDescribe(fake, post({ frames: [{ id: 'f1', jpegBase64: 'AAAA' }] }), {});
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { frames: { id: string }[] }).frames[0].id, 'f1');
  assert.equal((await handleDescribe(fake, post({ frames: [] }), {})).status, 400);
});

let failed = 0;
for (const [name, pass, msg] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${msg ? ` — ${msg}` : ''}`);
  if (!pass) failed++;
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
