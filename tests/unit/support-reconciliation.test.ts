import { describe, expect, it } from 'vitest';
import type { SupportCommand } from '@/lib/chat-request';
import type { SupportIncident } from '@/lib/support-incidents';
import { reconcileSupportSnapshot } from '@/lib/support-reconciliation';
import { parseIncidentSnapshot } from '@/lib/support-snapshot';

const request: SupportCommand = {
  incidentId: 'INC-RECONCILIATION',
  messageId: 'MSG-RECONCILIATION',
  message: 'Where is the shipment?',
  expectedRevision: 2,
};
const snapshot: SupportIncident = {
  id: request.incidentId,
  title: 'Shipment',
  revision: 3,
  updatedAt: '2026-10-09T12:00:00.000Z',
  messages: [
    {
      id: request.messageId,
      role: 'user',
      content: request.message,
      createdAt: '2026-10-09T12:00:00.000Z',
    },
    {
      id: `AST-${request.messageId}`,
      role: 'assistant',
      content: 'It is in transit.',
      createdAt: '2026-10-09T12:00:00.000Z',
    },
  ],
};

describe('unresolved support exchange reconciliation', () => {
  it('confirms only the exact customer message and its adjacent saved assistant', () => {
    expect(reconcileSupportSnapshot(snapshot, request)).toBe('confirmed');
    const wrongText = {
      ...snapshot,
      messages: [
        { ...snapshot.messages[0], content: 'Other question' },
        snapshot.messages[1],
      ],
    };
    const wrongRole = {
      ...snapshot,
      messages: [
        { ...snapshot.messages[0], role: 'assistant' as const },
        snapshot.messages[1],
      ],
    };
    const wrongReply = {
      ...snapshot,
      messages: [
        snapshot.messages[0],
        { ...snapshot.messages[1], id: 'AST-OTHER' },
      ],
    };
    const nonAdjacent = {
      ...snapshot,
      messages: [
        snapshot.messages[0],
        { ...snapshot.messages[0], id: 'MSG-OTHER' },
        snapshot.messages[1],
      ],
    };
    for (const invalid of [wrongText, wrongRole, wrongReply, nonAdjacent]) {
      expect(reconcileSupportSnapshot(invalid, request)).toBe('changed');
    }
  });

  it('keeps absent or unchanged snapshots uncertain because an older request may still commit', () => {
    expect(reconcileSupportSnapshot(null, request)).toBe('unconfirmed');
    expect(
      reconcileSupportSnapshot(
        { ...snapshot, revision: 2, messages: [] },
        request,
      ),
    ).toBe('unconfirmed');
    expect(
      reconcileSupportSnapshot({ ...snapshot, revision: 1 }, request),
    ).toBe('unconfirmed');
    expect(
      reconcileSupportSnapshot({ ...snapshot, id: 'INC-OTHER' }, request),
    ).toBe('unconfirmed');
    expect(
      parseIncidentSnapshot({ incidents: [] }, request.incidentId),
    ).toBeNull();
  });

  it('recognizes a higher revision without the pair as a conversation change', () => {
    expect(
      reconcileSupportSnapshot({ ...snapshot, messages: [] }, request),
    ).toBe('changed');
    expect(
      reconcileSupportSnapshot(
        { ...snapshot, messages: [snapshot.messages[0]] },
        request,
      ),
    ).toBe('changed');
  });

  it('permits confirmation at the baseline revision for historical saved exchanges', () => {
    expect(
      reconcileSupportSnapshot({ ...snapshot, revision: 2 }, request),
    ).toBe('confirmed');
  });
});
