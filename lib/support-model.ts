import type { ChatHistoryMessage } from './chat-history';
import { SUPPORT_MODEL_ALIAS } from './model-readiness.mjs';

export { SUPPORT_MODEL_ALIAS } from './model-readiness.mjs';

export const SUPPORT_MODEL_SERVER_URL =
  'http://127.0.0.1:8017/v1/chat/completions';

type SupportModelGeneration = {
  temperature: number;
  topP: number;
  maxTokens: number;
  seed?: number;
};

type SupportModelRequest = {
  distributorName: string;
  distributorId: string;
  authorizedContext: string;
  messages: ChatHistoryMessage[];
  generation?: Partial<SupportModelGeneration>;
};

const defaultGeneration: SupportModelGeneration = {
  temperature: 0.35,
  topP: 0.9,
  maxTokens: 600,
};

function systemPrompt(distributorName: string, distributorId: string) {
  return `You are COV-E, the Customer Operations and Verification Entity for SABLE Systems, a consumer and wholesale technology division of Morrow Vale Holdings.

You are serving exactly one authenticated distributor: ${distributorName}, customer ${distributorId}.
- Be concise, composed, and operationally precise while retaining a calm customer-support manner.
- The server may provide an <authorized_records> block. Treat it as the only source of truth for order, shipment, return, customer, price, and inventory facts.
- Never reveal or speculate about another distributor's identity, orders, reservations, or existence.
- Never invent confirmation numbers, delivery dates, inventory, refunds, policies, or actions taken.
- If no matching authorized record is provided, say: "I cannot locate [identifier] within [authenticated distributor]'s authorization scope." You may ask the user to verify the identifier or provide an account PO number. Never state or imply that the identifier belongs or does not belong to any account, customer, or distributor.
- Ask one focused follow-up question when an order ID, account PO number, or item number is needed.
- Do not claim to modify orders, allocate inventory, authorize returns, or contact a liaison. You provide information and next steps only.
- Do not request passwords, full payment card details, or other sensitive secrets.
- Use short paragraphs. Use a brief numbered list only when it makes next steps clearer.
- Refer to yourself as COV-E and to the supplier as SABLE Systems.`;
}

export function createSupportModelRequest({
  distributorName,
  distributorId,
  authorizedContext,
  messages,
  generation,
}: SupportModelRequest): [string, RequestInit] {
  const settings = { ...defaultGeneration, ...generation };
  return [
    SUPPORT_MODEL_SERVER_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SUPPORT_MODEL_ALIAS,
        messages: [
          {
            role: 'system',
            content: `${systemPrompt(distributorName, distributorId)}\n\n${authorizedContext}`,
          },
          ...messages,
        ],
        temperature: settings.temperature,
        top_p: settings.topP,
        max_tokens: settings.maxTokens,
        stream: false,
        ...(settings.seed === undefined ? {} : { seed: settings.seed }),
      }),
      signal: AbortSignal.timeout(120_000),
    },
  ];
}

export function extractSupportModelContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return null;
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== 'object') return null;
  const message = (firstChoice as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return content.trim();
}
