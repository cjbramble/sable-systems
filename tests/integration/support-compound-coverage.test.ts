import { describe, expect } from 'vitest';
import { POST as chat } from '@/app/api/chat/route';
import { buildSupportContext } from '@/db/support';
import { requireSupportRecords } from '../assertions/support-context';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('mixed account and record coverage', () => {
  test.for([
    [
      'What are my payment terms? Show order SBL-2022-000118.',
      ['account', 'order'],
    ],
    [
      'Show order SBL-2022-000118. What are my payment terms?',
      ['order', 'account'],
    ],
  ] as const)(
    'retrieves both parts in source order: %s',
    async ([message, kinds], { database }) => {
      const context = requireSupportRecords(
        await buildSupportContext(database, ask(message), calderPikeUser),
      );
      expect(context.parts.map(({ kind }) => kind)).toEqual(kinds);
      expect(context.records).toContain('payment terms: Net 45; currency: USD');
      expect(context.records).toContain(
        'Order: SBL-2022-000118; customer PO: CPD-PO-220118',
      );
      expect(context.records).toContain(
        `Part ${kinds.indexOf('account') + 1} of 2: account details`,
      );
      expect(context.records.match(/<\/?authorized_records>/g)).toHaveLength(2);
      expect(context.records).not.toContain('Meridian Civic Supply');
    },
  );

  test('preserves product quantity ownership across an account request', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Are 16 units of SBL-RPC-12 available? What are my payment terms? Show order SBL-2022-000118.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts.map(({ kind }) => kind)).toEqual([
      'products',
      'account',
      'order',
    ]);
    expect(context.records).toContain(
      'Requested quantity 16: valid case-pack multiple',
    );
    expect(context.records).toContain('Part 1 of 3: catalog request');
    expect(context.records).toContain('Part 2 of 3: account details');
    expect(context.records).toContain('Part 3 of 3: order SBL-2022-000118');
  });

  test('keeps a foreign record unavailable alongside the current account', async ({
    database,
  }) => {
    const foreign = await database
      .prepare(
        'SELECT order_id, customer_po_number FROM orders WHERE customer_id != ? LIMIT 1',
      )
      .bind(calderPikeUser.distributorId)
      .first<{ order_id: string; customer_po_number: string }>();
    if (!foreign) throw new Error('Missing foreign order fixture');
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(`What are my payment terms? Show order ${foreign.order_id}.`),
        calderPikeUser,
      ),
    );
    expect(context.parts).toMatchObject([
      { kind: 'account', outcome: 'found' },
      { kind: 'order', outcome: 'unavailable' },
    ]);
    expect(context.records).toContain('payment terms: Net 45');
    expect(context.records).not.toContain(foreign.customer_po_number);
  });

  test('does not retrieve an unrequested account section for a record description', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask('Show order SBL-2022-000118 with its billing currency.'),
        calderPikeUser,
      ),
    );
    expect(context.parts.map(({ kind }) => kind)).toEqual(['order']);
    expect(context.records).not.toContain(
      'Recent charge-account authorizations',
    );
  });

  test('saves and replays a reply covering both account and order details', async ({
    supportApi,
  }) => {
    const incidentId = 'INC-ACCOUNT-RECORD-COVERAGE';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply =
      'Your payment terms are Net 45 in USD. Order SBL-2022-000118 was delivered.';
    const model = supportApi.mockModel(reply);
    const payload = {
      incidentId,
      messageId: 'MSG-ACCOUNT-RECORD-COVERAGE',
      expectedRevision: 0,
      message: 'What are my payment terms? Show order SBL-2022-000118.',
    };
    const response = await chat(session.request(payload));
    expect(response.status).toBe(200);
    const body = await response.json();
    const modelBody = JSON.parse(model.mock.calls[0][1]?.body as string) as {
      messages: { content: string }[];
    };
    const { records } = JSON.parse(modelBody.messages[1].content) as {
      records: string;
    };
    expect(records).toContain('Part 1 of 2: account details');
    expect(records).toContain('Part 2 of 2: order SBL-2022-000118');
    expect((await supportApi.messageContents(incidentId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: reply })]),
    );
    const replay = await chat(session.request(payload));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    expect(model).toHaveBeenCalledOnce();
  });
});
