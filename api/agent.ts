/**
 * POST /api/agent — one turn of the video-editing agent (Vercel Function).
 *
 * Environment:
 *   ANTHROPIC_API_KEY  required
 *   AGENT_APP_KEY      optional shared secret; the app sends it as x-app-key
 */
import Anthropic from '@anthropic-ai/sdk';

import { handleAgent, json } from './_lib/agent';

let client: Anthropic | null = null;

export async function POST(request: Request): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: 'El backend no tiene ANTHROPIC_API_KEY configurada.' }, 500);
  }
  client ??= new Anthropic();
  return handleAgent(client, request, { appKey: process.env.AGENT_APP_KEY });
}
