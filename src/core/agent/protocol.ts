/**
 * Wire format between the app and the agent backend (/api/agent).
 * Messages follow the Claude Messages API shape so the app can append the
 * assistant's content blocks verbatim (required for the model's own
 * reasoning blocks) and answer tool calls with tool_result blocks.
 */
export type ContentBlock = { type: string; [key: string]: unknown };

export type AgentMessage = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

export type AgentRequest = {
  messages: AgentMessage[];
};

export type AgentResponse = {
  /** Assistant content, ready to append to `messages` as-is. */
  content: ContentBlock[];
  stop_reason: string | null;
};

export type AgentErrorResponse = { error: string };

export const AGENT_API_VERSION = 1;
