import { describe, expect, it } from 'vitest';

import {
  buildChatRequestHistory,
  type ChatHistoryMessage,
} from '@/lib/chat-history';

describe('chat request history', () => {
  it('keeps recent customer-led context within the limit without changing the original conversation', () => {
    const messages: ChatHistoryMessage[] = Array.from(
      { length: 8 },
      (_, index): ChatHistoryMessage[] => [
        { role: 'user', content: `Question ${index + 1}` },
        { role: 'assistant', content: `Answer ${index + 1}` },
      ],
    ).flat();
    messages.push({ role: 'user', content: 'Question 9' });
    const original = structuredClone(messages);

    const history = buildChatRequestHistory(messages);

    // The last 12 messages start with Answer 3, whose question was dropped.
    expect(history).toEqual([
      { role: 'user', content: 'Question 4' },
      { role: 'assistant', content: 'Answer 4' },
      { role: 'user', content: 'Question 5' },
      { role: 'assistant', content: 'Answer 5' },
      { role: 'user', content: 'Question 6' },
      { role: 'assistant', content: 'Answer 6' },
      { role: 'user', content: 'Question 7' },
      { role: 'assistant', content: 'Answer 7' },
      { role: 'user', content: 'Question 8' },
      { role: 'assistant', content: 'Answer 8' },
      { role: 'user', content: 'Question 9' },
    ]);
    expect(history.length).toBeLessThanOrEqual(12);
    expect(messages).toEqual(original);

    // Editing a request payload must not alter messages displayed in the UI.
    history[0].content = 'Edited request content';
    history.pop();
    expect(messages).toEqual(original);
  });
});
