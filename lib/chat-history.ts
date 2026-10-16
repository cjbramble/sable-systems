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
