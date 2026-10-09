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
        quantity,
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

  it('caps a compound question at three records in order of appearance', () => {
    expect(
      ask(
        'Check RTN-2022-000014, SBL-2022-000118, SBL-2026-000417 and SBL-2031-000124.',
      ),
    ).toEqual([
      { kind: 'return', namespace: 'return_id', identifier: 'RTN-2022-000014' },
      { kind: 'order', namespace: 'unresolved', identifier: 'SBL-2022-000118' },
      { kind: 'order', namespace: 'unresolved', identifier: 'SBL-2026-000417' },
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
