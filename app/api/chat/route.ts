import { getAuthenticatedUser, isTrustedMutation } from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  canAccessSupportIncident,
  getSavedSupportExchange,
  getSupportConversationHistory,
  hasSupportMessageIdConflict,
  IncidentAccessDeniedError,
  listSupportIncidents,
  parseIncidentId,
  parseMessageId,
  saveSupportExchange,
  supportReply,
  SupportMessageIdConflictError,
  SupportMessageTextConflictError,
} from '@/db/incidents';
import { buildAuthorizedContext } from '@/db/support';
import { parseChatMessages } from '@/lib/chat-request';
import { formatIncidentListReply } from '@/lib/support-incidents';
import { classifySupportQuery } from '@/lib/support-query';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import {
  createSupportModelRequest,
  extractSupportModelContent,
  isIncompleteSupportModelReply,
  isContextOverflowResponse,
} from '@/lib/support-model';

const failureResponses = {
  loading: {
    error: 'Support records could not be loaded. Please try again.',
    status: 500,
  },
  model: {
    error:
      'The local model is not reachable. Start the app with `npm run dev` and try again.',
    status: 503,
  },
  saving: {
    error:
      'We could not confirm your support message was saved. Please try again.',
    status: 500,
  },
} as const;

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

  // Classify unexpected failures by the operation, never by private error text.
  let phase: keyof typeof failureResponses = 'loading';
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
      if (await hasSupportMessageIdConflict(db, incidentId, messageId))
        throw new SupportMessageIdConflictError();
      const savedExchange = await getSavedSupportExchange(
        db,
        user,
        incidentId,
        messageId,
      );
      if (savedExchange) {
        if (savedExchange.customerMessage !== customerMessage)
          throw new SupportMessageTextConflictError();
        if (savedExchange.assistantMessage !== null)
          return Response.json(supportReply(savedExchange));
      }
    }

    // Client history is validated for the request contract but never trusted:
    // the model sees saved incident messages plus the current customer message.
    const history =
      incidentId && messageId
        ? await getSupportConversationHistory(
            db,
            user,
            incidentId,
            messageId,
            customerMessage,
          )
        : [{ role: 'user' as const, content: customerMessage }];
    const reply = async (content: string) => {
      if (!incidentId || !messageId) return Response.json({ message: content });
      phase = 'saving';
      return Response.json(
        await saveSupportExchange(
          db,
          user,
          incidentId,
          messageId,
          customerMessage,
          content,
        ),
      );
    };

    // Incident lists are pure records: build them on the server so a
    // customer-written title cannot lead the model to hide or rewrite one.
    if (classifySupportQuery(history).kind === 'incidents')
      return await reply(
        formatIncidentListReply(await listSupportIncidents(db, user)),
      );

    const authorizedContext = await buildAuthorizedContext(db, history, user);
    const unavailable = unavailableRecordReply(authorizedContext);
    if (unavailable) return await reply(unavailable);
    phase = 'model';
    const [modelUrl, modelRequest] = createSupportModelRequest({
      distributorName: user.distributorDisplayName,
      distributorId: user.distributorId,
      authorizedContext,
      messages: history,
    });
    const modelResponse = await fetch(modelUrl, modelRequest);

    if (await isContextOverflowResponse(modelResponse)) {
      return Response.json(
        {
          error:
            'That message is too long for the local model. Shorten it and try again.',
        },
        { status: 422 },
      );
    }
    if (!modelResponse.ok) {
      return Response.json(
        {
          error:
            'The local model could not complete that request. Please try again.',
        },
        { status: 502 },
      );
    }

    let modelPayload: unknown;
    try {
      modelPayload = await modelResponse.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw error;
      return Response.json(
        {
          error:
            'The local model returned an invalid response. Please try again.',
        },
        { status: 502 },
      );
    }
    if (isIncompleteSupportModelReply(modelPayload)) {
      return Response.json(
        {
          error: "The local model's reply was incomplete. Please try again.",
        },
        { status: 502 },
      );
    }
    const content = extractSupportModelContent(modelPayload);
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

    return await reply(content);
  } catch (error) {
    if (
      phase === 'model' &&
      error instanceof DOMException &&
      error.name === 'TimeoutError'
    )
      return Response.json(
        {
          error: 'The local model took too long to respond. Please try again.',
        },
        { status: 504 },
      );
    if (
      error instanceof SupportMessageTextConflictError ||
      error instanceof SupportMessageIdConflictError
    )
      return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof IncidentAccessDeniedError)
      return Response.json(
        { error: 'Incident access denied.' },
        { status: 403 },
      );
    const failure = failureResponses[phase];
    return Response.json({ error: failure.error }, { status: failure.status });
  }
}
