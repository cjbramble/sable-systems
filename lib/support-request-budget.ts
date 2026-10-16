import type { ChatHistoryMessage } from './chat-history';

type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type BudgetInput = {
  policy: string;
  records: string;
  history: readonly ChatHistoryMessage[];
  correction?: string;
  contextTokens: number;
  maxReplyTokens: number;
};

export type SupportRequestOverflow = {
  kind: 'overflow';
  limitingComponent: 'policy' | 'records' | 'message' | 'correction';
  estimatedTokens: number;
  message: string;
};

// This is a conservative heuristic, not the provider's tokenizer. Include JSON
// escaping and UTF-8 bytes, with a separate reserve for the chat template.
function estimateTokens(messages: ModelMessage[], maxReplyTokens: number) {
  const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  return Math.ceil(bytes / 2.5) + 128 + maxReplyTokens;
}

export function budgetSupportMessages({
  policy,
  records,
  history,
  correction,
  contextTokens,
  maxReplyTokens,
}: BudgetInput):
  | SupportRequestOverflow
  | {
      kind: 'ready';
      messages: ModelMessage[];
      estimatedTokens: number;
      droppedHistoryMessages: number;
    } {
  const latest = history.at(-1);
  if (latest?.role !== 'user')
    throw new Error('A current customer message is required.');
  if (
    !Number.isSafeInteger(contextTokens) ||
    contextTokens <= 0 ||
    !Number.isSafeInteger(maxReplyTokens) ||
    maxReplyTokens <= 0
  )
    throw new Error('Model token limits must be positive integers.');

  const fixed: ModelMessage[] = [
    { role: 'system', content: policy },
    { role: 'user', content: records },
  ];
  const suffix: ModelMessage[] = correction
    ? [{ role: 'user', content: correction }]
    : [];
  const mandatory = [...fixed, latest, ...suffix];
  const estimatedTokens = estimateTokens(mandatory, maxReplyTokens);
  if (estimatedTokens > contextTokens) {
    const limitingComponent =
      estimateTokens([fixed[0]], maxReplyTokens) > contextTokens
        ? 'policy'
        : correction &&
            estimateTokens([...fixed, latest], maxReplyTokens) <= contextTokens
          ? 'correction'
          : estimateTokens([fixed[1]], 0) >= estimateTokens([latest], 0)
            ? 'records'
            : 'message';
    const message =
      limitingComponent === 'message'
        ? 'Your message exceeds the estimated support model budget. Shorten it and try again.'
        : 'This request exceeds the estimated support model budget. Ask about one order or product and fewer details at a time.';
    return { kind: 'overflow', limitingComponent, estimatedTokens, message };
  }

  let start = 0;
  while (true) {
    const messages = [...fixed, ...history.slice(start), ...suffix].map(
      ({ role, content }) => ({ role, content }),
    );
    const estimatedTokens = estimateTokens(messages, maxReplyTokens);
    if (estimatedTokens <= contextTokens)
      return {
        kind: 'ready',
        messages,
        estimatedTokens,
        droppedHistoryMessages: start,
      };
    do {
      start += 1;
    } while (history[start].role !== 'user');
  }
}
