import { getAuthenticatedUser, isTrustedMutation } from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  answerSupportMessage,
  type SupportAnswer,
} from '@/lib/answer-support-message';
import {
  parseSupportRequest,
  MAX_CHAT_REQUEST_BYTES,
  type SupportFailure,
} from '@/lib/chat-request';
import { BodyTooLargeError, readJsonBody } from '@/lib/json-body';
import { requestLimitResponse } from '@/lib/request-limit-response';

const failureStatuses: Record<
  Extract<SupportAnswer, { kind: 'failed' }>['reason'],
  number
> = {
  loading: 500,
  model: 503,
  saving: 500,
  model_timeout: 504,
  conflict: 409,
  incident_changed: 409,
  incident_deleted: 410,
  access_denied: 403,
  context_overflow: 422,
  invalid_reply: 502,
};

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
  try {
    const db = await getDatabase();
    const user = await getAuthenticatedUser(db, request);
    if (!user)
      return unsavedResponse(
        { error: 'Authentication required.' },
        { status: 401 },
      );
    const result = await answerSupportMessage(db, user, command);
    switch (result.kind) {
      case 'answered':
        return Response.json(result.reply);
      case 'limited':
        return requestLimitResponse(result.retryAfter, 'request_not_saved');
      case 'failed':
        return Response.json(result.failure, {
          status: failureStatuses[result.reason],
        });
    }
  } catch {
    return unsavedResponse(
      { error: 'Support records could not be loaded. Please try again.' },
      { status: 500 },
    );
  }
}
