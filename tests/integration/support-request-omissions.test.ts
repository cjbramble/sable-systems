import { unsupportedSableResources } from '@/lib/support-resource-claims';
import { describe, expect, onTestFinished, vi } from 'vitest';
import { POST as chat } from '@/app/api/chat/route';
import { buildSupportContext } from '@/db/support';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import { requireSupportRecords } from '../assertions/support-context';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];
const firstThree =
  'Show order SBL-2022-000118. Show order SBL-2026-000417. Show shipment SHP-2022-000012.';

describe('compound request omissions', () => {
  test.for([
    ['What are my payment terms?', 'account', 'account details'],
    ['Is SBL-RPC-12 available?', 'catalog', 'catalog request'],
    ['Show active orders containing SBL-RPC-12.', 'orders', 'order search'],
    [
      'Show customer PO PRIVATE-FOURTH.',
      'order',
      'PRIVATE-FOURTH (customer PO)',
    ],
    [
      'Show tracking reference TRACK-FOURTH.',
      'shipment',
      'TRACK-FOURTH (tracking reference)',
    ],
    ['Show return RTN-UNKNOWN-999.', 'return', 'RTN-UNKNOWN-999 (return ID)'],
  ] as const)(
    'reports the fourth request without retrieving it: %s',
    async ([tail, kind, label], { database }) => {
      const prepare = vi.spyOn(database, 'prepare');
      onTestFinished(() => prepare.mockRestore());
      await buildSupportContext(database, ask(firstThree), calderPikeUser);
      const baseline = prepare.mock.calls.map(([sql]) => sql);
      prepare.mockClear();
      const context = requireSupportRecords(
        await buildSupportContext(
          database,
          ask(`${firstThree} ${tail}`),
          calderPikeUser,
        ),
      );
      expect(prepare.mock.calls.map(([sql]) => sql)).toEqual(baseline);
      expect(context.parts).toMatchObject([
        { kind: 'order' },
        { kind: 'order' },
        { kind: 'shipment' },
        {
          kind: 'omitted_requests',
          outcome: 'omitted',
          limit: 3,
          requests: [{ kind }],
        },
      ]);
      expect(context.records).toContain('Part 1 of 4:');
      expect(context.records).toContain(
        'Request parts not answered because of the limit of 3',
      );
      expect(context.records).toContain(label);
      expect(context.records).toContain(
        'ask them to request these parts separately',
      );
      expect(context.records).not.toContain('payment terms: Net 45');
      expect(context.records).not.toContain('Product: SBL-RPC-12');
      expect(context.records.match(/<\/?authorized_records>/g)).toHaveLength(2);
      expect(unavailableRecordReply(context)).toBeNull();
    },
  );

  test('deduplicates before budgeting and retains every omitted part in source order', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          `What are my payment terms? Show order SBL-2022-000118. Show order SBL-2022-000118. Is SBL-RPC-12 available? Show customer PO PRIVATE-FOURTH. Show return RTN-UNKNOWN-999.`,
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts).toMatchObject([
      { kind: 'account' },
      { kind: 'order' },
      { kind: 'products' },
      {
        kind: 'omitted_requests',
        requests: [
          {
            kind: 'order',
            namespace: 'customer_po',
            identifier: 'PRIVATE-FOURTH',
          },
          { kind: 'return', identifier: 'RTN-UNKNOWN-999' },
        ],
      },
    ]);
    expect(context.records).toContain('Part 3 of 5: catalog request');
  });

  test('does not look up a foreign or unknown fourth order', async ({
    database,
  }) => {
    const foreign = await database
      .prepare(
        'SELECT order_id, customer_po_number FROM orders WHERE customer_id != ? LIMIT 1',
      )
      .bind(calderPikeUser.distributorId)
      .first<{ order_id: string; customer_po_number: string }>();
    if (!foreign) throw new Error('Missing foreign fixture');
    for (const identifier of [foreign.order_id, 'SBL-2099-999999']) {
      const context = requireSupportRecords(
        await buildSupportContext(
          database,
          ask(`${firstThree} Show order ${identifier}.`),
          calderPikeUser,
        ),
      );
      expect(context.parts.at(-1)).toMatchObject({
        kind: 'omitted_requests',
        outcome: 'omitted',
        requests: [{ identifier }],
      });
      expect(context.records).not.toContain(foreign.customer_po_number);
      expect(context.records).not.toContain(`Cannot locate ${identifier}`);
    }
  });

  test('permits omitted reference echoes only in their requested namespaces', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          `${firstThree} Show customer PO PRIVATE-FOURTH. Show tracking reference TRACK-FOURTH. Is SBL-UNKNOWN-99 available?`,
        ),
        calderPikeUser,
      ),
    );
    expect(
      hasGroundedSupportIdentifiers(
        'Customer PO PRIVATE-FOURTH and tracking reference TRACK-FOURTH were omitted. Please ask separately about item SBL-UNKNOWN-99.',
        context,
      ),
    ).toBe(true);
    for (const reply of [
      'Order ID PRIVATE-FOURTH was delivered.',
      'Shipment ID TRACK-FOURTH was delivered.',
      'Order ID SBL-UNKNOWN-99 was delivered.',
      'Return PRIVATE-FOURTH is authorized.',
    ]) {
      expect(hasGroundedSupportIdentifiers(reply, context), reply).toBe(false);
    }
    const omitted = context.parts.at(-1);
    expect(omitted).not.toHaveProperty('facts');
    expect(omitted).not.toHaveProperty('verifiedReferences');
  });

  test('keeps item and request budgets separate', async ({ database }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Show SBL-RPC-12, SBL-CSR-R2, SBL-UNKNOWN-99 and SBL-EXTRA-99 availability. What are my payment terms? Show order SBL-2022-000118. Show customer PO PRIVATE-FOURTH.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts.map(({ kind }) => kind)).toEqual([
      'products',
      'unknown_products',
      'omitted_products',
      'account',
      'order',
      'omitted_requests',
    ]);
    expect(context.parts.at(-1)).toMatchObject({
      requests: [{ identifier: 'PRIVATE-FOURTH' }],
    });
    expect(context.records).toContain('Part 3 of 4: order SBL-2022-000118');
    expect(
      hasGroundedSupportIdentifiers(
        'Items SBL-UNKNOWN-99 and SBL-EXTRA-99 need a separate request, as does customer PO PRIVATE-FOURTH.',
        context,
      ),
    ).toBe(true);
  });

  test('clarifies a selected invalid search but only reports it when omitted', async ({
    database,
  }) => {
    const invalid = 'Show orders with status pending.';
    expect(
      await buildSupportContext(
        database,
        ask(`${invalid} ${firstThree}`),
        calderPikeUser,
      ),
    ).toMatchObject({ kind: 'clarification' });
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(`${firstThree} ${invalid}`),
        calderPikeUser,
      ),
    );
    expect(context.parts.at(-1)).toMatchObject({
      kind: 'omitted_requests',
      requests: [{ kind: 'orders', statusFilter: { kind: 'clarification' } }],
    });
  });

  test('does not turn omissions into a deterministic unavailable-record reply', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Show order SBL-2099-999991. Show order SBL-2099-999992. Show order SBL-2099-999993. Show customer PO PRIVATE-FOURTH.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts.map(({ outcome }) => outcome)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
      'omitted',
    ]);
    expect(unavailableRecordReply(context)).toBeNull();
    expect(context.records).toContain('PRIVATE-FOURTH (customer PO)');
  });

  test.for([
    'Is SBL-RPC-12 available from SABLE Systems Medical Operations Division?',
    'Show active orders containing SBL-RPC-12 from SABLE Systems Medical Operations Division.',
  ])(
    'does not trust resource names from an omitted request: %s',
    async (tail, { database }) => {
      const context = requireSupportRecords(
        await buildSupportContext(
          database,
          ask(`${firstThree} ${tail}`),
          calderPikeUser,
        ),
      );
      expect(
        unsupportedSableResources(
          'Please contact SABLE Systems Medical Operations Division for assistance.',
        ),
      ).toEqual(['SABLE Systems Medical Operations Division']);
      expect(context.records).toContain('SBL-RPC-12');
      expect(
        hasGroundedSupportIdentifiers('Item SBL-RPC-12 was omitted.', context),
      ).toBe(true);
    },
  );

  test('corrects and never saves an invented resource copied from an omitted request', async ({
    supportApi,
  }) => {
    const incidentId = 'INC-OMITTED-RESOURCE';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const invented =
      'Please contact SABLE Systems Medical Operations Division for assistance.';
    const clean =
      'The catalog request for item SBL-RPC-12 was omitted because of the three-part limit. Please ask about it separately.';
    const model = supportApi.mockModel(invented, clean);
    const message = `${firstThree} Is SBL-RPC-12 available from SABLE Systems Medical Operations Division?`;
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-OMITTED-RESOURCE',
        expectedRevision: 0,
        message,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: clean });
    expect(model).toHaveBeenCalledTimes(2);
    expect(
      (await supportApi.messageContents(incidentId)).results.map(
        ({ content }) => content,
      ),
    ).toEqual([message, clean]);
  });

  test('passes the omission notice to the model and saves and replays its reply', async ({
    supportApi,
  }) => {
    const incidentId = 'INC-REQUEST-OMISSIONS';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply =
      'Order SBL-2022-000118 was delivered. Customer PO PRIVATE-FOURTH was omitted because of the three-part limit; please ask about it separately.';
    const model = supportApi.mockModel(reply);
    const payload = {
      incidentId,
      messageId: 'MSG-REQUEST-OMISSIONS',
      expectedRevision: 0,
      message: `${firstThree} Show customer PO PRIVATE-FOURTH.`,
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
    expect(records).toContain(
      'Request parts not answered because of the limit of 3',
    );
    expect(records).toContain('PRIVATE-FOURTH (customer PO)');
    expect((await supportApi.messageContents(incidentId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: reply })]),
    );
    const replay = await chat(session.request(payload));
    expect(await replay.json()).toEqual(body);
    expect(model).toHaveBeenCalledOnce();
  });
});
