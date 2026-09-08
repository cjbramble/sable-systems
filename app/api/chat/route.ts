import { getAuthenticatedUser, isTrustedMutation } from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  canAccessSupportIncident,
  getSavedSupportExchange,
  parseIncidentId,
  parseMessageId,
  saveSupportExchange,
} from '@/db/incidents';
import { buildAuthorizedContext } from '@/db/support';
import { parseChatMessages } from '@/lib/chat-request';
import { hasGroundedSupportIdentifiers } from '@/lib/support-response';
import {
  createSupportModelRequest,
  extractSupportModelContent,
} from '@/lib/support-model';

export async function POST(request: Request) {
  if (!isTrustedMutation(request))
    return Response.json(
      { error: 'Cross-origin access denied.' },
      { status: 403 },
    );
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
      return Response.json(
        { error: 'Authentication required.' },
        { status: 401 },
      );
    const customerMessage = messages.at(-1)?.content ?? '';
    if (incidentId && messageId) {
      if (!(await canAccessSupportIncident(db, user, incidentId)))
        return Response.json(
          { error: 'Incident access denied.' },
          { status: 403 },
        );
      const savedExchange = await getSavedSupportExchange(
        db,
        user,
        incidentId,
        messageId,
      );
      if (savedExchange) {
        if (savedExchange.customerMessage !== customerMessage)
          return Response.json(
            {
              error:
                'This message ID was already used for different text. Send a new message.',
            },
            { status: 409 },
          );
        if (savedExchange.assistantMessage !== null)
          return Response.json({ message: savedExchange.assistantMessage });
      }
    }

    const authorizedContext = await buildAuthorizedContext(db, messages, user);
    const [modelUrl, modelRequest] = createSupportModelRequest({
      distributorName: user.distributorDisplayName,
      distributorId: user.distributorId,
      authorizedContext,
      messages,
    });
    const modelResponse = await fetch(modelUrl, modelRequest);

    if (!modelResponse.ok) {
      return Response.json(
        {
          error:
            'The local model could not complete that request. Please try again.',
        },
        { status: 502 },
      );
    }

    const content = extractSupportModelContent(await modelResponse.json());
    if (!content) {
      return Response.json(
        {
          error:
            'The local model returned an empty response. Please try again.',
        },
        { status: 502 },
      );
    }

    if (!hasGroundedSupportIdentifiers(content, authorizedContext)) {
      return Response.json(
        {
          error:
            'The response contained an unverified record reference. Please try again.',
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
        customerMessage,
        content,
      );
    }

    return Response.json({ message: content });
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
