import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildSupportContext } from '@/db/support';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import { requireSupportRecords } from '../assertions/support-context';
import { calderPikeUser } from '../fixtures/users';

const user = (content: string): ChatHistoryMessage => ({
  role: 'user',
  content,
});
const assistant = (content: string): ChatHistoryMessage => ({
  role: 'assistant',
  content,
});

async function context(messages: ChatHistoryMessage[]) {
  return buildSupportContext(await getDatabase(), messages, calderPikeUser);
}

describe('support conversation frame', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-12T15:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [['Is the Redline in stock? How much is it?'], 'SBL-RPC-12'],
    [
      ['Is the Aegis Hardware Firewall in stock and what does it cost?'],
      'SBL-AEG-4',
    ],
    [
      [
        'Is the Redline Power Cell R12 in stock?',
        'Yes, 312 cells are available.',
        'How much is it?',
      ],
      'SBL-RPC-12',
    ],
  ])(
    'looks up a product named without its item number: %j',
    async (contents, itemNumber) => {
      const messages = contents.map((content, index) =>
        index % 2 ? assistant(content) : user(content),
      );
      const { parts } = requireSupportRecords(await context(messages));
      expect(parts).toEqual([
        expect.objectContaining({
          kind: 'products',
          outcome: 'found',
          facts: [
            expect.objectContaining({
              product: expect.objectContaining({ item_number: itemNumber }),
            }),
          ],
        }),
      ]);
    },
  );

  it('looks up the one cancelled order the assistant named after a list', async () => {
    const { parts } = requireSupportRecords(
      await context([
        user('Show my cancelled orders'),
        assistant('You have one cancelled order: SBL-2023-000205.'),
        user('Why was it cancelled?'),
      ]),
    );
    expect(parts).toEqual([
      expect.objectContaining({
        kind: 'order',
        reference: expect.objectContaining({ identifier: 'SBL-2023-000205' }),
      }),
    ]);
  });

  it.each([
    'Was it delayed by a power outage?',
    'Is that order on hold for a security review?',
  ])(
    'keeps an order follow-up with an everyday category word: %s',
    async (question) => {
      const { parts } = requireSupportRecords(
        await context([
          user('What is the status of order SBL-2022-000118?'),
          assistant('SBL-2022-000118 was delivered on 2022-06-27.'),
          user(question),
        ]),
      );
      expect(parts).toEqual([
        expect.objectContaining({
          kind: 'order',
          reference: expect.objectContaining({
            identifier: 'SBL-2022-000118',
          }),
        }),
      ]);
    },
  );

  it.each([
    'Which warehouse did my last order ship from?',
    'When will my invoice be available?',
  ])(
    'does not answer an account question with the catalog: %s',
    async (question) => {
      const { parts } = requireSupportRecords(await context([user(question)]));
      for (const part of parts)
        expect(part.kind).not.toMatch(
          /^(?:product|catalog_category|inventory_advisories)$/,
        );
    },
  );
});
