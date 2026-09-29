/** One model turn through the backend (/api/agent). */
import type { AgentMessage, AgentResponse } from '@agent/protocol';
import { AGENT_KEY, AGENT_URL } from './config';

export type SendTurn = (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentResponse>;

export const sendTurn: SendTurn = async (messages, signal) => {
  if (!AGENT_URL) {
    throw new Error('El asistente no está configurado (falta EXPO_PUBLIC_AGENT_URL).');
  }
  const res = await fetch(`${AGENT_URL}/api/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(AGENT_KEY ? { 'x-app-key': AGENT_KEY } : {}),
    },
    body: JSON.stringify({ messages }),
    signal,
  });
  const data = (await res.json().catch(() => null)) as (AgentResponse & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? `Error del asistente (${res.status}).`);
  return data;
};

/** Short descriptions of keyframes (/api/describe). */
export async function describeFrames(
  frames: { id: string; jpegBase64: string }[],
  signal?: AbortSignal,
): Promise<{ id: string; description: string }[]> {
  if (!AGENT_URL) return [];
  const res = await fetch(`${AGENT_URL}/api/describe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(AGENT_KEY ? { 'x-app-key': AGENT_KEY } : {}),
    },
    body: JSON.stringify({ frames, language: 'es' }),
    signal,
  });
  const data = (await res.json().catch(() => null)) as
    | { frames?: { id: string; description: string }[]; error?: string }
    | null;
  if (!res.ok || !data?.frames) throw new Error(data?.error ?? `Error al describir (${res.status}).`);
  return data.frames;
}
