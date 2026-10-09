import type { SupportCommand, SupportReply } from './chat-request';
import {
  createIncidentTitle,
  type SupportChatMessage,
  type SupportIncident,
} from './support-incidents';
import { reconcileSupportSnapshot } from './support-reconciliation';

type ExchangeCommand = { request: SupportCommand; createdAt: string };
export type SupportExchange = ExchangeCommand &
  (
    | { status: 'pending'; wasUncertain: boolean }
    | { status: 'failed' | 'uncertain'; error: string }
  );
export type SupportRecovery = {
  message: string | null;
  status: 'stale' | 'ready';
  error?: string;
};
export type SupportConversationState = {
  incidents: SupportIncident[];
  activeIncidentId: string | null;
  drafts: Record<string, string>;
  exchanges: Record<string, SupportExchange>;
  recoveries: Record<string, SupportRecovery>;
  deletedMessages: string[];
};
export type SupportConversationAction =
  | { type: 'load'; incidents: SupportIncident[] }
  | { type: 'reset' }
  | { type: 'select'; incidentId: string }
  | { type: 'edit'; incidentId: string; message: string }
  | { type: 'new'; incidentId: string; createdAt: string }
  | {
      type: 'send';
      request: SupportCommand;
      createdAt: string;
      consumeDraft: boolean;
    }
  | { type: 'retry'; incidentId: string }
  | {
      type: 'failed';
      request: SupportCommand;
      error: string;
      requestNotSaved: boolean;
    }
  | { type: 'unconfirmed'; request: SupportCommand; error: string }
  | { type: 'confirmed'; request: SupportCommand; reply: SupportReply }
  | { type: 'reconciled'; request: SupportCommand; snapshot: SupportIncident }
  | { type: 'changed'; request: SupportCommand; snapshot?: SupportIncident }
  | { type: 'reloaded'; snapshot: SupportIncident }
  | { type: 'recoveryFailed'; incidentId: string; error: string }
  | { type: 'recoverUnsent'; incidentId: string }
  | { type: 'discardUnsent'; incidentId: string }
  | { type: 'discardFailed'; incidentId: string }
  | { type: 'remove'; incidentId: string }
  | { type: 'unavailable'; incidentId: string }
  | { type: 'recoverDeleted'; incidentId: string; createdAt: string }
  | { type: 'discardDeleted' };

const NEW_INCIDENT_TITLE = 'New service incident';

export function initialSupportConversation(): SupportConversationState {
  return {
    incidents: [],
    activeIncidentId: null,
    drafts: {},
    exchanges: {},
    recoveries: {},
    deletedMessages: [],
  };
}

export function supportDraft(
  state: SupportConversationState,
  incidentId: string | null = state.activeIncidentId,
): string {
  return incidentId === null ? '' : (state.drafts[incidentId] ?? '');
}

function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const remaining = { ...record };
  delete remaining[key];
  return remaining;
}

function newIncident(id: string, createdAt: string): SupportIncident {
  return {
    id,
    title: NEW_INCIDENT_TITLE,
    updatedAt: createdAt,
    revision: 0,
    messages: [],
  };
}

function hasIncident(
  state: SupportConversationState,
  incidentId: string,
): boolean {
  return state.incidents.some((incident) => incident.id === incidentId);
}

function matchingExchange(
  state: SupportConversationState,
  request: SupportCommand,
) {
  const exchange = state.exchanges[request.incidentId];
  return hasIncident(state, request.incidentId) &&
    exchange?.request.messageId === request.messageId
    ? exchange
    : undefined;
}

function replaceIncident(
  state: SupportConversationState,
  snapshot: SupportIncident,
) {
  return state.incidents.map((incident) =>
    incident.id === snapshot.id ? snapshot : incident,
  );
}

function mergeSavedPair(
  messages: SupportChatMessage[],
  request: SupportCommand,
  reply: SupportReply,
): SupportChatMessage[] {
  const customer: SupportChatMessage = {
    id: request.messageId,
    role: 'user',
    content: request.message,
    createdAt: reply.customerCreatedAt,
  };
  const assistant: SupportChatMessage = {
    id: `AST-${request.messageId}`,
    role: 'assistant',
    content: reply.message,
    createdAt: reply.assistantCreatedAt,
  };
  const saved = messages.map((message) =>
    message.id === customer.id
      ? customer
      : message.id === assistant.id
        ? assistant
        : message,
  );
  const customerIndex = saved.findIndex(
    (message) => message.id === customer.id,
  );
  const assistantIndex = saved.findIndex(
    (message) => message.id === assistant.id,
  );
  if (customerIndex === -1 && assistantIndex === -1)
    return [...saved, customer, assistant];
  if (customerIndex === -1) saved.splice(assistantIndex, 0, customer);
  else if (assistantIndex === -1) saved.splice(customerIndex + 1, 0, assistant);
  return saved;
}

