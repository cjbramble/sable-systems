import { describe, expect, it } from 'vitest';
import type { ChatHistoryMessage } from '@/lib/chat-history';
import {
  classifySupportQueries,
  classifySupportQuery,
} from '@/lib/support-query';
import { parseCustomerPo } from '@/lib/support-references';

it('shares the checkout PO contract and recognizes explicitly supplied references', () => {
  for (const po of [
    'abcd',
    '2026',
    'review-custom-po',
    'A--B',
    'Z'.repeat(40),
    'STATUS',
    'NUMBER',
  ]) {
    expect(parseCustomerPo(` ${po} `)).toBe(po.toUpperCase());
    expect(
      classifySupportQuery([
        { role: 'user', content: `Find customer PO: **${po}**.` },
      ]),
    ).toEqual({
      kind: 'order',
      namespace: 'customer_po',
      identifier: po.toUpperCase(),
    });
  }
  for (const po of [
    '',
    'abc',
    'A'.repeat(41),
    '-ABC',
    'PO_123',
    'PO/123',
    'two words',
  ])
    expect(parseCustomerPo(po)).toBeNull();
  for (const [content, namespace] of [
    ['Find order REVIEW-CUSTOM-PO.', 'unresolved'],
    ['Find purchase order number "REVIEW-CUSTOM-PO".', 'customer_po'],
    ['Customer PO is REVIEW-CUSTOM-PO.', 'customer_po'],
  ])
    expect(classifySupportQuery([{ role: 'user', content }])).toEqual({
      kind: 'order',
      namespace,
      identifier: 'REVIEW-CUSTOM-PO',
    });
  for (const content of [
    'What is my PO number?',
    'What is the order status?',
    'Tell me about this warehouse.',
  ])
    expect(classifySupportQuery([{ role: 'user', content }]).kind).not.toBe(
      'order',
    );
});

it('prioritizes current targets and keeps genuinely referential follow-ups', () => {
  const previous = [
    { role: 'user' as const, content: 'Show SBL-2026-000417.' },
  ];
  for (const content of [
    'Is SBL-RPC-12 available at this warehouse?',
    'Tell me about sbl-rpc-123.',
    'Is Redline Power Cell R12 available at this warehouse?',
  ])
    expect(
      classifySupportQuery([...previous, { role: 'user', content }]).kind,
    ).toBe('catalog');
  for (const content of [
    'What is its status?',
    'What is the total for that order?',
    'What currency is that order billed in?',
  ])
    expect(
      classifySupportQuery([...previous, { role: 'user', content }]),
    ).toEqual({
      kind: 'order',
      namespace: 'unresolved',
      identifier: 'SBL-2026-000417',
    });
  expect(
    classifySupportQuery([
      ...previous,
      { role: 'user', content: 'Tell me about SBL-RPC-12.' },
      { role: 'user', content: 'Is it available at this warehouse?' },
    ]),
  ).toMatchObject({
    kind: 'catalog',
    message: 'is it available at this warehouse? sbl-rpc-12',
    includeLocations: true,
  });
  expect(
    classifySupportQuery([
      ...previous,
      { role: 'user', content: 'Find order SBL-2026-000417-X.' },
    ]),
  ).toEqual({
    kind: 'order',
    namespace: 'order_id',
    identifier: 'SBL-2026-000417-X',
  });
});

it('keeps an order follow-up anchored when the assistant mentions its line-item SKU', () => {
  expect(
    classifySupportQuery([
      {
        role: 'user',
        content:
          'Find order SBL-2026-848585. What did I order and what is the total?',
      },
      {
        role: 'assistant',
        content:
          'You ordered 8 units of SBL-RPC-12 at $680.00 each. The total is $5,440.00.',
      },
      { role: 'user', content: 'What is its status, and has it shipped?' },
    ]),
  ).toEqual({
    kind: 'order',
    namespace: 'order_id',
    identifier: 'SBL-2026-848585',
  });
});

