import { describe, expect, it } from 'vitest';
import type { SupportCommand, SupportReply } from '@/lib/chat-request';
import type { SupportIncident } from '@/lib/support-incidents';
import {
  initialSupportConversation,
  supportConversationReducer as reduce,
  supportDraft,
  type SupportConversationAction,
  type SupportConversationState,
} from '@/lib/support-conversation';

const createdAt = '2026-10-09T12:00:00.000Z';
const firstId = 'INC-FIRST-CONVERSATION';
const secondId = 'INC-SECOND-CONVERSATION';
const request: SupportCommand = {
  incidentId: firstId,
  messageId: 'MSG-FIRST-REQUEST',
  message: 'Please trace my shipment.',
  expectedRevision: 0,
};
const reply: SupportReply = {
  revision: 1,
  message: 'What is your order number?',
  customerCreatedAt: '2026-10-09T12:00:01.000Z',
  assistantCreatedAt: '2026-10-09T12:00:02.000Z',
  incidentUpdatedAt: '2026-10-09T12:00:02.000Z',
};
const incident = (id = firstId): SupportIncident => ({
  id,
  title: 'New service incident',
  updatedAt: createdAt,
  revision: 0,
  messages: [],
});
const snapshot: SupportIncident = {
  ...incident(),
  title: request.message,
  revision: 1,
  updatedAt: reply.incidentUpdatedAt,
  messages: [
    {
      id: request.messageId,
      role: 'user',
      content: request.message,
      createdAt: reply.customerCreatedAt,
    },
    {
      id: `AST-${request.messageId}`,
      role: 'assistant',
      content: reply.message,
      createdAt: reply.assistantCreatedAt,
    },
  ],
};

function loaded() {
  return reduce(initialSupportConversation(), {
    type: 'load',
    incidents: [incident(), incident(secondId)],
  });
}
function pending(state = loaded()) {
  return reduce(state, {
    type: 'send',
    request,
    createdAt,
    consumeDraft: true,
  });
}
function apply(
  state: SupportConversationState,
  ...actions: SupportConversationAction[]
) {
  return actions.reduce(reduce, state);
}