function removeIncident(
  state: SupportConversationState,
  incidentId: string,
): SupportConversationState {
  const incidents = state.incidents.filter(
    (incident) => incident.id !== incidentId,
  );
  return {
    ...state,
    incidents,
    activeIncidentId:
      state.activeIncidentId === incidentId
        ? (incidents[0]?.id ?? null)
        : state.activeIncidentId,
    drafts: withoutKey(state.drafts, incidentId),
    exchanges: withoutKey(state.exchanges, incidentId),
    recoveries: withoutKey(state.recoveries, incidentId),
  };
}

export function supportConversationReducer(
  state: SupportConversationState,
  action: SupportConversationAction,
): SupportConversationState {
  switch (action.type) {
    case 'reset':
      return initialSupportConversation();
    case 'load':
      return {
        ...initialSupportConversation(),
        incidents: action.incidents,
        activeIncidentId: action.incidents[0]?.id ?? null,
      };
    case 'select':
      return hasIncident(state, action.incidentId) &&
        state.activeIncidentId !== action.incidentId
        ? { ...state, activeIncidentId: action.incidentId }
        : state;
    case 'edit': {
      if (!hasIncident(state, action.incidentId)) return state;
      const key = action.incidentId;
      return {
        ...state,
        drafts: action.message
          ? { ...state.drafts, [key]: action.message }
          : withoutKey(state.drafts, key),
      };
    }
    case 'new':
      if (hasIncident(state, action.incidentId)) return state;
      return {
        ...state,
        incidents: [
          newIncident(action.incidentId, action.createdAt),
          ...state.incidents,
        ],
        activeIncidentId: action.incidentId,
      };
    case 'send': {
      const { request, createdAt } = action;
      const { incidentId } = request;
      const recovery = state.recoveries[incidentId];
      if (
        state.exchanges[incidentId] ||
        recovery?.status === 'stale' ||
        recovery?.message
      )
        return state;
      const existing = state.incidents.find(
        (incident) => incident.id === incidentId,
      );
      const incident = existing ?? newIncident(incidentId, createdAt);
      const submitted =
        incident.messages.length === 0
          ? { ...incident, title: createIncidentTitle(request.message) }
          : incident;
      return {
        ...state,
        incidents: existing
          ? replaceIncident(state, submitted)
          : [submitted, ...state.incidents],
        activeIncidentId: existing ? state.activeIncidentId : incidentId,
        drafts: action.consumeDraft
          ? withoutKey(state.drafts, incidentId)
          : state.drafts,
        exchanges: {
          ...state.exchanges,
          [incidentId]: {
            status: 'pending',
            request,
            createdAt,
            wasUncertain: false,
          },
        },
        recoveries: withoutKey(state.recoveries, incidentId),
      };
    }
    case 'retry': {
      const exchange = state.exchanges[action.incidentId];
      if (!exchange || exchange.status === 'pending') return state;
      return {
        ...state,
        exchanges: {
          ...state.exchanges,
          [action.incidentId]: {
            status: 'pending',
            request: exchange.request,
            createdAt: exchange.createdAt,
            wasUncertain: exchange.status === 'uncertain',
          },
        },
      };
    }
    case 'failed':
    case 'unconfirmed': {
      const exchange = matchingExchange(state, action.request);
      if (!exchange) return state;
      const definitelyUnsaved =
        action.type === 'failed' &&
        action.requestNotSaved &&
        exchange.status === 'pending' &&
        !exchange.wasUncertain;
      return {
        ...state,
        exchanges: {
          ...state.exchanges,
          [action.request.incidentId]: {
            status: definitelyUnsaved ? 'failed' : 'uncertain',
            request: exchange.request,
            createdAt: exchange.createdAt,
            error: action.error,
          },
        },
      };
    }
    case 'confirmed': {
      const exchange = matchingExchange(state, action.request);
      if (!exchange) return state;
      return {
        ...state,
        incidents: state.incidents.map((incident) =>
          incident.id === action.request.incidentId
            ? {
                ...incident,
                messages: mergeSavedPair(
                  incident.messages,
                  exchange.request,
                  action.reply,
                ),
                updatedAt: action.reply.incidentUpdatedAt,
                // A replay can predate unseen turns. Its receipt cannot claim their revision.
                revision: action.reply.revision,
              }
            : incident,
        ),
        exchanges: withoutKey(state.exchanges, action.request.incidentId),
      };
    }
    case 'reconciled':
      if (
        !matchingExchange(state, action.request) ||
        reconcileSupportSnapshot(action.snapshot, action.request) !==
          'confirmed'
      )
        return state;
      return {
        ...state,
        incidents: replaceIncident(state, action.snapshot),
        exchanges: withoutKey(state.exchanges, action.request.incidentId),
      };
    case 'changed': {
      const exchange = matchingExchange(state, action.request);
      if (
        !exchange ||
        (action.snapshot && action.snapshot.id !== action.request.incidentId)
      )
        return state;
      const { incidentId, message } = exchange.request;
      const hasDraft = supportDraft(state, incidentId).length > 0;
      return {
        ...state,
        incidents: action.snapshot
          ? replaceIncident(state, action.snapshot)
          : state.incidents,
        drafts: hasDraft
          ? state.drafts
          : { ...state.drafts, [incidentId]: message },
        exchanges: withoutKey(state.exchanges, incidentId),
        recoveries: {
          ...state.recoveries,
          [incidentId]: {
            status: action.snapshot ? 'ready' : 'stale',
            message: hasDraft ? message : null,
          },
        },
      };
    }
    case 'reloaded': {
      const recovery = state.recoveries[action.snapshot.id];
      if (!recovery || !hasIncident(state, action.snapshot.id)) return state;
      return {
        ...state,
        incidents: replaceIncident(state, action.snapshot),
        recoveries: {
          ...state.recoveries,
          [action.snapshot.id]: { status: 'ready', message: recovery.message },
        },
      };
    }
    case 'recoveryFailed': {
      const recovery = state.recoveries[action.incidentId];
      if (!recovery) return state;
      return {
        ...state,
        recoveries: {
          ...state.recoveries,
          [action.incidentId]: { ...recovery, error: action.error },
        },
      };
    }
    case 'recoverUnsent':
    case 'discardUnsent': {
      const recovery = state.recoveries[action.incidentId];
      if (
        !recovery?.message ||
        (action.type === 'recoverUnsent' &&
          supportDraft(state, action.incidentId))
      )
        return state;
      return {
        ...state,
        drafts:
          action.type === 'recoverUnsent'
            ? { ...state.drafts, [action.incidentId]: recovery.message }
            : state.drafts,
        recoveries: {
          ...state.recoveries,
          [action.incidentId]: { ...recovery, message: null },
        },
      };
    }
    case 'discardFailed':
      if (state.exchanges[action.incidentId]?.status !== 'failed') return state;
      return {
        ...state,
        exchanges: withoutKey(state.exchanges, action.incidentId),
        incidents: state.incidents.map((incident) =>
          incident.id === action.incidentId && incident.messages.length === 0
            ? { ...incident, title: NEW_INCIDENT_TITLE }
            : incident,
        ),
      };
    case 'remove':
    case 'unavailable': {
      if (!hasIncident(state, action.incidentId)) return state;
      const remaining = removeIncident(state, action.incidentId);
      if (action.type === 'remove') return remaining;
      const unsent = [
        state.exchanges[action.incidentId]?.request.message,
        state.recoveries[action.incidentId]?.message,
        supportDraft(state, action.incidentId),
      ].filter(
        (message): message is string =>
          typeof message === 'string' && message.length > 0,
      );
      return {
        ...remaining,
        deletedMessages: [...state.deletedMessages, ...unsent],
      };
    }
    case 'recoverDeleted': {
      const message = state.deletedMessages[0];
      if (!message || hasIncident(state, action.incidentId)) return state;
      return {
        ...state,
        incidents: [
          newIncident(action.incidentId, action.createdAt),
          ...state.incidents,
        ],
        activeIncidentId: action.incidentId,
        drafts: { ...state.drafts, [action.incidentId]: message },
        deletedMessages: state.deletedMessages.slice(1),
      };
    }
    case 'discardDeleted':
      return state.deletedMessages.length
        ? { ...state, deletedMessages: state.deletedMessages.slice(1) }
        : state;
  }
}