it('ignores numeric item-number suffixes while retaining explicit catalog quantities', () => {
  const scenarios: [content: string, quantity: number | undefined][] = [
    ['Can I order 8 units of SBL-RPC-12?', 8],
    ['Can I order 24 units of SBL-RPC-12?', 24],
    ['Can I order 1000 units of SBL-RPC-12?', 1000],
    ['Can I order 1,000 units of SBL-RPC-12?', 1000],
    ['Can I return 8 units of SBL-RPC-12?', 8],
    ['Can I return SBL-RPC-12 units?', undefined],
    ['How many SBL-RPC-12 units are available?', undefined],
    ['Are SBL-HXB-09 modules available?', undefined],
    ['Are SBL-AEG-4 security nodes in stock?', undefined],
    ['Are sbl-swc-12 interface units available?', undefined],
    // Parsing must not depend on whether the item exists in the catalog.
    ['Are SBL-ABC-123 units available?', undefined],
    ['How many Redline Power Cell R12 units are available?', undefined],
    ['Are 16 TB arrays available?', undefined],
    ['Are 16TB arrays available?', undefined],
    ['Are 16 units of SBL-RPC-12 available?', 16],
    ['Are 8 modules of SBL-HXB-09 available?', 8],
    // Skip the suffix and keep looking for a genuine quantity in the message.
    ['For SBL-RPC-12 units, are 24 units available?', 24],
    ['SBL-RPC-12 availability: 32 units?', 32],
    ['Is SBL-HXB-09 available (40 modules)?', 40],
    ['48 units of SBL-RPC-12: are they available?', 48],
    ['SBL-RPC-12 inventory:\n56 units available?', 56],
  ];

  for (const [content, quantity] of scenarios) {
    expect
      .soft(classifySupportQuery([{ role: 'user', content }]), content)
      .toMatchObject({
        kind: 'catalog',
        // Product matching still needs the intact normalized message.
        message: content.toLowerCase(),
        quantities:
          quantity === undefined
            ? []
            : [
                expect.objectContaining({
                  quantity: { kind: 'valid', value: quantity },
                }),
              ],
      });
  }
});

describe('compound support questions', () => {
  const ask = (content: string) =>
    classifySupportQueries([{ role: 'user', content }]);

  it('keeps single-target and follow-up questions to one intent', () => {
    for (const content of [
      'Where is order SBL-2022-000118?',
      'Is SBL-RPC-12 in stock?',
      'Show my delivered orders.',
      'What is the status of SBL-2022-000118 and when was SBL-2022-000118 delivered?',
    ])
      expect(ask(content), content).toEqual([
        classifySupportQuery([{ role: 'user', content }]),
      ]);
    const followUp: ChatHistoryMessage[] = [
      { role: 'user', content: 'Show order SBL-2022-000118.' },
      { role: 'assistant', content: 'It was delivered.' },
      { role: 'user', content: 'When was that order delivered?' },
    ];
    expect(classifySupportQueries(followUp)).toEqual([
      classifySupportQuery(followUp),
    ]);
  });

  it('retrieves every explicit record and a product in one question', () => {
    expect(
      ask('Where is SBL-2022-000118, and is SBL-RPC-12 in stock?'),
    ).toMatchObject([
      { kind: 'order', identifier: 'SBL-2022-000118' },
      { kind: 'catalog' },
    ]);
    expect(
      ask(
        'Compare order SBL-2022-000118 with order SBL-2026-000417 and shipment SHP-2022-000012.',
      ),
    ).toEqual([
      { kind: 'order', namespace: 'order_id', identifier: 'SBL-2022-000118' },
      { kind: 'order', namespace: 'order_id', identifier: 'SBL-2026-000417' },
      {
        kind: 'shipment',
        namespace: 'shipment_id',
        identifier: 'SHP-2022-000012',
      },
    ]);
  });

  it('retains all compound records in order for budget planning', () => {
    expect(
      ask(
        'Check RTN-2022-000014, SBL-2022-000118, SBL-2026-000417 and SBL-2031-000124.',
      ),
    ).toEqual([
      { kind: 'return', namespace: 'return_id', identifier: 'RTN-2022-000014' },
      { kind: 'order', namespace: 'unresolved', identifier: 'SBL-2022-000118' },
      { kind: 'order', namespace: 'unresolved', identifier: 'SBL-2026-000417' },
      { kind: 'order', namespace: 'unresolved', identifier: 'SBL-2031-000124' },
    ]);
  });
});

