/**
 * POST /api/describe — short descriptions of video keyframes (Vercel Function).
 * Same environment as /api/agent.
 */
import Anthropic from '@anthropic-ai/sdk';

import { json } from './_lib/agent';
import { handleDescribe } from './_lib/describe';

let client: Anthropic | null = null;

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: 'El backend no tiene ANTHROPIC_API_KEY configurada.' }, 500);
  }
  client ??= new Anthropic();
  return handleDescribe(client, request, { appKey: process.env.AGENT_APP_KEY });
}
