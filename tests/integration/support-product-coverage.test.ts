import { describe, expect } from 'vitest';
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

describe('catalog target coverage', () => {
  test('retains full product names without requiring a compare keyword', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Show availability for Redline Power Cell R12 and Coldstart Rack Controller R2.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts).toMatchObject([
      {
        kind: 'products',
        facts: [
          { product: { item_number: 'SBL-RPC-12' } },
          { product: { item_number: 'SBL-CSR-R2' } },
        ],
      },
    ]);
  });

  test('retains a known SKU alongside a full product name without compare wording', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask('Show SBL-RPC-12 and Coldstart Rack Controller R2 availability.'),
        calderPikeUser,
      ),
    );
    expect(context.parts).toMatchObject([
      {
        kind: 'products',
        facts: [
          { product: { item_number: 'SBL-RPC-12' } },
          { product: { item_number: 'SBL-CSR-R2' } },
        ],
      },
    ]);
    expect(context.records).not.toContain('No catalog item matching');
  });

  test('retains both full product names alongside one unknown SKU', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Show SBL-UNKNOWN-99, Redline Power Cell R12 and Coldstart Rack Controller R2 availability.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts).toMatchObject([
      { kind: 'unknown_products', requestedItemNumbers: ['SBL-UNKNOWN-99'] },
      {
        kind: 'products',
        facts: [
          { product: { item_number: 'SBL-RPC-12' } },
          { product: { item_number: 'SBL-CSR-R2' } },
        ],
      },
    ]);
  });

  test('does not broaden an order search when one product filter is unknown', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask('Show my orders containing SBL-RPC-12 and SBL-UNKNOWN-99.'),
        calderPikeUser,
      ),
    );
    expect(context.parts).toEqual([
      {
        kind: 'unknown_products',
        outcome: 'unavailable',
        requestedItemNumbers: ['SBL-UNKNOWN-99'],
      },
    ]);
    expect(context.records).not.toContain('Order search');
  });

  test.for([
    [
      'SBL-M14-CW was omitted because of the item limit. Please request it separately.',
      200,
    ],
    ['Shipment ID: SBL-M14-CW is available.', 502],
  ] as const)(
    'validates omitted-item replies before saving: %s',
    async ([reply, status], { supportApi }) => {
      const incidentId = 'INC-OMITTED-PRODUCT';
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const model = supportApi.mockModel(reply);
      const response = await chat(
        session.request({
          incidentId,
          messageId: 'MSG-OMITTED-PRODUCT',
          expectedRevision: 0,
          message: 'Compare SBL-RPC-12, SBL-CSR-R2, SBL-PAL-1Y and SBL-M14-CW.',
        }),
      );
      expect(model).toHaveBeenCalledOnce();
      const request = JSON.parse(model.mock.calls[0][1]?.body as string) as {
        messages: { content: string }[];
      };
      const { records } = JSON.parse(request.messages[1].content) as {
        records: string;
      };
      expect(records).toContain('limit of 3');
      expect(records).not.toContain('Product: SBL-M14-CW');
      expect(response.status).toBe(status);
      const messages = (await supportApi.messageContents(incidentId)).results;
      if (status === 200)
        expect(messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: reply })]),
        );
      else expect(messages).toEqual([]);
    },
  );

  test('keeps a quantity request with no product target explicit', async ({
    database,
  }) => {
    expect(
      await buildSupportContext(
        database,
        ask('Can I order 8 units?'),
        calderPikeUser,
      ),
    ).toEqual({
      kind: 'clarification',
      message:
        'Please provide the item number or product name for the requested quantity.',
    });
  });

  test('does not match product aliases inside an unknown item number', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask('Show SBL-COLDSTART-UNKNOWN and SBL-RPC-12.'),
        calderPikeUser,
      ),
    );
    expect(context.parts.map(({ kind }) => kind)).toEqual([
      'unknown_products',
      'products',
    ]);
    expect(context.records).not.toContain('Product: SBL-CSR-R2');
    expect(
      hasGroundedSupportIdentifiers('SBL-CSR-R2 is available.', context),
    ).toBe(false);
  });

  test('limits full-name comparisons in source order even when a name contains a category', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Compare Redline Power Cell R12, Coldstart Rack Controller R2, Palisade Endpoint License, Annual and Monarch M14 Compute Wafer.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts).toMatchObject([
      {
        kind: 'products',
        facts: [
          { product: { item_number: 'SBL-RPC-12' } },
          { product: { item_number: 'SBL-CSR-R2' } },
          { product: { item_number: 'SBL-PAL-1Y' } },
        ],
      },
      { kind: 'omitted_products', requestedItemNumbers: ['SBL-M14-CW'] },
    ]);
  });

  test.for([
    ['Show SBL-RPC-12 and SBL-UNKNOWN-99.', ['products', 'unknown_products']],
    ['Show SBL-UNKNOWN-99 and SBL-RPC-12.', ['unknown_products', 'products']],
    [
      'Compare SBL-RPC-12, SBL-UNKNOWN-99 and SBL-CSR-R2.',
      ['products', 'unknown_products', 'products'],
    ],
  ] as const)(
    'retains known and unknown targets in request order: %s',
    async ([message, kinds], { database }) => {
      const context = requireSupportRecords(
        await buildSupportContext(database, ask(message), calderPikeUser),
      );
      expect(context.parts.map(({ kind }) => kind)).toEqual(kinds);
      expect(context.records).toContain('Product: SBL-RPC-12');
      expect(context.records).toContain(
        'No catalog item matching SBL-UNKNOWN-99',
      );
      expect(context.records.match(/<\/?authorized_records>/g)).toHaveLength(2);
      expect(
        hasGroundedSupportIdentifiers(
          'SBL-RPC-12 is available; SBL-UNKNOWN-99 was not found.',
          { ...context, records: '' },
        ),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers('Shipment ID: SBL-UNKNOWN-99.', context),
      ).toBe(false);
      expect(unavailableRecordReply(context)).toBeNull();
    },
  );

  test('does not let an unknown item absorb or reassign a known item quantity', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Can I order 16 units of SBL-RPC-12 and 90 units of SBL-UNKNOWN-99?',
        ),
        calderPikeUser,
      ),
    );
    const products = context.parts.find((part) => part.kind === 'products');
    expect(products).toMatchObject({
      facts: [{ product: { item_number: 'SBL-RPC-12' }, quantity: 16 }],
    });
    expect(context.records).toContain(
      'Requested quantity 16: valid case-pack multiple',
    );
    expect(context.records).not.toContain('Requested quantity 90:');
  });

  test('retains all explicitly named known products without a compare keyword', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask('Show SBL-RPC-12 and SBL-CSR-R2.'),
        calderPikeUser,
      ),
    );
    expect(context.parts).toMatchObject([
      {
        kind: 'products',
        facts: [
          { product: { item_number: 'SBL-RPC-12' } },
          { product: { item_number: 'SBL-CSR-R2' } },
        ],
      },
    ]);
  });

  test('deduplicates repeated known and unknown IDs before applying the target limit', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Compare SBL-RPC-12, SBL-UNKNOWN-99, SBL-RPC-12, SBL-UNKNOWN-99 and SBL-CSR-R2.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts.map(({ kind }) => kind)).toEqual([
      'products',
      'unknown_products',
      'products',
    ]);
    expect(context.records.match(/Product: SBL-RPC-12/g)).toHaveLength(1);
    expect(context.records).toContain('Product: SBL-CSR-R2');
  });

  test.for([
    'Compare SBL-RPC-12, SBL-CSR-R2, SBL-PAL-1Y and SBL-M14-CW.',
    'Compare SBL-RPC-12, SBL-UNKNOWN-99, SBL-PAL-1Y and SBL-M14-CW.',
  ])(
    'reports the fourth target without granting facts or record identity: %s',
    async (message, { database }) => {
      const context = requireSupportRecords(
        await buildSupportContext(database, ask(message), calderPikeUser),
      );
      expect(context.parts.at(-1)).toEqual({
        kind: 'omitted_products',
        outcome: 'omitted',
        requestedItemNumbers: ['SBL-M14-CW'],
        limit: 3,
      });
      expect(context.records).toContain('SBL-M14-CW');
      expect(context.records).not.toContain('Product: SBL-M14-CW');
      expect(context.records).toMatch(/limit of 3/i);
      expect(context.records).not.toContain(
        'No catalog item matching SBL-M14-CW',
      );
      expect(
        hasGroundedSupportIdentifiers(
          'Please ask about SBL-M14-CW separately.',
          context,
        ),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers('Order ID: SBL-M14-CW.', context),
      ).toBe(false);
      expect(
        hasGroundedSupportIdentifiers('Shipment SBL-M14-CW.', context),
      ).toBe(false);
    },
  );

  test('counts missing targets toward the limit without calling an omitted item missing', async ({
    database,
  }) => {
    const context = requireSupportRecords(
      await buildSupportContext(
        database,
        ask(
          'Compare SBL-MISSING-A, SBL-MISSING-B, SBL-MISSING-C and SBL-MISSING-D.',
        ),
        calderPikeUser,
      ),
    );
    expect(context.parts).toEqual([
      {
        kind: 'unknown_products',
        outcome: 'unavailable',
        requestedItemNumbers: [
          'SBL-MISSING-A',
          'SBL-MISSING-B',
          'SBL-MISSING-C',
        ],
      },
      {
        kind: 'omitted_products',
        outcome: 'omitted',
        requestedItemNumbers: ['SBL-MISSING-D'],
        limit: 3,
      },
    ]);
  });

  test('still clarifies when quantities cover more than three targets', async ({
    database,
  }) => {
    const context = await buildSupportContext(
      database,
      ask(
        'Can I order 8 units each of SBL-RPC-12, SBL-CSR-R2, SBL-PAL-1Y and SBL-UNKNOWN-99?',
      ),
      calderPikeUser,
    );
    expect(context).toEqual({
      kind: 'clarification',
      message: 'Please ask about quantities for up to three items at a time.',
    });
  });

  test('saves a compound reply covering the order, known item and missing item', async ({
    database,
    supportApi,
  }) => {
    const message =
      'Show order SBL-2022-000118. Compare SBL-RPC-12 and SBL-UNKNOWN-99.';
    const context = requireSupportRecords(
      await buildSupportContext(database, ask(message), calderPikeUser),
    );
    expect(context.parts.map(({ kind }) => kind)).toEqual([
      'order',
      'products',
      'unknown_products',
    ]);
    const incidentId = 'INC-PRODUCT-COVERAGE';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply =
      'Order SBL-2022-000118 was delivered. SBL-RPC-12 has 312 units available. SBL-UNKNOWN-99 was not found.';
    const model = supportApi.mockModel(reply);
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-PRODUCT-COVERAGE',
        expectedRevision: 0,
        message,
      }),
    );
    expect(model).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect((await supportApi.messageContents(incidentId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: reply })]),
    );
  });
});
