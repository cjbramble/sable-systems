import { expect, it } from 'vitest';
import { budgetSupportMessages } from '@/lib/support-request-budget';

const input = {
  policy: 'Support policy.',
  records: '{"records":"Order facts."}',
  history: [{ role: 'user' as const, content: 'Current question?' }],
  contextTokens: 8192,
  maxReplyTokens: 600,
};

it('includes serialized UTF-8 messages, template reserve, and reply reserve in its estimate', () => {
  const result = budgetSupportMessages({ ...input, records: 'é界\\"\n' });
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected ready request');
  const bytes = new TextEncoder().encode(
    JSON.stringify(result.messages),
  ).length;
  expect(result.estimatedTokens).toBe(Math.ceil(bytes / 2.5) + 128 + 600);
  expect(result.droppedHistoryMessages).toBe(0);
});

it('accepts an exact fit and rejects one token less without truncating mandatory content', () => {
  const result = budgetSupportMessages(input);
  expect(
    budgetSupportMessages({ ...input, contextTokens: result.estimatedTokens })
      .kind,
  ).toBe('ready');
  expect(
    budgetSupportMessages({
      ...input,
      contextTokens: result.estimatedTokens - 1,
    }).kind,
  ).toBe('overflow');
});

it.each(['policy', 'records'] as const)('reports oversized %s', (component) => {
  expect(
    budgetSupportMessages({ ...input, [component]: 'x'.repeat(30_000) }),
  ).toMatchObject({ kind: 'overflow', limitingComponent: component });
});

it('reports an oversized current message even with no older history', () => {
  expect(
    budgetSupportMessages({
      ...input,
      history: [{ role: 'user', content: 'x'.repeat(30_000) }],
    }),
  ).toMatchObject({ kind: 'overflow', limitingComponent: 'message' });
});

it('budgets correction growth by the same rule', () => {
  const first = budgetSupportMessages(input);
  expect(
    budgetSupportMessages({
      ...input,
      contextTokens: first.estimatedTokens,
      correction: 'Remove an invented resource.',
    }),
  ).toMatchObject({ kind: 'overflow', limitingComponent: 'correction' });
});

it('drops whole old exchanges, keeps the latest question, and never mutates history', () => {
  const history = [
    { role: 'user' as const, content: 'Old question'.repeat(20) },
    { role: 'assistant' as const, content: 'Old answer' },
    ...input.history,
  ];
  const original = structuredClone(history);
  const budget = budgetSupportMessages({
    ...input,
    history: history.slice(1),
  }).estimatedTokens;
  const result = budgetSupportMessages({
    ...input,
    history,
    contextTokens: budget,
  });
  expect(result).toMatchObject({ kind: 'ready', droppedHistoryMessages: 2 });
  if (result.kind !== 'ready') throw new Error('Expected ready request');
  expect(result.messages.slice(2)).toEqual(input.history);
  expect(result.messages[0].content).toBe(input.policy);
  expect(result.messages[1].content).toBe(input.records);
  result.messages.at(-1)!.content = 'Edited';
  expect(history).toEqual(original);
});

it('requires a latest customer message', () => {
  expect(() => budgetSupportMessages({ ...input, history: [] })).toThrow();
  expect(() =>
    budgetSupportMessages({
      ...input,
      history: [{ role: 'assistant', content: 'Answer' }],
    }),
  ).toThrow();
});
