import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatRequestHistory,
  MAX_CHAT_REQUEST_MESSAGES,
  type ChatHistoryMessage,
} from '../lib/chat-history.ts';

void test('drops the canned assistant greeting from a new request', () => {
  const history = buildChatRequestHistory([
    { role: 'assistant', content: 'Welcome' },
    { role: 'user', content: 'Trace my order' },
  ]);

  assert.deepEqual(history, [{ role: 'user', content: 'Trace my order' }]);
});

void test('keeps a coherent recent window after a long conversation', () => {
  const messages: ChatHistoryMessage[] = [
    { role: 'assistant', content: 'Welcome' },
  ];

  for (let turn = 1; turn <= 6; turn += 1) {
    messages.push(
      { role: 'user', content: `Question ${turn}` },
      { role: 'assistant', content: `Answer ${turn}` },
    );
  }
  messages.push({ role: 'user', content: 'Latest question' });

  const history = buildChatRequestHistory(messages);

  assert.ok(history.length <= MAX_CHAT_REQUEST_MESSAGES);
  assert.equal(history[0]?.role, 'user');
  assert.deepEqual(history.at(-1), {
    role: 'user',
    content: 'Latest question',
  });
  assert.equal(
    history.some((message) => message.content === 'Welcome'),
    false,
  );
});

void test('does not build a request unless the latest message is from the customer', () => {
  assert.deepEqual(
    buildChatRequestHistory([{ role: 'assistant', content: 'Welcome' }]),
    [],
  );
});
