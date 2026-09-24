export type ChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export const MAX_CHAT_REQUEST_MESSAGES = 12;

export function buildChatRequestHistory(
  messages: ChatHistoryMessage[],
): ChatHistoryMessage[] {
  if (messages.at(-1)?.role !== 'user') return [];

  const recentMessages = messages.slice(-MAX_CHAT_REQUEST_MESSAGES);
  const firstCustomerMessage = recentMessages.findIndex(
    (message) => message.role === 'user',
  );

  if (firstCustomerMessage === -1) return [];

  return recentMessages
    .slice(firstCustomerMessage)
    .map(({ role, content }) => ({
      role,
      content,
    }));
}

// Drop the oldest messages until the conversation fits the character budget.
// The latest customer message is always kept, even when it alone exceeds it.
// A history that fits is unchanged; a trimmed one starts with a customer message.
export function fitChatHistoryToBudget(
  messages: ChatHistoryMessage[],
  maxCharacters: number,
): ChatHistoryMessage[] {
  let start = messages.length - 1;
  let used = messages[start]?.content.length ?? 0;
  while (
    start > 0 &&
    used + messages[start - 1].content.length <= maxCharacters
  ) {
    start -= 1;
    used += messages[start].content.length;
  }
  if (start > 0)
    while (start < messages.length - 1 && messages[start].role !== 'user')
      start += 1;
  return messages.slice(start);
}
