import {
  MAX_CHAT_REQUEST_MESSAGES,
  type ChatHistoryMessage,
} from './chat-history.ts';

export const MAX_CHAT_MESSAGE_LENGTH = 4_000;

export function parseChatMessages(value: unknown): ChatHistoryMessage[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CHAT_REQUEST_MESSAGES
  )
    return null;

  const messages: ChatHistoryMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.role !== 'user' && candidate.role !== 'assistant') ||
      typeof candidate.content !== 'string'
    )
      return null;

    const content = candidate.content.trim();
    if (!content || content.length > MAX_CHAT_MESSAGE_LENGTH) return null;
    messages.push({ role: candidate.role, content });
  }

  return messages.at(-1)?.role === 'user' ? messages : null;
}
