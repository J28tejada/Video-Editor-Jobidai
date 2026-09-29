/**
 * Agent backend: a stateless proxy between the app and Claude.
 *
 * The app owns the project and runs the tools (they edit the timeline on the
 * phone), so each request is one model turn: the app sends the conversation,
 * this returns the assistant's content, and the app answers any tool calls in
 * its next request. The API key, system prompt and tool definitions live here.
 */
import Anthropic from '@anthropic-ai/sdk';

import { AGENT_SYSTEM_PROMPT } from '../../src/core/agent/prompt';
import type { AgentRequest, AgentResponse, ContentBlock } from '../../src/core/agent/protocol';
import { AGENT_TOOLS } from '../../src/core/agent/tools';

export const AGENT_MODEL = 'claude-opus-5-5';

/** The part of the SDK client this handler uses (lets tests inject a fake). */
export type AgentClient = Pick<Anthropic, 'beta'>;

export type AgentEnv = {
  /** Optional shared secret the app sends as `x-app-key`. */
  appKey?: string;
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;

const TOOLS = AGENT_TOOLS.map((t, i) =>
  i === AGENT_TOOLS.length - 1
    ? { ...t, cache_control: { type: 'ephemeral' as const } }
    : t,
) as unknown as Anthropic.Beta.BetaToolUnion[];

export async function handleAgent(
  client: AgentClient,
  request: Request,
  env: AgentEnv,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const denied = checkAccess(request, env);
  if (denied) return denied;

  let body: AgentRequest;
  try {
    body = await readJson<AgentRequest>(request);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  const problem = validateMessages(body);
  if (problem) return json({ error: problem }, 400);

  try {
    const message = await client.beta.messages
      .stream({
        model: AGENT_MODEL,
        max_tokens: 16000,
        system: [{ type: 'text', text: AGENT_SYSTEM_PROMPT }],
        tools: TOOLS,
        // Cache the growing conversation too, so each follow-up re-reads
        // the history at cache prices.
        cache_control: { type: 'ephemeral' },
        output_config: { effort: 'medium' },
        // If a safety classifier declines, re-run on Anthropic's recommended
        // fallback model instead of failing the edit.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: body.messages as unknown as Anthropic.Beta.BetaMessageParam[],
      })
      .finalMessage();

    const response: AgentResponse = {
      content: echoable(message.content as unknown as ContentBlock[]),
      stop_reason: message.stop_reason,
    };
    return json(response, 200);
  } catch (e) {
    return apiError(e);
  }
}

/**
 * Content to append to the conversation. After a mid-answer fallback, blocks
 * before the switch that the next model can't take back (reasoning, and tool
 * calls that were never completed) are dropped, as the API requires.
 */
export function echoable(content: ContentBlock[]): ContentBlock[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf('fallback');
  if (lastFallback < 0) return content;
  const dropBefore = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
  return content.filter((b, i) => i > lastFallback || (b.type !== 'fallback' && !dropBefore.has(b.type)));
}

export function checkAccess(request: Request, env: AgentEnv): Response | null {
  if (!env.appKey) return null;
  const given = request.headers.get('x-app-key') ?? '';
  return safeEqual(given, env.appKey) ? null : json({ error: 'Unauthorized' }, 401);
}

export async function readJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error('Request too large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('Request too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Invalid JSON');
  }
}

function validateMessages(body: AgentRequest): string | null {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return '"messages" must be a non-empty array';
  }
  if (body.messages[0].role !== 'user') return 'The first message must be from the user';
  for (const m of body.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') return 'Invalid role';
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) return 'Invalid content';
  }
  return null;
}

export function apiError(e: unknown): Response {
  if (e instanceof Anthropic.RateLimitError) {
    return json({ error: 'El servicio está ocupado, intenta en unos segundos.' }, 429);
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return json({ error: 'El backend no tiene una clave de API válida.' }, 500);
  }
  if (e instanceof Anthropic.BadRequestError) {
    return json({ error: `Solicitud rechazada: ${e.message}` }, 400);
  }
  if (e instanceof Anthropic.APIError) {
    return json({ error: `Error del modelo (${e.status ?? '?'}).` }, 502);
  }
  return json({ error: 'Error interno del agente.' }, 500);
}

export function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