describe('support conversation drafts and exchanges', () => {
  it('preserves separate drafts through selection, no-op selection and new conversations', () => {
    const state = apply(
      loaded(),
      { type: 'edit', incidentId: firstId, message: 'First draft' },
      { type: 'select', incidentId: firstId },
      { type: 'select', incidentId: secondId },
      { type: 'edit', incidentId: secondId, message: 'Second draft' },
      { type: 'new', incidentId: 'INC-THIRD-CONVERSATION', createdAt },
    );
    expect(supportDraft(state, firstId)).toBe('First draft');
    expect(supportDraft(state, secondId)).toBe('Second draft');
    expect(supportDraft(state)).toBe('');
    expect(state.incidents[0]).toEqual(incident('INC-THIRD-CONVERSATION'));
    expect(reduce(state, { type: 'select', incidentId: 'INC-UNKNOWN' })).toBe(
      state,
    );
  });

  it('submits the first incident’s draft without putting pending text into saved history', () => {
    const before = apply(
      initialSupportConversation(),
      { type: 'new', incidentId: firstId, createdAt },
      { type: 'edit', incidentId: firstId, message: request.message },
    );
    const state = pending(before);
    expect(state.activeIncidentId).toBe(firstId);
    expect(state.incidents).toEqual([
      { ...incident(), title: request.message },
    ]);
    expect(state.exchanges[firstId]).toEqual({
      status: 'pending',
      request,
      createdAt,
      wasUncertain: false,
    });
    expect(supportDraft(state)).toBe('');
    expect(supportDraft(before)).toBe(request.message);
    expect(state.drafts).toEqual({});
  });

  it('keeps the first draft on its incident when a starter is sent', () => {
    const before = apply(
      initialSupportConversation(),
      { type: 'new', incidentId: firstId, createdAt },
      {
        type: 'edit',
        incidentId: firstId,
        message: 'An unfinished shipment question',
      },
    );
    const state = reduce(before, {
      type: 'send',
      request,
      createdAt,
      consumeDraft: false,
    });
    expect(state.activeIncidentId).toBe(firstId);
    expect(supportDraft(state)).toBe('An unfinished shipment question');
    expect(state.drafts).toEqual({
      [firstId]: 'An unfinished shipment question',
    });
    expect(state.exchanges[firstId].request).toEqual(request);
    expect(supportDraft(before)).toBe('An unfinished shipment question');
  });

  it('creates an owned pending incident for a starter without previous history', () => {
    const before = initialSupportConversation();
    const state = reduce(before, {
      type: 'send',
      request,
      createdAt,
      consumeDraft: false,
    });
    expect(state.activeIncidentId).toBe(firstId);
    expect(state.incidents).toEqual([
      { ...incident(), title: request.message },
    ]);
    expect(state.exchanges[firstId].request).toEqual(request);
    expect(state.drafts).toEqual({});
    expect(supportDraft(before)).toBe('');
    expect(supportDraft(state, null)).toBe('');
  });

  it('consumes only the sent draft and preserves drafts when a starter was sent', () => {
    const before = apply(
      loaded(),
      { type: 'edit', incidentId: firstId, message: 'First draft' },
      { type: 'edit', incidentId: secondId, message: 'Second draft' },
    );
    expect(supportDraft(pending(before), firstId)).toBe('');
    expect(supportDraft(pending(before), secondId)).toBe('Second draft');
    const starter = reduce(before, {
      type: 'send',
      request,
      createdAt,
      consumeDraft: false,
    });
    expect(supportDraft(starter, firstId)).toBe('First draft');
    expect(supportDraft(before, firstId)).toBe('First draft');
  });

  it('blocks dependent commands while pending, failed or uncertain', () => {
    const sending = pending();
    const failed = reduce(sending, {
      type: 'failed',
      request,
      error: 'Provider unavailable',
      requestNotSaved: true,
    });
    const uncertain = reduce(sending, {
      type: 'unconfirmed',
      request,
      error: 'No response',
    });
    for (const state of [sending, failed, uncertain]) {
      expect(
        reduce(state, {
          type: 'send',
          request: { ...request, messageId: 'MSG-DEPENDENT-REQUEST' },
          createdAt,
          consumeDraft: true,
        }),
      ).toBe(state);
      expect(state.incidents[0].messages).toEqual([]);
    }
  });

  it('retries the exact command and keeps a newer draft without losing prior uncertainty', () => {
    const state = apply(
      pending(),
      {
        type: 'failed',
        request,
        error: 'Connection lost',
        requestNotSaved: false,
      },
      { type: 'edit', incidentId: firstId, message: 'A follow-up draft' },
      { type: 'retry', incidentId: firstId },
    );
    expect(state.exchanges[firstId]).toEqual({
      status: 'pending',
      wasUncertain: true,
      request,
      createdAt,
    });
    const rejected = reduce(state, {
      type: 'failed',
      request,
      error: 'No quota for this retry',
      requestNotSaved: true,
    });
    expect(rejected.exchanges[firstId].status).toBe('uncertain');
    expect(supportDraft(rejected)).toBe('A follow-up draft');
  });

  it('discards only definitely unsaved requests and preserves newer text', () => {
    const state = apply(
      pending(),
      { type: 'failed', request, error: 'Not saved', requestNotSaved: true },
      { type: 'edit', incidentId: firstId, message: 'New text' },
    );
    const discarded = reduce(state, {
      type: 'discardFailed',
      incidentId: firstId,
    });
    expect(discarded.exchanges).toEqual({});
    expect(discarded.incidents[0].title).toBe('New service incident');
    expect(supportDraft(discarded)).toBe('New text');
    const unknown = reduce(pending(), {
      type: 'unconfirmed',
      request,
      error: 'Unknown',
    });
    expect(
      reduce(unknown, { type: 'discardFailed', incidentId: firstId }),
    ).toBe(unknown);
  });

  it('confirms only the matching request while keeping a newer draft and current selection', () => {
    const state = apply(
      pending(),
      { type: 'edit', incidentId: firstId, message: 'New draft' },
      { type: 'select', incidentId: secondId },
    );
    expect(
      reduce(state, {
        type: 'confirmed',
        request: { ...request, messageId: 'MSG-OTHER-REQUEST' },
        reply,
      }),
    ).toBe(state);
    const confirmed = reduce(state, { type: 'confirmed', request, reply });
    expect(confirmed.incidents[0]).toEqual(snapshot);
    expect(confirmed.exchanges).toEqual({});
    expect(supportDraft(confirmed, firstId)).toBe('New draft');
    expect(confirmed.activeIncidentId).toBe(secondId);
  });

  it('merges a historical receipt by ID in its original position without duplicating messages', () => {
    const laterMessages = [
      {
        id: 'MSG-LATER',
        role: 'user' as const,
        content: 'Later question',
        createdAt,
      },
      {
        id: 'AST-MSG-LATER',
        role: 'assistant' as const,
        content: 'Later answer',
        createdAt,
      },
    ];
    const state = pending(
      reduce(initialSupportConversation(), {
        type: 'load',
        incidents: [
          {
            ...snapshot,
            revision: 2,
            messages: [...snapshot.messages, ...laterMessages],
          },
        ],
      }),
    );
    const confirmed = reduce(state, {
      type: 'confirmed',
      request,
      reply: { ...reply, message: 'Saved answer' },
    });
    expect(confirmed.incidents[0].messages.map(({ id }) => id)).toEqual([
      request.messageId,
      `AST-${request.messageId}`,
      'MSG-LATER',
      'AST-MSG-LATER',
    ]);
    expect(confirmed.incidents[0].messages[1].content).toBe('Saved answer');
    expect(confirmed.incidents[0].revision).toBe(1);
  });

  it('uses canonical server ordering after checking a saved conversation', () => {
    const state = apply(
      pending(),
      { type: 'unconfirmed', request, error: 'Lost receipt' },
      { type: 'edit', incidentId: firstId, message: 'New draft' },
      { type: 'select', incidentId: secondId },
    );
    const canonical = { ...snapshot, title: 'Server title', revision: 3 };
    const reconciled = reduce(state, {
      type: 'reconciled',
      request,
      snapshot: canonical,
    });
    expect(reconciled.incidents[0]).toEqual(canonical);
    expect(reconciled.exchanges).toEqual({});
    expect(reconciled.activeIncidentId).toBe(secondId);
    expect(supportDraft(reconciled, firstId)).toBe('New draft');
    expect(
      reduce(state, { type: 'reconciled', request, snapshot: incident() }),
    ).toBe(state);
  });

  it('restores a rejected command to an empty draft and blocks sending until reload', () => {
    const stale = reduce(pending(), { type: 'changed', request });
    expect(supportDraft(stale)).toBe(request.message);
    expect(stale.recoveries[firstId]).toEqual({
      status: 'stale',
      message: null,
    });
    expect(stale.exchanges).toEqual({});
    expect(
      reduce(stale, { type: 'send', request, createdAt, consumeDraft: true }),
    ).toBe(stale);
    const latest = { ...incident(), revision: 1 };
    const ready = reduce(stale, { type: 'reloaded', snapshot: latest });
    expect(ready.incidents[0]).toEqual(latest);
    expect(ready.recoveries[firstId].status).toBe('ready');
    expect(supportDraft(ready)).toBe(request.message);
    const resent = reduce(ready, {
      type: 'send',
      request: {
        ...request,
        expectedRevision: 1,
        messageId: 'MSG-NEW-REQUEST',
      },
      createdAt,
      consumeDraft: true,
    });
    expect(resent.exchanges[firstId].status).toBe('pending');
    expect(resent.recoveries).toEqual({});
  });

  it('preserves both rejected text and a newer draft until the user resolves the extra text', () => {
    const state = apply(
      pending(),
      { type: 'edit', incidentId: firstId, message: 'Newer draft' },
      { type: 'changed', request, snapshot: { ...incident(), revision: 1 } },
    );
    expect(supportDraft(state)).toBe('Newer draft');
    expect(state.recoveries[firstId]).toEqual({
      status: 'ready',
      message: request.message,
    });
    expect(reduce(state, { type: 'recoverUnsent', incidentId: firstId })).toBe(
      state,
    );
    expect(
      reduce(state, { type: 'send', request, createdAt, consumeDraft: true }),
    ).toBe(state);
    const recovered = apply(
      state,
      { type: 'edit', incidentId: firstId, message: '' },
      { type: 'recoverUnsent', incidentId: firstId },
    );
    expect(supportDraft(recovered)).toBe(request.message);
    expect(recovered.recoveries[firstId].message).toBeNull();
    const discarded = reduce(state, {
      type: 'discardUnsent',
      incidentId: firstId,
    });
    expect(supportDraft(discarded)).toBe('Newer draft');
    expect(discarded.recoveries[firstId].message).toBeNull();
  });

  it('keeps both texts and unrelated selection while a reload fails and then succeeds', () => {
    const stale = apply(
      pending(),
      { type: 'edit', incidentId: firstId, message: 'Newer draft' },
      { type: 'changed', request },
      { type: 'select', incidentId: secondId },
      { type: 'edit', incidentId: secondId, message: 'Other draft' },
      { type: 'recoveryFailed', incidentId: firstId, error: 'Reload failed' },
    );
    expect(stale.recoveries[firstId].error).toBe('Reload failed');
    const reloaded = reduce(stale, {
      type: 'reloaded',
      snapshot: { ...incident(), revision: 1 },
    });
    expect(reloaded.recoveries[firstId]).toEqual({
      status: 'ready',
      message: request.message,
    });
    expect(supportDraft(reloaded, firstId)).toBe('Newer draft');
    expect(supportDraft(reloaded)).toBe('Other draft');
  });

  it('queues an unavailable incident’s submitted and newer draft text without clearing other drafts', () => {
    const state = apply(
      pending(),
      { type: 'edit', incidentId: firstId, message: 'Newer draft' },
      { type: 'edit', incidentId: secondId, message: 'Other draft' },
      { type: 'unavailable', incidentId: firstId },
    );
    expect(state.deletedMessages).toEqual([request.message, 'Newer draft']);
    expect(state.incidents.map(({ id }) => id)).toEqual([secondId]);
    expect(state.activeIncidentId).toBe(secondId);
    expect(supportDraft(state)).toBe('Other draft');
    expect(state.exchanges).toEqual({});
    const recovered = reduce(state, {
      type: 'recoverDeleted',
      incidentId: 'INC-RECOVERED',
      createdAt,
    });
    expect(recovered.activeIncidentId).toBe('INC-RECOVERED');
    expect(supportDraft(recovered)).toBe(request.message);
    expect(supportDraft(recovered, secondId)).toBe('Other draft');
    expect(recovered.deletedMessages).toEqual(['Newer draft']);
    expect(recovered.incidents[0].messages).toEqual([]);
    expect(
      reduce(recovered, { type: 'discardDeleted' }).deletedMessages,
    ).toEqual([]);
  });

  it('keeps a new draft selectable when recovering the last deleted conversation', () => {
    const unavailable = reduce(pending(initialSupportConversation()), {
      type: 'unavailable',
      incidentId: firstId,
    });
    expect(unavailable.activeIncidentId).toBeNull();
    const recovered = apply(
      unavailable,
      { type: 'new', incidentId: secondId, createdAt },
      {
        type: 'edit',
        incidentId: secondId,
        message: 'Fresh text after deletion',
      },
      { type: 'recoverDeleted', incidentId: 'INC-RECOVERED', createdAt },
    );
    expect(supportDraft(recovered)).toBe(request.message);
    const originalDraft = reduce(recovered, {
      type: 'select',
      incidentId: secondId,
    });
    expect(originalDraft.activeIncidentId).toBe(secondId);
    expect(supportDraft(originalDraft)).toBe('Fresh text after deletion');
    expect(originalDraft.drafts).toEqual({
      [secondId]: 'Fresh text after deletion',
      'INC-RECOVERED': request.message,
    });
  });

  it('queues rejected and newer draft text once, including text already restored to a draft', () => {
    const both = apply(
      pending(),
      { type: 'edit', incidentId: firstId, message: 'Newer draft' },
      { type: 'changed', request },
      { type: 'unavailable', incidentId: firstId },
    );
    expect(both.deletedMessages).toEqual([request.message, 'Newer draft']);
    const restored = apply(
      pending(),
      { type: 'changed', request },
      { type: 'unavailable', incidentId: firstId },
    );
    expect(restored.deletedMessages).toEqual([request.message]);
  });

  it('explicit deletion removes only its own local state without queuing text', () => {
    const state = apply(
      pending(),
      { type: 'edit', incidentId: firstId, message: 'Newer draft' },
      { type: 'edit', incidentId: secondId, message: 'Other draft' },
      { type: 'select', incidentId: secondId },
      { type: 'remove', incidentId: firstId },
    );
    expect(state.deletedMessages).toEqual([]);
    expect(state.exchanges).toEqual({});
    expect(supportDraft(state, firstId)).toBe('');
    expect(state.activeIncidentId).toBe(secondId);
    expect(supportDraft(state)).toBe('Other draft');
  });

  it('does not recreate a removed incident when an in-flight receipt or reload arrives', () => {
    const state = apply(pending(), { type: 'remove', incidentId: firstId });
    const late: SupportConversationAction[] = [
      { type: 'confirmed', request, reply },
      { type: 'reconciled', request, snapshot },
      { type: 'changed', request, snapshot },
      { type: 'reloaded', snapshot },
      { type: 'failed', request, error: 'Late failure', requestNotSaved: true },
    ];
    for (const action of late) expect(reduce(state, action)).toBe(state);
  });

  it('clears all subject-bound state on reset and replacement loading', () => {
    const state = apply(
      pending(),
      { type: 'edit', incidentId: firstId, message: 'New draft' },
      { type: 'changed', request },
      { type: 'unavailable', incidentId: firstId },
      { type: 'edit', incidentId: secondId, message: 'Other draft' },
    );
    expect(reduce(state, { type: 'reset' })).toEqual(
      initialSupportConversation(),
    );
    expect(
      reduce(state, {
        type: 'load',
        incidents: [incident('INC-OTHER-SUBJECT')],
      }),
    ).toEqual({
      ...initialSupportConversation(),
      incidents: [incident('INC-OTHER-SUBJECT')],
      activeIncidentId: 'INC-OTHER-SUBJECT',
    });
  });
});
