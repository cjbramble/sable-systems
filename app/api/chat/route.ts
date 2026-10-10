import { getAuthenticatedUser, isTrustedMutation } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { consumeRequestQuota, requestLimitResponse } from '@/db/request-limits';
import {
  checkSupportCommand,
  IncidentDeletedError,
  getSupportConversationHistory,
  IncidentAccessDeniedError,
  listSupportIncidents,
  saveSupportExchange,
  SupportMessageIdConflictError,
  SupportMessageTextConflictError,
  SupportRevisionConflictError,
} from '@/db/incidents';
import { buildSupportContext } from '@/db/support';
import {
  parseSupportRequest,
  MAX_CHAT_REQUEST_BYTES,
  MAX_MODEL_RESPONSE_BYTES,
  MAX_SUPPORT_REPLY_LENGTH,
  type SupportResponse,
  type SupportFailure,
} from '@/lib/chat-request';
import { BodyTooLargeError, readJsonBody } from '@/lib/json-body';
import { formatIncidentListReply } from '@/lib/support-incidents';
import { classifySupportQuery } from '@/lib/support-query';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
  unsupportedSableResources,
} from '@/lib/support-response';
import {
  createSupportModelRequest,
  extractSupportModelContent,
  isIncompleteSupportModelReply,
  isContextOverflowPayload,
} from '@/lib/support-model';

const MAX_RESOURCE_ATTEMPTS = 2;

const failureResponses = {
  loading: {
    error: 'Support records could not be loaded. Please try again.',
    status: 500,
    code: 'request_not_saved',
  },
  model: {
    error: 'The support model is unavailable. Please try again.',
    status: 503,
    code: 'request_not_saved',
  },
  saving: {
    error:
      'We could not confirm your support message was saved. Please try again.',
    status: 500,
  },
} as const;

// This describes only this HTTP attempt; an earlier lost response may still
// have committed the same command. Saving failures must remain unclassified.
function unsavedResponse(
  failure: Pick<SupportFailure, 'error'>,
  init: ResponseInit,
) {
  return Response.json(
    { ...failure, code: 'request_not_saved' } satisfies SupportFailure,
    init,
  );
}

