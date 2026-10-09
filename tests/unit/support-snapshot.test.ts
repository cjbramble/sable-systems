import { describe, expect, it } from 'vitest';
import {
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_SUPPORT_REPLY_LENGTH,
} from '@/lib/chat-request';
import type { AccountSummary } from '@/lib/contracts';
import type { SupportIncident } from '@/lib/support-incidents';
import {
  parseIncidentSnapshot,
  parseSupportAccount,
  parseSupportIncidents,
} from '@/lib/support-snapshot';

const account: AccountSummary = {
  customerId: 'CUST-ACCOUNT',
  displayName: 'Sable Customer',
  accountTier: 'Preferred',
  userId: 'USER-BUYER',
  userDisplayName: 'Sample Buyer',
  userRole: 'buyer',
  paymentTerms: 'Net 30',
  currency: 'USD',
  region: 'US',
  totalOrders: 7,
  activeOrders: 3,
  scheduledOrders: 1,
  inventoryAlerts: 2,
  seedAsOfDate: '2026-10-09',
  retrievedAt: '2026-10-09T12:00:00.000Z',
};

const incident: SupportIncident = {
  id: 'legacy incident / 1',
  title: '  Historical shipment question  ',
  updatedAt: '2026-10-09T12:00:00.000Z',
  revision: 0,
  messages: [
    {
      id: 'old customer message / 1',
      role: 'user',
      content: '  Where is my shipment?\n',
      createdAt: '2026-10-09T11:00:00.000Z',
    },
    {
      id: 'old assistant message / 1',
      role: 'assistant',
      content: '\nIt is in transit.  ',
      createdAt: '2026-10-09T12:00:00.000Z',
    },
  ],
};

describe('support account response decoding', () => {
  it('returns the full account contract without unvalidated extra fields', () => {
    expect(parseSupportAccount({ ...account, extra: true })).toEqual(account);
  });

  it.each(['account_admin', 'buyer', 'support'])(
    'accepts the %s account role',
    (userRole) => {
      expect(parseSupportAccount({ ...account, userRole })?.userRole).toBe(
        userRole,
      );
    },
  );

  it.each([null, [], undefined, 'account', 7, true, {}])(
    'rejects an invalid account envelope: %j',
    (value) => {
      expect(parseSupportAccount(value)).toBeNull();
    },
  );

  it.each(Object.keys(account))('requires the %s field', (field) => {
    const value: Record<string, unknown> = { ...account };
    delete value[field];
    expect(parseSupportAccount(value)).toBeNull();
  });

  it.each(['customerId', 'userId'])(
    'validates %s using the session subject contract',
    (field) => {
      for (const value of ['', '   ', 1, null, 'x'.repeat(129)]) {
        expect(parseSupportAccount({ ...account, [field]: value })).toBeNull();
      }
    },
  );

  it.each([
    'displayName',
    'accountTier',
    'userDisplayName',
    'paymentTerms',
    'currency',
    'region',
  ])('requires %s to be a string without adding text restrictions', (field) => {
    for (const value of [null, 42, true, {}, []]) {
      expect(parseSupportAccount({ ...account, [field]: value })).toBeNull();
    }
    for (const value of ['', '  unchanged text  ', 'x'.repeat(10_000)]) {
      expect(parseSupportAccount({ ...account, [field]: value })).toEqual({
        ...account,
        [field]: value,
      });
    }
  });

  it.each([
    'totalOrders',
    'activeOrders',
    'scheduledOrders',
    'inventoryAlerts',
  ])('requires %s to be a finite nonnegative safe count', (field) => {
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
    ]) {
      expect(parseSupportAccount({ ...account, [field]: value })).toBeNull();
    }
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      expect(parseSupportAccount({ ...account, [field]: value })).toEqual({
        ...account,
        [field]: value,
      });
    }
  });

  it.each(['admin', '', null, 0])('rejects an invalid role: %j', (userRole) => {
    expect(parseSupportAccount({ ...account, userRole })).toBeNull();
  });

  it.each(['2026-02-30', '2026-13-01', '2026-2-01', '', null, 0])(
    'rejects an invalid seed date: %j',
    (seedAsOfDate) => {
      expect(parseSupportAccount({ ...account, seedAsOfDate })).toBeNull();
    },
  );

  it.each(['yesterday', '2026-10-09', '2026-13-01T12:00:00Z', '', null, 0])(
    'rejects an invalid retrieval timestamp: %j',
    (retrievedAt) => {
      expect(parseSupportAccount({ ...account, retrievedAt })).toBeNull();
    },
  );

  it('accepts real leap days, timestamp offsets, and independent counts', () => {
    const value = {
      ...account,
      seedAsOfDate: '2024-02-29',
      retrievedAt: '2026-10-09T12:00:00+02:00',
      totalOrders: 0,
      activeOrders: 5,
      scheduledOrders: 6,
    };
    expect(parseSupportAccount(value)).toEqual(value);
  });
});

