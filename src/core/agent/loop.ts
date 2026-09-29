/**
 * The agent loop, run on the device: send the conversation, apply the tool
 * calls the model makes to a working copy of the project, answer with tool
 * results (plus the updated project), repeat until the model is done.
 *
 * Everything platform-specific is injected, so this runs the same in the app
 * and in tests.
 */
import type { Project } from '../timeline/types';
import { executeTool } from './execute';
import type { AgentMessage, AgentResponse, ContentBlock } from './protocol';

export type DeviceTool = (
  project: Project,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ project: Project; summary: string }>;

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; ok: boolean; summary: string }
  | { type: 'device'; name: string };

export type RunOptions = {
  /** Conversation so far (API shape). Not mutated. */
  history: AgentMessage[];
  userText: string;
  project: Project;
  /** Project → <project> description for the model. */
  describe: (project: Project) => string;
  send: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentResponse>;
  deviceTools?: Record<string, DeviceTool>;
  /** Called after every round that changed the project. */
  commit?: (project: Project) => void;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  maxRounds?: number;
};

export type RunResult = {
  history: AgentMessage[];
  project: Project;
  changes: string[];
  reply: string;
};

const projectBlock = (text: string): ContentBlock => ({
  type: 'text',
  text: `<project>\n${text}\n</project>`,
});

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { describe, send, onEvent, signal } = opts;
  const history: AgentMessage[] = [
    ...opts.history,
    {
      role: 'user',
      content: [{ type: 'text', text: opts.userText }, projectBlock(describe(opts.project))],
    },
  ];
  let project = opts.project;
  const changes: string[] = [];
  const replies: string[] = [];

  for (let round = 0; round < (opts.maxRounds ?? 8); round++) {
    onEvent?.({ type: 'thinking' });
    const res = await send(history, signal);
    history.push({ role: 'assistant', content: res.content });

    for (const b of res.content) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        replies.push(b.text.trim());
        onEvent?.({ type: 'text', text: b.text.trim() });
      }
    }
    const calls = res.content.filter((b) => b.type === 'tool_use') as (ContentBlock & {
      id: string;
      name: string;
      input: unknown;
    })[];
    if (calls.length === 0) break;
    if (res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') {
      // A cut-off tool call must not run; tell the model instead.
      history.push({
        role: 'user',
        content: calls.map((c) => ({
          type: 'tool_result',
          tool_use_id: c.id,
          is_error: true,
          content: 'Not executed: the response was cut off.',
        })),
      });
      break;
    }

    const results: ContentBlock[] = [];
    let changed = false;
    for (const call of calls) {
      const device = opts.deviceTools?.[call.name];
      if (device) {
        onEvent?.({ type: 'device', name: call.name });
        try {
          const input = (call.input ?? {}) as Record<string, unknown>;
          const out = await device(project, input, signal);
          project = out.project;
          changed = true;
          changes.push(out.summary);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: out.summary });
          onEvent?.({ type: 'tool', name: call.name, ok: true, summary: out.summary });
        } catch (e) {
          if (signal?.aborted) throw e;
          const msg = (e as Error).message;
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: msg });
          onEvent?.({ type: 'tool', name: call.name, ok: false, summary: msg });
        }
        continue;
      }
      const out = executeTool(project, { name: call.name, input: call.input });
      if (out.ok) {
        project = out.project;
        changed = true;
        changes.push(out.summary);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: out.summary });
      } else {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: out.error });
      }
      onEvent?.({ type: 'tool', name: call.name, ok: out.ok, summary: out.ok ? out.summary : out.error });
    }
    if (changed) opts.commit?.(project);
    history.push({ role: 'user', content: [...results, projectBlock(describe(project))] });
  }

  return { history, project, changes, reply: replies.join('\n\n') };
}
