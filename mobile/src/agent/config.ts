/**
 * Where the agent backend lives. Set at build time:
 *   EXPO_PUBLIC_AGENT_URL=https://your-deployment.vercel.app
 *   EXPO_PUBLIC_AGENT_KEY=<same value as AGENT_APP_KEY on the backend> (optional)
 */
export const AGENT_URL = (process.env.EXPO_PUBLIC_AGENT_URL ?? '').replace(/\/+$/, '');
export const AGENT_KEY = process.env.EXPO_PUBLIC_AGENT_KEY ?? '';

export const agentConfigured = () => AGENT_URL.length > 0;
