import { unsupportedSableResources } from '@/lib/support-resource-claims';
import { unsafeReplyLinks } from '@/lib/support-reply-links';
import type { AuthenticatedUser } from '@/db/auth';
import { consumeRequestQuota } from '@/db/request-limits';
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
import { buildSupportContext, loadSupportProductTerms } from '@/db/support';
import {
  MAX_MODEL_RESPONSE_BYTES,
  MAX_SUPPORT_REPLY_LENGTH,
  type SupportResponse,
  type SupportReply,
  type SupportRequest,
  type SupportFailure,
} from '@/lib/chat-request';
import { BodyTooLargeError, readJsonBody } from '@/lib/json-body';
import { formatIncidentListReply } from '@/lib/support-incidents';
import { classifySupportQueries } from '@/lib/support-query';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import {
  createSupportModelRequest,
  extractSupportModelContent,
  isIncompleteSupportModelReply,
  isContextOverflowPayload,
  hasSupportModelErrorEnvelope,
  type SupportCorrection,
} from '@/lib/support-model';
import { logServerError } from '@/lib/server-log';

const MAX_RESOURCE_ATTEMPTS = 2;
// Every new command, including server-built replies, does classification and
// database work before any model call. The model quota below is separate.
const SUPPORT_REQUESTS_PER_MINUTE = 60;

const failureOutcomes = {
  loading: {
    error: 'Support records could not be loaded. Please try again.',
    code: 'request_not_saved',
  },
  model: {
    error: 'The support model is unavailable. Please try again.',
    code: 'request_not_saved',
  },
  saving: {
    error:
      'We could not confirm your support message was saved. Please try again.',
  },
} as const;

type FailureReason =
  | 'loading'
  | 'model'
  | 'saving'
  | 'model_timeout'
  | 'conflict'
  | 'incident_changed'
  | 'incident_deleted'
  | 'access_denied'
  | 'context_overflow'
  | 'invalid_reply';

export type SupportAnswer =
  | { kind: 'answered'; reply: SupportResponse | SupportReply }
  | { kind: 'limited'; retryAfter: number }
  | {
      kind: 'failed';
      reason: FailureReason;
      failure: SupportFailure;
      retryAfter?: number;
    };

// An earlier lost response may already have committed this command. Only a
// confirmed pre-save failure is classified as unsaved; saving errors stay uncertain.
function unsavedFailure(
  failure: Pick<SupportFailure, 'error'>,
  reason: FailureReason,
): SupportAnswer {
  return {
    kind: 'failed',
    reason,
    failure: { ...failure, code: 'request_not_saved' },
  };
}

// Credential, credit, permission, rate-limit, and outage statuses mean the
// model could not answer at all. They are not bad replies.
function isProviderUnavailableStatus(status: number) {
  return [401, 402, 403, 429].includes(status) || status >= 500;
}

// Retry-After is either delta-seconds or an HTTP date; anything else is dropped.
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

// Log only the provider status and a fixed label: provider bodies can echo
// request content, and the request headers carry the API key.
function logProviderFailure(label: string, status: number) {
  logServerError(
    'support answer (model)',
    new Error(`${label}: HTTP ${status}`),
  );
}