export async function POST(request: Request) {
  if (!isTrustedMutation(request))
    return unsavedResponse(
      { error: 'Cross-origin access denied.' },
      { status: 403 },
    );
  let body: unknown;
  try {
    body = await readJsonBody(request, MAX_CHAT_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return unsavedResponse(
        { error: 'The support request was too large.' },
        { status: 413 },
      );
    return unsavedResponse(
      { error: 'The request was not valid JSON.' },
      { status: 400 },
    );
  }

  const command = parseSupportRequest(body);
  if (!command)
    return unsavedResponse(
      {
        error:
          'Send a message of 1–4,000 characters. Saved conversations require incident/message IDs and a nonnegative integer expectedRevision; direct requests omit all three. The messages array is no longer supported.',
      },
      { status: 400 },
    );
  const { incidentId, messageId, message: customerMessage } = command;

  // Classify unexpected failures by the operation, never by private error text.
  let phase: keyof typeof failureResponses = 'loading';
  try {
    const db = await getDatabase();
    const user = await getAuthenticatedUser(db, request);
    if (!user)
      return unsavedResponse(
        { error: 'Authentication required.' },
        { status: 401 },
      );
    if (incidentId && messageId) {
      const replay = await checkSupportCommand(db, user, command);
      if (replay) return Response.json(replay);
    }

    // The model sees only saved incident history and the current customer message.
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
      if (content.length > MAX_SUPPORT_REPLY_LENGTH)
        return unsavedResponse(
          { error: 'The support reply was too long. Please try again.' },
          { status: 502 },
        );
      if (!incidentId || !messageId)
        return Response.json({ message: content } satisfies SupportResponse);
      phase = 'saving';
      return Response.json(
        await saveSupportExchange(
          db,
          user,
          incidentId,
          messageId,
          customerMessage,
          content,
          command.expectedRevision,
        ),
      );
    };

    // Incident lists are pure records: build them on the server so a
    // customer-written title cannot lead the model to hide or rewrite one.
    if (classifySupportQuery(history).kind === 'incidents')
      return await reply(
        formatIncidentListReply(await listSupportIncidents(db, user)),
      );

    const context = await buildSupportContext(db, history, user);
    if (context.kind === 'clarification') return await reply(context.message);
    const authorizedContext = context.records;
    const unavailable = unavailableRecordReply(context);
    if (unavailable) return await reply(unavailable);
    const retryAfter = await consumeRequestQuota(
      db,
      `chat:${user.userId}`,
      30,
      60,
    );
    if (retryAfter)
      return requestLimitResponse(retryAfter, 'request_not_saved');
    phase = 'model';
    let correction: string[] | undefined;
    for (let attempt = 1; ; attempt += 1) {
      const [modelUrl, modelRequest] = createSupportModelRequest({
        distributorName: user.distributorDisplayName,
        distributorId: user.distributorId,
        authorizedContext,
        messages: history,
        correction,
      });
      const modelResponse = await fetch(modelUrl, modelRequest);
      if (modelResponse.status >= 300 && modelResponse.status < 400) {
        await modelResponse.body?.cancel();
        return unsavedResponse(
          { error: failureResponses.model.error },
          { status: failureResponses.model.status },
        );
      }

      // Read success and error bodies under the same request deadline.
      let modelPayload: unknown = null;
      try {
        modelPayload = await readJsonBody(
          modelResponse,
          MAX_MODEL_RESPONSE_BYTES,
        );
      } catch (error) {
        if (error instanceof BodyTooLargeError)
          return unsavedResponse(
            {
              error:
                'The support model response was too large. Please try again.',
            },
            { status: 502 },
          );
        if (
          error instanceof DOMException &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        )
          throw error;
        if (modelResponse.ok)
          return unsavedResponse(
            {
              error:
                'The support model returned an invalid response. Please try again.',
            },
            { status: 502 },
          );
      }

      if (
        modelResponse.status === 400 &&
        isContextOverflowPayload(modelPayload)
      ) {
        return unsavedResponse(
          {
            error:
              'That message is too long for the support model. Shorten it and try again.',
          },
          { status: 422 },
        );
      }
      if (!modelResponse.ok) {
        return unsavedResponse(
          {
            error:
              'The support model could not complete that request. Please try again.',
          },
          { status: 502 },
        );
      }

      if (isIncompleteSupportModelReply(modelPayload)) {
        return unsavedResponse(
          {
            error:
              "The support model's reply was incomplete. Please try again.",
          },
          { status: 502 },
        );
      }
      const content = extractSupportModelContent(modelPayload);
      if (!content) {
        return unsavedResponse(
          {
            error:
              'The support model returned an empty response. Please try again.',
          },
          { status: 502 },
        );
      }

      if (!hasGroundedSupportIdentifiers(content, context)) {
        return unsavedResponse(
          {
            error:
              'The response contained an unverified record reference. Please try again.',
          },
          { status: 502 },
        );
      }

      const invented = unsupportedSableResources(content, authorizedContext);
      if (invented.length) {
        // Invented SABLE resources are intermittent: ask the model once more,
        // naming what to remove, before returning a retryable error. Nothing
        // invented is returned or saved.
        correction = invented;
        if (attempt < MAX_RESOURCE_ATTEMPTS) continue;
        return unsavedResponse(
          {
            error:
              'The response referred to an unverified SABLE resource. Please try again.',
          },
          { status: 502 },
        );
      }

      return await reply(content);
    }
  } catch (error) {
    if (
      phase === 'model' &&
      error instanceof DOMException &&
      error.name === 'TimeoutError'
    )
      return unsavedResponse(
        {
          error:
            'The support model took too long to respond. Please try again.',
        },
        { status: 504 },
      );
    if (
      error instanceof SupportMessageTextConflictError ||
      error instanceof SupportMessageIdConflictError
    )
      return unsavedResponse({ error: error.message }, { status: 409 });
    if (error instanceof SupportRevisionConflictError)
      return Response.json(
        {
          error: error.message,
          code: 'incident_changed',
        } satisfies SupportFailure,
        { status: 409 },
      );
    if (error instanceof IncidentDeletedError)
      return Response.json(
        {
          error: error.message,
          code: 'incident_deleted',
        } satisfies SupportFailure,
        { status: 410 },
      );
    if (error instanceof IncidentAccessDeniedError)
      return unsavedResponse(
        { error: 'Incident access denied.' },
        { status: 403 },
      );
    const { status, ...failure } = failureResponses[phase];
    return Response.json(failure, { status });
  }
}
