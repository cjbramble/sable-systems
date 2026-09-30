import { describe, expect, it } from 'vitest';

import {
  buildChatRequestHistory,
  fitChatHistoryToBudget,
  type ChatHistoryMessage,
} from '@/lib/chat-history';
import { createSupportModelRequest } from '@/lib/support-model';
import {
  SUPPORT_MODEL_CONTEXT_TOKENS,
  SUPPORT_MODEL_MAX_REPLY_TOKENS,
} from '@/lib/support-model-config.mjs';

const exchange = (index: number, length: number): ChatHistoryMessage[] => [
  { role: 'user', content: `Question ${index} `.padEnd(length, 'q') },
  { role: 'assistant', content: `Answer ${index} `.padEnd(length, 'a') },
];

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

  it('drops the oldest messages until the history fits its character budget', () => {
    const messages = [1, 2, 3].flatMap((index) => exchange(index, 100));
    messages.push({ role: 'user', content: 'Latest question' });
    const original = structuredClone(messages);

    expect(fitChatHistoryToBudget(messages, 10_000)).toEqual(messages);
    // Question 3, Answer 3 and the latest message fit; Answer 2 would exceed.
    expect(fitChatHistoryToBudget(messages, 300)).toEqual(messages.slice(4));
    expect(messages).toEqual(original);
  });

  it('starts trimmed history with a customer message and always keeps the latest', () => {
    const messages = [1, 2].flatMap((index) => exchange(index, 100));
    messages.push({ role: 'user', content: 'L'.repeat(500) });

    // Answer 2 alone would fit with the latest message, but not its question.
    expect(fitChatHistoryToBudget(messages, 650)).toEqual([messages.at(-1)]);
    expect(fitChatHistoryToBudget(messages, 10)).toEqual([messages.at(-1)]);
    // Untrimmed history is passed through as submitted.
    expect(fitChatHistoryToBudget(messages.slice(1), 10_000)).toEqual(
      messages.slice(1),
    );
  });

  it('keeps model requests within the hosted prompt budget', () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      exchange(index + 1, 4_000),
    ).flat();
    messages.push({ role: 'user', content: 'Where is order SBL-2022-000118?' });
    const [, request] = createSupportModelRequest({
      distributorName: 'Calder Pike Distribution',
      distributorId: 'WHS-0427',
      authorizedContext:
        '<authorized_records>\nNo records.\n</authorized_records>',
      messages,
    });
    const body = JSON.parse(request.body as string) as {
      messages: ChatHistoryMessage[];
      max_tokens: number;
    };
    const promptCharacters = body.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    expect(body.max_tokens).toBe(SUPPORT_MODEL_MAX_REPLY_TOKENS);
    // A deliberately conservative 2.5 characters per token.
    expect(promptCharacters / 2.5).toBeLessThanOrEqual(
      SUPPORT_MODEL_CONTEXT_TOKENS - SUPPORT_MODEL_MAX_REPLY_TOKENS,
    );
    expect(body.messages.at(-1)).toEqual(messages.at(-1));
    expect(body.messages[1].role).toBe('user');
    expect(body.messages.length).toBeLessThan(messages.length + 1);
  });
});