function providerUnavailable(
  label: string,
  status: number,
  retryAfter?: number,
): SupportAnswer {
  logProviderFailure(label, status);
  return {
    kind: 'failed',
    reason: 'model',
    failure: failureOutcomes.model,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

// Callers supply a parsed command and authenticated identity. Ownership and
// lifecycle checks remain here so reuse cannot bypass them through cached replies.
export async function answerSupportMessage(
  db: D1Database,
  user: AuthenticatedUser,
  command: SupportRequest,
  fetchModel: typeof fetch = fetch,
): Promise<SupportAnswer> {
  const { incidentId, messageId, message: customerMessage } = command;
  let phase: keyof typeof failureOutcomes = 'loading';
  try {
    const chargeRequest = () =>
      consumeRequestQuota(
        db,
        `support:${user.userId}`,
        SUPPORT_REQUESTS_PER_MINUTE,
        60,
      );
    if (incidentId && messageId) {
      let replay: SupportReply | null;
      try {
        replay = await checkSupportCommand(db, user, command);
      } catch (error) {
        // A rejected command (stale revision, reused ID) still did the
        // preflight reads. Only a completed replay is free.
        const retryAfter = await chargeRequest();
        if (retryAfter) return { kind: 'limited', retryAfter };
        throw error;
      }
      if (replay) return { kind: 'answered', reply: replay };
    }
    const requestRetry = await chargeRequest();
    if (requestRetry) return { kind: 'limited', retryAfter: requestRetry };

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
    const reply = async (content: string): Promise<SupportAnswer> => {
      if (content.length > MAX_SUPPORT_REPLY_LENGTH)
        return unsavedFailure(
          { error: 'The support reply was too long. Please try again.' },
          'invalid_reply',
        );
      if (!incidentId || !messageId)
        return { kind: 'answered', reply: { message: content } };
      phase = 'saving';
      return {
        kind: 'answered',
        reply: await saveSupportExchange(
          db,
          user,
          incidentId,
          messageId,
          customerMessage,
          content,
          command.expectedRevision,
        ),
      };
    };

    // Single-topic incident lists are pure records: build them on the server so a
    // customer-written title cannot lead the model to hide or rewrite one.
    const intents = classifySupportQueries(
      history,
      await loadSupportProductTerms(db),
    );
    if (intents.length === 1 && intents[0].kind === 'incidents')
      return await reply(
        formatIncidentListReply(await listSupportIncidents(db, user)),
      );

    const context = await buildSupportContext(db, history, user, intents);
    if (context.kind === 'clarification') return await reply(context.message);
    const authorizedContext = context.records;
    const unavailable = unavailableRecordReply(context);
    if (unavailable) return await reply(unavailable);
    let correction: SupportCorrection | undefined;
    for (let attempt = 1; ; attempt += 1) {
      phase = 'model';
      const model = createSupportModelRequest({
        distributorName: user.distributorDisplayName,
        distributorId: user.distributorId,
        authorizedContext,
        messages: history,
        correction,
      });
      if (model.kind === 'overflow')
        return unsavedFailure({ error: model.message }, 'context_overflow');
      if (attempt === 1) {
        phase = 'loading';
        const retryAfter = await consumeRequestQuota(
          db,
          `chat:${user.userId}`,
          30,
          60,
        );
        if (retryAfter) return { kind: 'limited', retryAfter };
      }
      phase = 'model';
      const [modelUrl, modelRequest] = model.request;
      const modelResponse = await fetchModel(modelUrl, modelRequest);
      if (modelResponse.status >= 300 && modelResponse.status < 400) {
        await modelResponse.body?.cancel();
        return providerUnavailable('provider redirect', modelResponse.status);
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
          return unsavedFailure(
            {
              error:
                'The support model response was too large. Please try again.',
            },
            'invalid_reply',
          );
        if (
          error instanceof DOMException &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        )
          throw error;
        if (modelResponse.ok)
          return unsavedFailure(
            {
              error:
                'The support model returned an invalid response. Please try again.',
            },
            'invalid_reply',
          );
      }

      if (
        modelResponse.status === 400 &&
        isContextOverflowPayload(modelPayload)
      ) {
        return unsavedFailure(
          {
            error:
              'That message is too long for the support model. Shorten it and try again.',
          },
          'context_overflow',
        );
      }
      if (isProviderUnavailableStatus(modelResponse.status)) {
        return providerUnavailable(
          'provider unavailable',
          modelResponse.status,
          modelResponse.status === 429
            ? parseRetryAfter(modelResponse.headers.get('Retry-After'))
            : undefined,
        );
      }

      if (!modelResponse.ok) {
        logProviderFailure('provider rejected request', modelResponse.status);
        return unsavedFailure(
          {
            error:
              'The support model could not complete that request. Please try again.',
          },
          'invalid_reply',
        );
      }

      if (hasSupportModelErrorEnvelope(modelPayload))
        return providerUnavailable(
          'provider error envelope',
          modelResponse.status,
        );

      if (isIncompleteSupportModelReply(modelPayload)) {
        return unsavedFailure(
          {
            error:
              "The support model's reply was incomplete. Please try again.",
          },
          'invalid_reply',
        );
      }
      const content = extractSupportModelContent(modelPayload);
      if (!content) {
        return unsavedFailure(
          {
            error:
              'The support model returned an empty response. Please try again.',
          },
          'invalid_reply',
        );
      }

      if (!hasGroundedSupportIdentifiers(content, context)) {
        return unsavedFailure(
          {
            error:
              'The response contained an unverified record reference. Please try again.',
          },
          'invalid_reply',
        );
      }

      const invented = unsupportedSableResources(content);
      const links = unsafeReplyLinks(content);
      if (invented.length || links.length) {
        // Invented SABLE resources and steered links are intermittent: ask the
        // model once more, naming what to remove, before returning a retryable
        // error. Nothing rejected is returned or saved.
        correction = { resources: invented, links };
        if (attempt < MAX_RESOURCE_ATTEMPTS) continue;
        return unsavedFailure(
          {
            error: links.length
              ? 'The response contained an unverified link or address. Please try again.'
              : 'The response referred to an unverified SABLE resource. Please try again.',
          },
          'invalid_reply',
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
      return unsavedFailure(
        {
          error:
            'The support model took too long to respond. Please try again.',
        },
        'model_timeout',
      );
    if (
      error instanceof SupportMessageTextConflictError ||
      error instanceof SupportMessageIdConflictError
    )
      return unsavedFailure({ error: error.message }, 'conflict');
    if (error instanceof SupportRevisionConflictError)
      return {
        kind: 'failed',
        reason: 'incident_changed',
        failure: { error: error.message, code: 'incident_changed' },
      };
    if (error instanceof IncidentDeletedError)
      return {
        kind: 'failed',
        reason: 'incident_deleted',
        failure: { error: error.message, code: 'incident_deleted' },
      };
    if (error instanceof IncidentAccessDeniedError)
      return unsavedFailure(
        { error: 'Incident access denied.' },
        'access_denied',
      );
    logServerError(`support answer (${phase})`, error);
    return { kind: 'failed', reason: phase, failure: failureOutcomes[phase] };
  }
}