describe('typed reference identity', () => {
  it.each(['SBL-RPC-12/invalid', `SBL-${'X'.repeat(41)}`])(
    'does not reinterpret an invalid explicit PO as a catalog lookup: %s',
    (value) => {
      const intents = classifySupportQueries([
        { role: 'user', content: `Find customer PO: ${value}` },
      ]);
      expect(intents).toHaveLength(1);
      expect(intents[0].kind).toBe('summary');
      expect(intents[0]).toHaveProperty('message');
      expect((intents[0] as { message: string }).message).not.toContain('sbl-');
    },
  );

  it('keeps a separate product when an explicit PO value is invalid', () => {
    expect(
      classifySupportQueries([
        {
          role: 'user',
          content:
            'Find customer PO: SBL-RPC-12/invalid and check SBL-SWC-12 stock.',
        },
      ]),
    ).toMatchObject([{ kind: 'catalog' }]);
    const intent = classifySupportQuery([
      {
        role: 'user',
        content:
          'Find customer PO: SBL-RPC-12/invalid and check SBL-SWC-12 stock.',
      },
    ]);
    if (!('message' in intent)) throw new Error('Expected catalog message');
    expect(intent.message).toContain('sbl-swc-12');
    expect(intent.message).not.toContain('sbl-rpc-12');
  });

  it.each([
    ['order SBL-2099-900001', 'order', 'order_id', 'SBL-2099-900001'],
    ['order ID REVIEW-CUSTOM-PO', 'order', 'order_id', 'REVIEW-CUSTOM-PO'],
    ['order number REVIEW-CUSTOM-PO', 'order', 'order_id', 'REVIEW-CUSTOM-PO'],
    ['customer PO: SBL-2099-900001', 'order', 'customer_po', 'SBL-2099-900001'],
    ['customer PO: SHP-2099-900001', 'order', 'customer_po', 'SHP-2099-900001'],
    ['customer PO: RTN-2099-900001', 'order', 'customer_po', 'RTN-2099-900001'],
    ['SBL-2099-900001', 'order', 'unresolved', 'SBL-2099-900001'],
    ['shipment SHP-2099-900001', 'shipment', 'shipment_id', 'SHP-2099-900001'],
    ['shipment AST-2099-900001', 'shipment', 'unresolved', 'AST-2099-900001'],
    [
      'shipment ID AST-2099-900001',
      'shipment',
      'shipment_id',
      'AST-2099-900001',
    ],
    [
      'tracking reference SHP-2099-900001',
      'shipment',
      'tracking_reference',
      'SHP-2099-900001',
    ],
    [
      'tracking number: "CUSTOM-TRACKING"',
      'shipment',
      'tracking_reference',
      'CUSTOM-TRACKING',
    ],
    ['AST-2099-900001', 'shipment', 'unresolved', 'AST-2099-900001'],
  ])('preserves the meaning of %s', (content, kind, namespace, identifier) => {
    expect(classifySupportQuery([{ role: 'user', content }])).toEqual({
      kind,
      namespace,
      identifier,
    });
  });

  it('preserves compound appearance order and separate namespaces sharing a value', () => {
    expect(
      classifySupportQueries([
        {
          role: 'user',
          content:
            'Find PO: STATUS, order SBL-2099-900001 and customer PO: SBL-2099-900001.',
        },
      ]),
    ).toEqual([
      { kind: 'order', namespace: 'customer_po', identifier: 'STATUS' },
      { kind: 'order', namespace: 'order_id', identifier: 'SBL-2099-900001' },
      {
        kind: 'order',
        namespace: 'customer_po',
        identifier: 'SBL-2099-900001',
      },
    ]);
  });

  it.each([
    'PO: SHP-123456789012345678901234567890123456789012345',
    'PO: RTN-123456789012345678901234567890123456789012345',
  ])(
    'does not reinterpret an invalid explicit PO as another record: %s',
    (content) => {
      expect(classifySupportQueries([{ role: 'user', content }])).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'shipment' })]),
      );
      expect(classifySupportQuery([{ role: 'user', content }]).kind).not.toBe(
        'return',
      );
    },
  );
});