describe('saved support incident response decoding', () => {
  it('preserves incident and message order and text, returning canonical fields', () => {
    const second = { ...incident, id: 'another legacy incident' };
    expect(
      parseSupportIncidents({
        incidents: [
          {
            ...incident,
            extra: true,
            messages: incident.messages.map((message) => ({
              ...message,
              extra: true,
            })),
          },
          second,
        ],
      }),
    ).toEqual([incident, second]);
  });

  it('accepts empty incident lists and incidents without saved messages', () => {
    expect(parseSupportIncidents({ incidents: [] })).toEqual([]);
    expect(
      parseSupportIncidents({ incidents: [{ ...incident, messages: [] }] }),
    ).toEqual([{ ...incident, messages: [] }]);
  });

  it('accepts historical messages beyond current new-message limits', () => {
    const historical = {
      ...incident,
      messages: [
        {
          ...incident.messages[0],
          content: 'q'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1),
        },
        {
          ...incident.messages[1],
          content: 'a'.repeat(MAX_SUPPORT_REPLY_LENGTH + 1),
        },
      ],
    };
    const envelope = { incidents: [historical] };
    expect(parseSupportIncidents(envelope)).toEqual([historical]);
    expect(parseIncidentSnapshot(envelope, historical.id)).toEqual(historical);
  });

  it.each([null, [], {}, { incidents: null }, { incidents: {} }])(
    'rejects an invalid list envelope: %j',
    (value) => {
      expect(parseSupportIncidents(value)).toBeNull();
    },
  );

  it.each([
    null,
    [],
    {},
    { id: '' },
    { id: 7 },
    { title: '' },
    { title: 'x'.repeat(121) },
    { title: null },
    { revision: -1 },
    { revision: 0.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: Infinity },
    { revision: '1' },
    { updatedAt: 'yesterday' },
    { updatedAt: null },
    { messages: null },
    { messages: {} },
  ])('rejects a malformed incident in the full list: %j', (invalid) => {
    const malformed =
      invalid && !Array.isArray(invalid) && Object.keys(invalid).length
        ? { ...incident, id: 'other incident', ...invalid }
        : invalid;
    expect(
      parseSupportIncidents({ incidents: [incident, malformed] }),
    ).toBeNull();
  });

  it.each(['id', 'title', 'revision', 'updatedAt', 'messages'])(
    'requires each incident %s field',
    (field) => {
      const value: Record<string, unknown> = { ...incident };
      delete value[field];
      expect(parseSupportIncidents({ incidents: [value] })).toBeNull();
    },
  );

  it.each([
    null,
    [],
    {},
    { id: '' },
    { id: 7 },
    { role: 'system' },
    { role: null },
    { content: '' },
    { content: null },
    { content: 4 },
    { createdAt: null },
    { createdAt: '2026-10-09' },
    { createdAt: 'invalid' },
  ])(
    'rejects malformed saved messages through both entry points: %j',
    (invalid) => {
      const malformed =
        invalid && !Array.isArray(invalid) && Object.keys(invalid).length
          ? { ...incident.messages[0], ...invalid }
          : invalid;
      const envelope = { incidents: [{ ...incident, messages: [malformed] }] };
      expect(parseSupportIncidents(envelope)).toBeNull();
      expect(() => parseIncidentSnapshot(envelope, incident.id)).toThrow(
        'The conversation could not be reloaded. Please try again.',
      );
    },
  );

  it.each(['id', 'role', 'content', 'createdAt'])(
    'requires each saved message %s field',
    (field) => {
      const message: Record<string, unknown> = { ...incident.messages[0] };
      delete message[field];
      const envelope = { incidents: [{ ...incident, messages: [message] }] };
      expect(parseSupportIncidents(envelope)).toBeNull();
      expect(() => parseIncidentSnapshot(envelope, incident.id)).toThrow();
    },
  );

  it('rejects duplicate incident IDs', () => {
    expect(
      parseSupportIncidents({ incidents: [incident, incident] }),
    ).toBeNull();
  });

  it('rejects duplicate message IDs within each incident', () => {
    const envelope = {
      incidents: [
        {
          ...incident,
          messages: [incident.messages[0], incident.messages[0]],
        },
      ],
    };
    expect(parseSupportIncidents(envelope)).toBeNull();
    expect(() => parseIncidentSnapshot(envelope, incident.id)).toThrow();
  });
});

describe('target support snapshot decoding', () => {
  it('ignores unrelated malformed contents and duplicate unrelated IDs', () => {
    const envelope = {
      incidents: [{ id: '' }, { id: '' }, incident, { id: 'unrelated' }],
    };
    expect(parseIncidentSnapshot(envelope, incident.id)).toEqual(incident);
    expect(parseIncidentSnapshot(envelope, 'absent')).toBeNull();
  });

  it('returns null only for absence from a valid envelope', () => {
    expect(parseIncidentSnapshot({ incidents: [] }, incident.id)).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { incidents: null },
    { incidents: [null] },
    { incidents: [{}] },
    { incidents: [{ id: 3 }] },
  ])('keeps malformed envelopes retryable with a safe error: %j', (value) => {
    expect(() => parseIncidentSnapshot(value, incident.id)).toThrow(
      'The conversation could not be reloaded. Please try again.',
    );
  });

  it('rejects malformed unrelated envelope IDs even when the target exists', () => {
    expect(() =>
      parseIncidentSnapshot({ incidents: [incident, {}] }, incident.id),
    ).toThrow();
  });

  it('rejects duplicate target IDs', () => {
    expect(() =>
      parseIncidentSnapshot({ incidents: [incident, incident] }, incident.id),
    ).toThrow();
  });

  it.each([
    { title: '' },
    { title: 'x'.repeat(121) },
    { revision: -1 },
    { updatedAt: 'invalid' },
    { messages: null },
  ])('keeps malformed target snapshots retryable: %j', (invalid) => {
    expect(() =>
      parseIncidentSnapshot(
        { incidents: [{ ...incident, ...invalid }] },
        incident.id,
      ),
    ).toThrow('The conversation could not be reloaded. Please try again.');
  });
});
