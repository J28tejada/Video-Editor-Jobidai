/**
 * Keyframe descriptions for the agent's understanding layer: the app sends a
 * few small JPEG frames per video (one per detected shot) and gets back a
 * short description of each, so the agent can find moments and pick B-roll.
 * A cheap, fast model is enough for this bulk work.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { apiError, checkAccess, json, readJson, type AgentEnv } from './agent';

export const DESCRIBE_MODEL = 'claude-haiku-4-5';
const MAX_FRAMES = 24;

export type DescribeRequest = {
  frames: { id: string; jpegBase64: string }[];
  /** Language of the descriptions, e.g. "es". */
  language?: string;
};

const Descriptions = z.object({
  frames: z.array(z.object({ id: z.string(), description: z.string() })),
});

export type DescribeClient = Pick<Anthropic, 'messages'>;

export async function handleDescribe(
  client: DescribeClient,
  request: Request,
  env: AgentEnv,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const denied = checkAccess(request, env);
  if (denied) return denied;
  let body: DescribeRequest;
  try {
    body = await readJson<DescribeRequest>(request);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  const frames = Array.isArray(body?.frames) ? body.frames : [];
  if (frames.length === 0 || frames.length > MAX_FRAMES) {
    return json({ error: `Send between 1 and ${MAX_FRAMES} frames.` }, 400);
  }
  if (frames.some((f) => typeof f.id !== 'string' || typeof f.jpegBase64 !== 'string')) {
    return json({ error: 'Each frame needs an id and jpegBase64.' }, 400);
  }

  const content: Anthropic.ContentBlockParam[] = [];
  for (const f of frames) {
    content.push({ type: 'text', text: `Frame ${f.id}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.jpegBase64 } });
  }
  content.push({
    type: 'text',
    text: `Describe each frame for a video editor in at most 12 words (${body.language ?? 'es'}): who/what is visible, setting, action, framing (close-up, wide…). Return one entry per frame id.`,
  });

  try {
    const response = await client.messages.parse({
      model: DESCRIBE_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content }],
      output_config: { format: zodOutputFormat(Descriptions) },
    });
    const parsed = response.parsed_output;
    if (!parsed) return json({ error: 'No se pudieron leer las descripciones.' }, 502);
    return json(parsed, 200);
  } catch (e) {
    return apiError(e);
  }
}