describe('entity-aware follow-ups', () => {
  const order = {
    kind: 'order',
    namespace: 'order_id',
    identifier: 'SBL-2022-000118',
  };
  const shipment = {
    kind: 'shipment',
    namespace: 'shipment_id',
    identifier: 'SHP-2022-000012',
  };
  const returned = {
    kind: 'return',
    namespace: 'return_id',
    identifier: 'RTN-2022-000014',
  };
  const previous: ChatHistoryMessage[] = [
    { role: 'user', content: 'Show order SBL-2022-000118.' },
    {
      role: 'assistant',
      content:
        'Order SBL-2022-000118 includes shipment SHP-2022-000012, return RTN-2022-000014 and SBL-DMK-A9.',
    },
  ];

  it.each([
    ['Return: No return recorded.', 'return'],
    ['Shipment: None.', 'shipment'],
    [
      'Please specify the shipment you mean by its shipment ID or tracking reference.',
      'shipment',
    ],
    [
      'Please specify the order you mean by its order ID or customer PO number.',
      'order',
    ],
  ])(
    'does not turn assistant prose into a reference: %s',
    (content, entity) => {
      const messages: ChatHistoryMessage[] = [
        { role: 'user', content: 'Tell me about SBL-RPC-12.' },
        { role: 'assistant', content },
        { role: 'user', content: `What is the status of that ${entity}?` },
      ];
      expect(classifySupportQuery(messages)).toEqual({
        kind: 'clarification',
        entity,
        reason: 'missing_target',
      });
    },
  );

  it.each([
    ['What is the total for that order?', order],
    ['Where is that shipment?', shipment],
    ['What is the status of that return?', returned],
    ['What is its status?', order],
  ])('resolves %s against the requested entity', (content, expected) => {
    expect(
      classifySupportQuery([...previous, { role: 'user', content }]),
    ).toEqual(expected);
  });

  it('keeps a resolved shipment follow-up as the next pronoun target', () => {
    expect(
      classifySupportQuery([
        ...previous,
        { role: 'user', content: 'Where is that shipment?' },
        {
          role: 'assistant',
          content:
            'Shipment SHP-2022-000012 is linked to order SBL-2022-000118 and return RTN-2022-000014.',
        },
        { role: 'user', content: 'What is its status?' },
      ]),
    ).toEqual(shipment);
  });

  it('resets older entity targets when the customer switches records', () => {
    expect(
      classifySupportQuery([
        { role: 'user', content: 'Show shipment SHP-2026-000417.' },
        ...previous,
        { role: 'user', content: 'Where is that shipment?' },
      ]),
    ).toEqual(shipment);
  });

  it('retains the related order after a shipment follow-up', () => {
    expect(
      classifySupportQuery([
        ...previous,
        { role: 'user', content: 'Where is that shipment?' },
        { role: 'assistant', content: 'It has been delivered.' },
        { role: 'user', content: 'What is the total for that order?' },
      ]),
    ).toEqual(order);
  });

  it('clarifies the latest multiple customer targets despite a single assistant mention', () => {
    expect(
      classifySupportQuery([
        ...previous,
        {
          role: 'user',
          content: 'Compare order SBL-2026-000417 and order SBL-2026-000418.',
        },
        {
          role: 'assistant',
          content: 'Order SBL-2026-000417 is partially shipped.',
        },
        { role: 'user', content: 'What is the total for that order?' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'order',
      reason: 'multiple_targets',
    });
  });

  it('clarifies multiple assistant shipments and missing matching entities', () => {
    expect(
      classifySupportQuery([
        ...previous.slice(0, 1),
        {
          role: 'assistant',
          content:
            'Shipments SHP-2022-000012 and SHP-2026-000417 are recorded.',
        },
        { role: 'user', content: 'Where is that shipment?' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'shipment',
      reason: 'multiple_targets',
    });
    expect(
      classifySupportQuery([
        ...previous.slice(0, 1),
        { role: 'user', content: 'Where is that shipment?' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'shipment',
      reason: 'missing_target',
    });
  });

  it('uses a unique matching assistant reference when earlier history is unavailable', () => {
    expect(
      classifySupportQuery([
        previous[1],
        { role: 'user', content: 'Where is that shipment?' },
      ]),
    ).toEqual(shipment);
  });

  it('keeps a missing entity unresolved for the next pronoun without losing a related order', () => {
    const missingReturn: ChatHistoryMessage[] = [
      ...previous.slice(0, 1),
      { role: 'user', content: 'What is the status of that return?' },
      { role: 'assistant', content: 'Please specify the return ID.' },
    ];
    expect(
      classifySupportQuery([
        ...missingReturn,
        { role: 'user', content: 'What is its status?' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'return',
      reason: 'missing_target',
    });
    expect(
      classifySupportQuery([
        ...missingReturn,
        { role: 'user', content: 'What is the total of that order?' },
      ]),
    ).toEqual(order);
  });

  it('keeps multiple shipment targets ambiguous for the next pronoun', () => {
    expect(
      classifySupportQuery([
        ...previous.slice(0, 1),
        {
          role: 'assistant',
          content:
            'Shipments SHP-2022-000012 and SHP-2026-000417 are recorded.',
        },
        { role: 'user', content: 'Where is that shipment?' },
        { role: 'assistant', content: 'Please specify the shipment ID.' },
        { role: 'user', content: 'What is its status?' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'shipment',
      reason: 'multiple_targets',
    });
  });

  it('keeps a missing shipment unresolved after the saved server clarification', () => {
    expect(
      classifySupportQuery([
        ...previous.slice(0, 1),
        { role: 'user', content: 'Where is that shipment?' },
        {
          role: 'assistant',
          content:
            'Please specify the shipment you mean by its shipment ID or tracking reference.',
        },
        { role: 'user', content: 'What is the status of that shipment?' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'shipment',
      reason: 'missing_target',
    });
  });

  it('preserves product and other explicit topic switches', () => {
    for (const [content, kind] of [
      ['Is SBL-RPC-12 available at this warehouse?', 'catalog'],
      ['Show my orders and their status.', 'orders'],
      ['Show my support incidents.', 'incidents'],
      ['What are my account payment terms?', 'account'],
    ])
      expect(
        classifySupportQuery([...previous, { role: 'user', content }]).kind,
      ).toBe(kind);
    expect(
      classifySupportQuery([
        ...previous,
        { role: 'user', content: 'Tell me about SBL-RPC-12.' },
        {
          role: 'assistant',
          content: 'It also appears in order SBL-2026-000417.',
        },
        { role: 'user', content: 'Is it available at this warehouse?' },
      ]),
    ).toMatchObject({
      kind: 'catalog',
      message: 'is it available at this warehouse? sbl-rpc-12',
    });
  });
});

describe('namespace-only clarification answers', () => {
  const order = 'SBL-2099-910001';
  const shipment = 'SHP-2099-910001';
  const history = (identifier: string): ChatHistoryMessage[] => [
    { role: 'user', content: `Show ${identifier}.` },
    {
      role: 'assistant',
      content: `Please specify whether ${identifier} is an order ID or a customer PO number.`,
    },
  ];

  it.each([
    [order, "It's the order ID.", 'order', 'order_id'],
    [order, 'It’s the order ID.', 'order', 'order_id'],
    [order, 'It is the order number.', 'order', 'order_id'],
    [order, 'It’s an order ID.', 'order', 'order_id'],
    [order, 'the customer PO', 'order', 'customer_po'],
    [order, 'customer PO number', 'order', 'customer_po'],
    [order, 'It’s a customer PO number.', 'order', 'customer_po'],
    [order, "It's the customer PO.", 'order', 'customer_po'],
    [shipment, 'It’s the shipment ID.', 'shipment', 'shipment_id'],
    [shipment, 'the shipment number', 'shipment', 'shipment_id'],
    [shipment, 'tracking reference', 'shipment', 'tracking_reference'],
    [shipment, 'It is the tracking number.', 'shipment', 'tracking_reference'],
  ])(
    'uses %s with the namespace supplied by %s',
    (identifier, content, kind, namespace) => {
      const messages = [
        ...history(identifier),
        { role: 'user' as const, content },
      ];
      const expected = { kind, namespace, identifier };
      expect(classifySupportQuery(messages)).toEqual(expected);
      expect(
        classifySupportQuery([
          ...messages,
          { role: 'assistant', content: 'The requested record is available.' },
          { role: 'user', content: 'What is its status?' },
        ]),
      ).toEqual(expected);
    },
  );

  it.each([
    'What is its order ID?',
    'Is it the order ID?',
    "It's not the order ID.",
    "It's the order ID or customer PO.",
    "It's the order ID and customer PO.",
  ])('does not select a namespace from %s', (content) => {
    expect(
      classifySupportQuery([...history(order), { role: 'user', content }]),
    ).toMatchObject({
      kind: 'order',
      namespace: 'unresolved',
      identifier: order,
    });
  });

  it('does not choose between multiple customer targets or substitute an assistant target', () => {
    expect(
      classifySupportQuery([
        { role: 'user', content: `Compare ${order} with SBL-2099-910002.` },
        {
          role: 'assistant',
          content: `Please specify whether ${order} is an order ID or a customer PO number.`,
        },
        { role: 'user', content: "It's the order ID." },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'order',
      reason: 'multiple_targets',
    });
    expect(
      classifySupportQuery([
        {
          role: 'assistant',
          content: `Please specify whether ${order} is an order ID or a customer PO number.`,
        },
        { role: 'user', content: 'the customer PO' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'order',
      reason: 'missing_target',
    });
  });

  it('preserves missing-target clarification and rejects a different entity namespace', () => {
    expect(
      classifySupportQuery([
        ...history(order),
        { role: 'user', content: 'Where is that shipment?' },
        {
          role: 'assistant',
          content:
            'Please specify the shipment you mean by its shipment ID or tracking reference.',
        },
        { role: 'user', content: 'the shipment ID' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'shipment',
      reason: 'missing_target',
    });
    expect(
      classifySupportQuery([
        ...history(order),
        { role: 'user', content: 'tracking reference' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'shipment',
      reason: 'missing_target',
    });
  });

  it('uses the current frame after an explicit topic switch', () => {
    expect(
      classifySupportQuery([
        ...history(order),
        { role: 'user', content: 'Show SBL-2099-910002.' },
        { role: 'user', content: 'the customer PO' },
      ]),
    ).toEqual({
      kind: 'order',
      namespace: 'customer_po',
      identifier: 'SBL-2099-910002',
    });
    expect(
      classifySupportQuery([
        ...history(order),
        { role: 'user', content: 'Tell me about SBL-RPC-12.' },
        { role: 'user', content: 'the customer PO' },
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'order',
      reason: 'missing_target',
    });
  });

  it('does not reinterpret a target that already has an explicit namespace', () => {
    expect(
      classifySupportQuery([
        { role: 'user', content: `Show order ID ${order}.` },
        { role: 'user', content: "It's the customer PO." },
      ]),
    ).toEqual({ kind: 'order', namespace: 'order_id', identifier: order });
  });

  it('does not turn a rejected explicit value into a namespace-only answer', () => {
    expect(
      classifySupportQuery([
        ...history(order),
        { role: 'user', content: 'the customer PO: SBL-RPC-12/invalid' },
      ]),
    ).toMatchObject({ kind: 'summary' });
  });
});

describe('catalog quantity interpretation', () => {
  it.each(['1.5', '-8', '+8', '0', '1000000', '1e3', '1/2', '8-12', '1,00'])(
    'keeps the complete unsupported quantity %s visible for clarification',
    (raw) => {
      const content = `Can I order ${raw} units of SBL-RPC-12?`;
      expect(classifySupportQuery([{ role: 'user', content }])).toMatchObject({
        kind: 'catalog',
        message: content.toLowerCase(),
        quantities: [
          expect.objectContaining({
            raw,
            quantity: expect.objectContaining({ kind: 'invalid' }),
          }),
        ],
      });
    },
  );

  it('preserves explicit numeric order IDs', () => {
    expect(
      classifySupportQuery([{ role: 'user', content: 'Find order ID: 1000.' }]),
    ).toEqual({
      kind: 'order',
      namespace: 'order_id',
      identifier: '1000',
    });
  });

  it('retains both saved product targets for a shared quantity follow-up', () => {
    const content = 'Compare both for 24 units';
    expect(
      classifySupportQuery([
        { role: 'user', content: 'Compare SBL-RPC-12 and SBL-SWC-12.' },
        {
          role: 'assistant',
          content:
            'There are 312 units of SBL-RPC-12 and 720 units of SBL-SWC-12 available.',
        },
        { role: 'user', content },
      ]),
    ).toMatchObject({
      kind: 'catalog',
      message: `${content.toLowerCase()} sbl-rpc-12 sbl-swc-12`,
      quantities: [
        expect.objectContaining({ quantity: { kind: 'valid', value: 24 } }),
      ],
    });
  });

  it('uses the latest customer quantity in a single-product follow-up', () => {
    expect(
      classifySupportQuery([
        { role: 'user', content: 'Tell me about SBL-RPC-12.' },
        { role: 'assistant', content: 'There are 312 units available.' },
        { role: 'user', content: 'Are 1,000 units of it available?' },
      ]),
    ).toMatchObject({
      kind: 'catalog',
      message: 'are 1,000 units of it available? sbl-rpc-12',
      quantities: [
        expect.objectContaining({ quantity: { kind: 'valid', value: 1000 } }),
      ],
    });
  });
});

it('uses a quantity with each as a saved product follow-up', () => {
  expect(
    classifySupportQuery([
      { role: 'user', content: 'Compare SBL-RPC-12 and SBL-SWC-12.' },
      { role: 'user', content: '24 units each' },
    ]),
  ).toMatchObject({
    kind: 'catalog',
    message: '24 units each sbl-rpc-12 sbl-swc-12',
    quantities: [
      expect.objectContaining({ quantity: { kind: 'valid', value: 24 } }),
    ],
  });
  expect(
    classifySupportQuery([
      { role: 'user', content: 'Compare SBL-RPC-12 and SBL-SWC-12.' },
      { role: 'user', content: 'each' },
    ]),
  ).toEqual({ kind: 'summary', message: 'each' });
});

describe('order search years', () => {
  const orders = (content: string) =>
    classifySupportQuery([{ role: 'user', content }]);

  it.each([
    ['Show my orders from 2026.', 2026],
    ['Show orders created in 2025 that are not cancelled.', 2025],
    ['List my 2024 orders over $2000.', 2024],
    ['Show my 2031 releases.', 2031],
    ['Show my orders from 2024 in USD.', 2024],
    ['Show orders created in 2024 with items.', 2024],
    ['May I see my orders from 2025?', 2025],
  ])('reads one year from %j', (message, year) => {
    expect(orders(message)).toMatchObject({ kind: 'orders', year });
    expect(orders(message)).not.toHaveProperty('unsupportedDate');
  });

  it.each([
    'Show my orders over $2000.',
    'Show my orders over $ 2,000.',
    'List orders with more than 2048 units.',
    'Show orders above 2000 dollars.',
  ])('does not read money or quantities as a year: %j', (message) => {
    const intent = orders(message);
    expect(intent).toMatchObject({ kind: 'orders' });
    expect(intent).not.toHaveProperty('year', expect.anything());
    expect(intent).not.toHaveProperty('unsupportedDate');
  });

  it.each([
    'Show my orders between 2024 and 2025.',
    'Show orders from 2025 and 2026.',
    'Show orders placed before 2026-03-01.',
    'Show orders placed before 2026.',
    'Show orders since 2025.',
    'Show my orders from March 2026.',
    'Show my orders from 03/15/2026.',
    'Show my orders from September 15, 2026.',
    'Show my orders from 15 September 2026.',
    'Show my orders from March.',
    'Show my orders this month.',
    'Show orders from the last 30 days.',
    'Show orders before today.',
  ])('marks %j as an unsupported date filter', (message) => {
    expect(orders(message)).toMatchObject({
      kind: 'orders',
      unsupportedDate: true,
    });
  });
});

it('does not treat ordinary order wording as a date filter', () => {
  for (const message of ['Show my recent orders.', 'Show my latest orders.'])
    expect(
      classifySupportQuery([{ role: 'user', content: message }]),
    ).not.toHaveProperty('unsupportedDate');
});

describe('conversation frame targets', () => {
  // Catalog terms as stored in the seed, so names and aliases match as in production.
  const products = [
    {
      item_number: 'SBL-AEG-4',
      product_name: 'Aegis Hardware Firewall',
      unit_label: 'unit',
      search_terms: 'aegis,hardware firewall,firewall',
    },
    {
      item_number: 'SBL-CSR-R2',
      product_name: 'Coldstart Rack Controller R2',
      unit_label: 'controller',
      search_terms: 'coldstart,rack controller,r2',
    },
    {
      item_number: 'SBL-RPC-12',
      product_name: 'Redline Power Cell R12',
      unit_label: 'cell',
      search_terms: 'redline,power cell,r12',
    },
  ];
  const user = (content: string) => ({ role: 'user' as const, content });
  const assistant = (content: string) => ({
    role: 'assistant' as const,
    content,
  });
  const orderQuestion = user('What is the status of order SBL-2022-000118?');
  const orderAnswer = assistant('SBL-2022-000118 was delivered on 2022-06-27.');
  const order = {
    kind: 'order',
    namespace: 'order_id',
    identifier: 'SBL-2022-000118',
  };

  it.each([
    ['Is the Redline in stock? How much is it?', 'SBL-RPC-12'],
    [
      'Is the Aegis Hardware Firewall in stock and what does it cost?',
      'SBL-AEG-4',
    ],
    ['Is the Redline Power Cell R12 in stock? How much is it?', 'SBL-RPC-12'],
  ])('resolves "it" to a product named in the same message: %s', (content) => {
    expect(classifySupportQueries([user(content)], products)).toEqual([
      expect.objectContaining({
        kind: 'catalog',
        message: content.toLowerCase(),
      }),
    ]);
  });

  it.each([
    ['Is the Redline Power Cell R12 in stock?', 'SBL-RPC-12'],
    ['Is the Redline in stock?', 'SBL-RPC-12'],
    ['Is the Aegis Hardware Firewall in stock?', 'SBL-AEG-4'],
  ])(
    'resolves "it" to a product named in an earlier message: %s',
    (content, itemNumber) => {
      const messages = [
        user(content),
        assistant('Yes, 40 are in stock.'),
        user('How much is it?'),
      ];
      expect(classifySupportQueries(messages, products)).toEqual([
        expect.objectContaining({
          kind: 'catalog',
          message: `how much is it? ${itemNumber.toLowerCase()}`,
        }),
      ]);
    },
  );

  it.each([
    'Was the controller on that order damaged?',
    'Was the Aegis Hardware Firewall on that order damaged?',
    'Was it shipped with the controller?',
    'Did it include the Redline Power Cell R12?',
  ])(
    'keeps a product named on the current order on that order: %s',
    (content) => {
      expect(
        classifySupportQueries(
          [orderQuestion, orderAnswer, user(content)],
          products,
        ),
      ).toEqual([order]);
    },
  );

  it('switches from an order to a product named in a stock question', () => {
    expect(
      classifySupportQueries(
        [
          orderQuestion,
          orderAnswer,
          user('Is the Redline in stock? How much is it?'),
        ],
        products,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'catalog',
        message: 'is the redline in stock? how much is it?',
      }),
    ]);
  });

  it('resolves "it" to the one record the assistant named after a list', () => {
    expect(
      classifySupportQuery([
        user('Show my cancelled orders'),
        assistant('You have one cancelled order: SBL-2023-000205.'),
        user('Why was it cancelled?'),
      ]),
    ).toEqual({
      kind: 'order',
      namespace: 'order_id',
      identifier: 'SBL-2023-000205',
    });
  });

  it('resolves "it" to the one product the assistant named after a catalog list', () => {
    expect(
      classifySupportQuery([
        user('Which compute products are in stock?'),
        assistant('SBL-HXB-09 is in stock.'),
        user('How much is it?'),
      ]),
    ).toMatchObject({ kind: 'catalog', message: 'how much is it? sbl-hxb-09' });
  });

  it('still asks which record "it" means when the assistant named several', () => {
    expect(
      classifySupportQuery([
        user('Show my cancelled orders'),
        assistant('SBL-2023-000205 and SBL-2026-000120 were cancelled.'),
        user('Why was it cancelled?'),
      ]),
    ).toEqual({
      kind: 'clarification',
      entity: 'order',
      reason: 'multiple_targets',
    });
  });

  it.each([
    'Was it delayed by a power outage?',
    'Is that order on hold for a security review?',
    'Is there an interface where I can track it?',
    'Was its software license applied?',
  ])('keeps an everyday category word on the current order: %s', (content) => {
    expect(
      classifySupportQueries([orderQuestion, orderAnswer, user(content)]),
    ).toEqual([order]);
  });

  it.each([
    'Which warehouse did my last order ship from?',
    'When will my invoice be available?',
    'What security options does my account have?',
    'Is my payment on hold for a security review?',
  ])(
    'does not read an everyday question as a catalog request: %s',
    (content) => {
      expect(classifySupportQuery([user(content)]).kind).not.toBe('catalog');
    },
  );

  it.each([
    ['Which power products are in stock?', 'Power'],
    ['List the Software catalog.', 'Software'],
    ['Show the security category.', 'Security'],
    ['What is in the catalog for compute?', 'Compute'],
    ['Is any interface gear available?', 'Interface'],
    ['Do you have cybernetics in stock?', 'Cybernetics'],
  ])('still reads a category beside a catalog cue: %s', (content, category) => {
    expect(classifySupportQuery([user(content)])).toMatchObject({
      kind: 'catalog',
      category,
    });
  });

  it('starts a new catalog topic for a category question without a pronoun', () => {
    expect(
      classifySupportQuery([
        orderQuestion,
        orderAnswer,
        user('Which power products are in stock?'),
      ]),
    ).toMatchObject({ kind: 'catalog', category: 'Power' });
  });

  it.each([
    'Which warehouse stocks SBL-RPC-12?',
    'Is the item SBL-RPC-12 available?',
    'Show order SBL-2022-000118. Check Coldstart Rack Controller R2 availability.',
  ])('keeps stock words with a named product as catalog: %s', (content) => {
    expect(
      classifySupportQueries([user(content)], products).map(({ kind }) => kind),
    ).toContain('catalog');
  });
});
