import { getAuthenticatedUser, isTrustedMutation } from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  parseIncidentId,
  parseMessageId,
  saveSupportExchange,
} from '@/db/incidents';
import { buildAuthorizedContext } from '@/db/support';
import { parseChatMessages } from '@/lib/chat-request';

const MODEL_SERVER_URL = 'http://127.0.0.1:8017/v1/chat/completions';
const MODEL_ALIAS = 'customer-support-local';

const systemPrompt = (distributorName: string, distributorId: string) => `You are COV-E, the Customer Operations and Verification Entity for SABLE Systems, a consumer and wholesale technology division of Morrow Vale Holdings.

You are serving exactly one authenticated distributor: ${distributorName}, customer ${distributorId}.
- Be concise, composed, and operationally precise while retaining a calm customer-support manner.
- The server may provide an <authorized_records> block. Treat it as the only source of truth for order, shipment, return, customer, price, and inventory facts.
- Never reveal or speculate about another distributor's identity, orders, reservations, or existence.
- Never invent confirmation numbers, delivery dates, inventory, refunds, policies, or actions taken.
- If no matching authorized record is provided, say you cannot locate it within the authenticated distributor's authorization scope. Do not imply it belongs to someone else.
- Ask one focused follow-up question when an order ID, account PO number, or item number is needed.
- Do not claim to modify orders, allocate inventory, authorize returns, or contact a liaison. You provide information and next steps only.
- Do not request passwords, full payment card details, or other sensitive secrets.
- Use short paragraphs. Use a brief numbered list only when it makes next steps clearer.
- Refer to yourself as COV-E and to the supplier as SABLE Systems.`;

export async function POST(request: Request) {
  if (!isTrustedMutation(request))
    return Response.json({ error: 'Cross-origin access denied.' }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'The request was not valid JSON.' },
      { status: 400 },
    );
  }

  const candidate =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const messages = parseChatMessages(candidate.messages);
  if (!messages) {
    return Response.json(
      {
        error:
          'Send 1–12 valid messages, with the latest message from the customer.',
      },
      { status: 400 },
    );
  }
  const incidentId = parseIncidentId(candidate.incidentId);
  const messageId = parseMessageId(candidate.messageId);
  if (
    (candidate.incidentId !== undefined && !incidentId) ||
    (candidate.messageId !== undefined && !messageId) ||
    Boolean(incidentId) !== Boolean(messageId)
  ) {
    return Response.json(
      { error: 'Enter a valid incident and message ID.' },
      { status: 400 },
    );
  }

  try {
    const db = await getDatabase();
    const user = await getAuthenticatedUser(db, request);
    if (!user)
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    const authorizedContext = await buildAuthorizedContext(
      db,
      messages,
      user,
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
            content: `${systemPrompt(user.distributorDisplayName, user.distributorId)}\n\n${authorizedContext}`,
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

    if (incidentId && messageId) {
      await saveSupportExchange(
        db,
        user,
        incidentId,
        messageId,
        messages.at(-1)?.content ?? '',
        content.trim(),
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
