import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';

type ClientMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const MODEL_SERVER_URL = 'http://127.0.0.1:8017/v1/chat/completions';
const MODEL_ALIAS = 'customer-support-local';
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 4_000;

const SYSTEM_PROMPT = `You are COV-E, the Customer Operations and Verification Entity for SABLE Systems, a consumer and wholesale technology division of Morrow Vale Holdings.

You are serving exactly one authenticated wholesaler: Calder Pike Distribution, customer WHS-0427.
- Be concise, composed, and operationally precise while retaining a calm customer-support manner.
- The server may provide an <authorized_records> block. Treat it as the only source of truth for order, shipment, return, customer, price, and inventory facts.
- Never reveal or speculate about another wholesaler's identity, orders, reservations, or existence.
- Never invent confirmation numbers, delivery dates, inventory, refunds, policies, or actions taken.
- If no matching authorized record is provided, say you cannot locate it within Calder Pike's authorization scope. Do not imply it belongs to someone else.
- Ask one focused follow-up question when an order ID, Calder Pike PO number, or item number is needed.
- Do not claim to modify orders, allocate inventory, authorize returns, or contact a liaison. You provide information and next steps only.
- Do not request passwords, full payment card details, or other sensitive secrets.
- Use short paragraphs. Use a brief numbered list only when it makes next steps clearer.
- Refer to yourself as COV-E and to the supplier as SABLE Systems.`;

function parseMessages(value: unknown): ClientMessage[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MESSAGES
  )
    return null;

  const messages: ClientMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.role !== 'user' && candidate.role !== 'assistant') ||
      typeof candidate.content !== 'string'
    )
      return null;

    const content = candidate.content.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) return null;
    messages.push({ role: candidate.role, content });
  }

  if (messages.at(-1)?.role !== 'user') return null;
  return messages;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'The request was not valid JSON.' },
      { status: 400 },
    );
  }

  const messages = parseMessages(
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).messages
      : null,
  );
  if (!messages) {
    return Response.json(
      {
        error:
          'Send 1–12 valid messages, with the latest message from the customer.',
      },
      { status: 400 },
    );
  }

  try {
    const db = await getDatabase();
    const authorizedContext = await buildAuthorizedContext(
      db,
      messages.at(-1)?.content ?? '',
    );
    const modelResponse = await fetch(MODEL_SERVER_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ALIAS,
        messages: [
          {
            role: 'system',
            content: `${SYSTEM_PROMPT}\n\n${authorizedContext}`,
          },
          ...messages,
        ],
        temperature: 0.35,
        top_p: 0.9,
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!modelResponse.ok) {
      return Response.json(
        {
          error:
            'The local model could not complete that request. Please try again.',
        },
        { status: 502 },
      );
    }

    const payload = (await modelResponse.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return Response.json(
        {
          error:
            'The local model returned an empty response. Please try again.',
        },
        { status: 502 },
      );
    }

    return Response.json({ message: content.trim() });
  } catch {
    return Response.json(
      {
        error:
          'The local model is not reachable. Start the app with `npm run dev` and try again.',
      },
      { status: 503 },
    );
  }
}
