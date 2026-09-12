import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext, getAccountSummary } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';
import { calderPikeUser } from '../fixtures/users';

describe('support catalog grounding', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-12T15:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('distinguishes query time, inventory updates, and seed provenance after a balance changes', async () => {
    const database = await getDatabase();
    const before = await database
      .prepare(
        'SELECT * FROM inventory_balances WHERE item_number = ? ORDER BY location_id',
      )
      .bind('SBL-RPC-12')
      .all<{
        location_id: string;
        reserved_quantity: number;
        updated_at: string;
      }>();
    const row = before.results[0];
    expect(row).toBeDefined();
    try {
      await database
        .prepare(
          'UPDATE inventory_balances SET reserved_quantity = reserved_quantity + 8, updated_at = ? WHERE item_number = ? AND location_id = ?',
        )
        .bind('2026-09-10T10:30:00.000Z', 'SBL-RPC-12', row.location_id)
        .run();
      const context = await buildAuthorizedContext(
        database,
        [{ role: 'user', content: 'How many SBL-RPC-12 are available?' }],
        calderPikeUser,
      );
      expect(context).toContain('Available to promise: 304.');
      expect(context).toContain(
        'Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-10T10:30:00.000Z.',
      );
      expect(context).not.toContain('as of 2026-09-02');
      expect(await getAccountSummary(database, calderPikeUser)).toMatchObject({
        seedAsOfDate: '2026-09-02',
        retrievedAt: '2026-09-12T15:00:00.000Z',
      });
    } finally {
      await database
        .prepare(
          'UPDATE inventory_balances SET reserved_quantity = ?, updated_at = ? WHERE item_number = ? AND location_id = ?',
        )
        .bind(
          row.reserved_quantity,
          row.updated_at,
          'SBL-RPC-12',
          row.location_id,
        )
        .run();
    }
  });
  it('resolves whole SKU tokens and does not substitute for unknown suffixes after an order discussion', async () => {
    const database = await getDatabase();
    const previous = [
      { role: 'user' as const, content: 'Show SBL-2026-000417.' },
    ];
    for (const content of [
      'Is (sbl-rpc-12) available at this warehouse?',
      'Tell me about SBL-RPC-12.',
      'Is Redline Power Cell R12 available at this warehouse?',
    ]) {
      const context = await buildAuthorizedContext(
        database,
        [...previous, { role: 'user', content }],
        calderPikeUser,
      );
      expect(context).toContain('Product: SBL-RPC-12 — Redline Power Cell R12');
      expect(context).toContain('Wholesale price: $680.00');
      expect(context).toContain('Available to promise: 312.');
      expect(context).not.toContain('Order: SBL-2026-000417');
    }
    for (const sku of [
      'SBL-RPC-123',
      'SBL-RPC-12X',
      'SBL-RPC-12-EXTRA',
      'SBL-RPC',
    ]) {
      expect(
        await database
          .prepare('SELECT item_number FROM products WHERE item_number = ?')
          .bind(sku)
          .first(),
      ).toBeNull();
      const context = await buildAuthorizedContext(
        database,
        [
          ...previous,
          { role: 'user', content: `Is ${sku} available at this warehouse?` },
        ],
        calderPikeUser,
      );
      expect(context).toContain(`No catalog item matching ${sku} was found.`);
      expect(context).not.toMatch(
        /Product:|Wholesale price:|Available to promise|Order:/,
      );
    }
  });
  it('prioritizes full product names and item numbers over shared search terms', async () => {
    const database = await getDatabase();
    const scenarios = [
      {
        prompts: [
          'Are 7 units of Coldstart Rack Controller R2 available?',
          'Are 7 units of the SBL-CSR-R2 controller available?',
          'ARE 7 UNITS OF COLDSTART RACK CONTROLLER R2 AVAILABLE?',
        ],
        product: 'SBL-CSR-R2 — Coldstart Rack Controller R2; category Compute.',
        fact: 'Stock shortfall for requested quantity 7: 7 units (7 requested; 0 available).',
      },
      {
        // The same matcher is used for product questions without catalog words.
        prompts: ['Tell me about Coldstart Rack Controller R2.'],
        product: 'SBL-CSR-R2 — Coldstart Rack Controller R2; category Compute.',
        fact: 'Available to promise: 0. Inbound: 48.',
      },
      {
        // Palisade's generic "license" keyword must not override RelayMesh.
        prompts: [
          'Is RelayMesh Node License, Annual available?',
          'Is the SBL-RLY-1Y node license available?',
        ],
        product:
          'SBL-RLY-1Y — RelayMesh Node License, Annual; category Software.',
        fact: 'Wholesale price: $620.00 per node; minimum block 10.',
      },
      {
        // Keyword-only lookups must still work when no full name or SKU appears.
        prompts: ['What is the haptic availability?'],
        product:
          'SBL-BCH-V3 — Blackchannel Haptic Controller; category Interface.',
        fact: 'Available to promise: 134.',
      },
    ];
    for (const { prompts, product, fact } of scenarios) {
      for (const content of prompts) {
        const context = await buildAuthorizedContext(
          database,
          [{ role: 'user', content }],
          calderPikeUser,
        );
        expect
          .soft(
            context.split('\n').filter((line) => line.startsWith('Product:')),
            content,
          )
          .toEqual([`Product: ${product}`]);
        expect.soft(context, content).toContain(fact);
      }
    }
  });

  it('builds an exact product and inventory context', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'How many Redline Power Cell R12 units are available?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message: 'how many redline power cell r12 units are available?',
      category: 'Power',
      quantity: undefined,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const product = await database
      .prepare(
        `SELECT p.item_number, p.product_name, p.category,
          p.fulfillment_type, p.unit_price_cents, p.unit_label,
          p.case_pack, p.lead_time_days,
          SUM(i.on_hand_quantity) AS on_hand,
          SUM(i.reserved_quantity) AS reserved,
          SUM(i.quarantined_quantity) AS quarantined,
          SUM(i.inbound_quantity) AS inbound,
          MIN(i.expected_restock_date) AS expected_restock_date,
          MAX(i.updated_at) AS updated_at
         FROM products p
         JOIN inventory_balances i ON i.item_number = p.item_number
         WHERE p.item_number = ?
         GROUP BY p.item_number`,
      )
      .bind('SBL-RPC-12')
      .first<Record<string, string | number | null>>();

    expect(product).toEqual({
      item_number: 'SBL-RPC-12',
      product_name: 'Redline Power Cell R12',
      category: 'Power',
      fulfillment_type: 'physical',
      unit_price_cents: 68_000,
      unit_label: 'cell',
      case_pack: 8,
      lead_time_days: 18,
      on_hand: 376,
      reserved: 64,
      quarantined: 0,
      inbound: 0,
      expected_restock_date: null,
      updated_at: '2026-09-02T09:00:00Z',
    });
    expect(
      Number(product?.on_hand) -
        Number(product?.reserved) -
        Number(product?.quarantined),
    ).toBe(312);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Available to promise: 312. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`);
    expect(context).not.toMatch(/\bWHS-\d{4}\b/);
    expect(context).not.toContain('Calder Pike Distribution');
    expect(context).not.toContain('Meridian Civic Supply');
  });

  it('excludes quarantined and inbound units from current availability', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'What is the availability and expected restock for SBL-CSR-R2?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message: 'what is the availability and expected restock for sbl-csr-r2?',
      category: undefined,
      quantity: undefined,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const inventory = await database
      .prepare(
        `SELECT SUM(on_hand_quantity) AS on_hand,
          SUM(reserved_quantity) AS reserved,
          SUM(quarantined_quantity) AS quarantined,
          SUM(inbound_quantity) AS inbound,
          MIN(expected_restock_date) AS expected_restock_date
         FROM inventory_balances WHERE item_number = ?`,
      )
      .bind('SBL-CSR-R2')
      .first<{
        on_hand: number;
        reserved: number;
        quarantined: number;
        inbound: number;
        expected_restock_date: string | null;
      }>();

    expect(inventory).toEqual({
      on_hand: 36,
      reserved: 0,
      quarantined: 36,
      inbound: 48,
      expected_restock_date: '2026-12-03',
    });
    if (!inventory) throw new Error('Missing Coldstart inventory fixture');
    expect(inventory.on_hand - inventory.reserved - inventory.quarantined).toBe(
      0,
    );

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-CSR-R2 — Coldstart Rack Controller R2; category Compute.
Wholesale price: $2,250.00 per controller; case pack 4; standard lead time 90 days.
Available to promise: 0. Inbound: 48. Expected restock: 2026-12-03.
Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`);
    expect(context).not.toMatch(/\bWHS-\d{4}\b/);
  });

  it('reports a stock shortfall for a valid case-pack quantity', async () => {
    const requestedQuantity = 320;
    const messages = [
      {
        role: 'user' as const,
        content: `Are ${requestedQuantity} units of the Redline Power Cell R12 available?`,
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message: 'are 320 units of the redline power cell r12 available?',
      category: 'Power',
      quantity: requestedQuantity,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const inventory = await database
      .prepare(
        `SELECT p.case_pack,
          SUM(i.on_hand_quantity) AS on_hand,
          SUM(i.reserved_quantity) AS reserved,
          SUM(i.quarantined_quantity) AS quarantined
         FROM products p
         JOIN inventory_balances i ON i.item_number = p.item_number
         WHERE p.item_number = ?
         GROUP BY p.item_number`,
      )
      .bind('SBL-RPC-12')
      .first<{
        case_pack: number;
        on_hand: number;
        reserved: number;
        quarantined: number;
      }>();

    expect(inventory).toEqual({
      case_pack: 8,
      on_hand: 376,
      reserved: 64,
      quarantined: 0,
    });
    if (!inventory) throw new Error('Missing Redline inventory fixture');

    const available =
      inventory.on_hand - inventory.reserved - inventory.quarantined;
    expect(requestedQuantity % inventory.case_pack).toBe(0);
    expect(requestedQuantity).toBeLessThan(inventory.on_hand);
    expect(available).toBe(312);
    expect(requestedQuantity - available).toBe(8);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Requested quantity 320: valid case-pack multiple; exceeds current available-to-promise stock by 8.
Stock shortfall for requested quantity 320: 8 units (320 requested; 312 available). Case-pack adjustment distance is not a stock shortfall.
Available to promise: 312. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`);
  });

  it('flags an invalid case-pack quantity despite sufficient stock', async () => {
    const requestedQuantity = 310;
    const messages = [
      {
        role: 'user' as const,
        content: `Are ${requestedQuantity} units of the Redline Power Cell R12 available?`,
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message: 'are 310 units of the redline power cell r12 available?',
      category: 'Power',
      quantity: requestedQuantity,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const inventory = await database
      .prepare(
        `SELECT p.case_pack,
          SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity) AS available
         FROM products p
         JOIN inventory_balances i ON i.item_number = p.item_number
         WHERE p.item_number = ?
         GROUP BY p.item_number`,
      )
      .bind('SBL-RPC-12')
      .first<{ case_pack: number; available: number }>();

    expect(inventory).toEqual({ case_pack: 8, available: 312 });
    if (!inventory) throw new Error('Missing Redline inventory fixture');

    expect(requestedQuantity).toBeLessThan(inventory.available);
    expect(requestedQuantity % inventory.case_pack).toBe(6);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Requested quantity 310: not a multiple of case pack 8; currently within available-to-promise stock.
Stock shortfall for requested quantity 310: 0 units (310 requested; 312 available). Case-pack adjustment distance is not a stock shortfall.
Ordering restriction: quantity 310 cannot be ordered or fulfilled as requested. It must be adjusted to a full case-pack multiple of 8; sufficient stock does not waive this rule. Do not offer partial-unit or broken-case exceptions to this ordering restriction.
Lower valid quantity: 304 units (38 cases), 6 units below requested quantity 310; within current available-to-promise stock.
Higher valid quantity: 312 units (39 cases), 2 units above requested quantity 310; within current available-to-promise stock.
Nearest valid quantity: 312 units (2 units from requested quantity 310). Nearest means smallest absolute quantity difference, not rounding down or a guarantee of stock availability.
Response labeling: Only 312 units is nearest. 304 units is a valid alternative, not a nearest quantity. If listing both, label the list "Valid alternatives", not "Nearest quantities".
Available to promise: 312. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`);
  });

  it('calculates nearest case-pack alternatives without confusing distance with stock availability', async () => {
    const database = await getDatabase();
    // Independently authored expectations; do not import the production
    // calculation into its own oracle. The fixture product has case pack 8.
    const scenarios = [
      {
        requested: 306,
        expected: [
          'Lower valid quantity: 304 units (38 cases), 2 units below requested quantity 306; within current available-to-promise stock.',
          'Higher valid quantity: 312 units (39 cases), 6 units above requested quantity 306; within current available-to-promise stock.',
          'Nearest valid quantity: 304 units (2 units from requested quantity 306).',
        ],
      },
      {
        requested: 308,
        expected: [
          'Lower valid quantity: 304 units (38 cases), 4 units below requested quantity 308;',
          'Higher valid quantity: 312 units (39 cases), 4 units above requested quantity 308;',
          'Equally nearest valid quantities: 304 or 312 units (4 units from requested quantity 308).',
        ],
      },
      {
        requested: 2,
        expected: [
          'Higher valid quantity: 8 units (1 case), 6 units above requested quantity 2; within current available-to-promise stock.',
          'Nearest valid quantity: 8 units (6 units from requested quantity 2).',
        ],
      },
      {
        requested: 318,
        expected: [
          'Lower valid quantity: 312 units (39 cases), 6 units below requested quantity 318; within current available-to-promise stock.',
          'Higher valid quantity: 320 units (40 cases), 2 units above requested quantity 318; exceeds current available-to-promise stock by 8 units.',
          'Nearest valid quantity: 320 units (2 units from requested quantity 318).',
        ],
      },
    ];
    for (const { requested, expected } of scenarios) {
      const context = await buildAuthorizedContext(
        database,
        [
          {
            role: 'user',
            content: `Are ${requested} units of Redline Power Cell R12 available?`,
          },
        ],
        calderPikeUser,
      );
      for (const line of expected)
        expect(context, `Quantity ${requested}`).toContain(line);
      expect(context).not.toContain('Lower valid quantity: 0 units');
      expect(context).toContain(
        'Nearest means smallest absolute quantity difference, not rounding down or a guarantee of stock availability.',
      );
    }
    const validQuantityContext = await buildAuthorizedContext(
      database,
      [
        {
          role: 'user',
          content: 'Are 312 units of Redline Power Cell R12 available?',
        },
      ],
      calderPikeUser,
    );
    expect(validQuantityContext).toContain(
      'Requested quantity 312: valid case-pack multiple;',
    );
    expect(validQuantityContext).not.toMatch(
      /(?:Lower|Higher|Nearest) valid quantity:/,
    );
    // A second product prevents hard-coding Redline's eight-unit case size.
    const controllerContext = await buildAuthorizedContext(
      database,
      [
        {
          role: 'user',
          content: 'Are 7 units of SBL-CSR-R2 available?',
        },
      ],
      calderPikeUser,
    );
    expect(controllerContext).toContain('case pack 4;');
    expect(controllerContext).toContain(
      'Higher valid quantity: 8 units (2 cases), 1 unit above requested quantity 7; exceeds current available-to-promise stock by 8 units.',
    );
    expect(controllerContext).toContain(
      'Nearest valid quantity: 8 units (1 unit from requested quantity 7).',
    );
  });

  it('labels only the closest case-pack alternatives as nearest, including genuine ties', async () => {
    const database = await getDatabase();
    // Expected labels are authored independently of the production arithmetic.
    const scenarios = [
      {
        item: 'SBL-RPC-12',
        requested: 310,
        label:
          'Only 312 units is nearest. 304 units is a valid alternative, not a nearest quantity. If listing both, label the list "Valid alternatives", not "Nearest quantities".',
      },
      {
        item: 'SBL-RPC-12',
        requested: 306,
        label:
          'Only 304 units is nearest. 312 units is a valid alternative, not a nearest quantity. If listing both, label the list "Valid alternatives", not "Nearest quantities".',
      },
      {
        item: 'SBL-RPC-12',
        requested: 308,
        label:
          '304 and 312 units are equally nearest. Both may appear in a "Nearest quantities" list.',
      },
      {
        item: 'SBL-RPC-12',
        requested: 2,
        label: 'Only 8 units is nearest.',
      },
      {
        // The closest multiple remains closest even when it exceeds stock.
        item: 'SBL-RPC-12',
        requested: 318,
        label:
          'Only 320 units is nearest. 312 units is a valid alternative, not a nearest quantity. If listing both, label the list "Valid alternatives", not "Nearest quantities".',
      },
      {
        // This product uses packs of four and has no available stock.
        item: 'SBL-CSR-R2',
        requested: 7,
        label:
          'Only 8 units is nearest. 4 units is a valid alternative, not a nearest quantity. If listing both, label the list "Valid alternatives", not "Nearest quantities".',
      },
      {
        item: 'SBL-RPC-12',
        requested: 312,
        label: null,
      },
    ];
    for (const { item, requested, label } of scenarios) {
      const context = await buildAuthorizedContext(
        database,
        [
          {
            role: 'user',
            content: `Are ${requested} units of ${item} available?`,
          },
        ],
        calderPikeUser,
      );
      expect(
        context
          .split('\n')
          .filter((line) => line.startsWith('Response labeling:')),
        `${item}, quantity ${requested}`,
      ).toEqual(label === null ? [] : [`Response labeling: ${label}`]);
    }
  });

  it('calculates requested stock shortfall independently of case-pack adjustment distance', async () => {
    const database = await getDatabase();
    // Independently authored values: Redline has 312 available; Coldstart has
    // zero. Reserved, quarantined, and inbound units cannot cover a shortfall.
    const scenarios = [
      { item: 'SBL-RPC-12', requested: 310, available: 312, shortfall: 0 },
      { item: 'SBL-RPC-12', requested: 306, available: 312, shortfall: 0 },
      { item: 'SBL-RPC-12', requested: 2, available: 312, shortfall: 0 },
      { item: 'SBL-RPC-12', requested: 312, available: 312, shortfall: 0 },
      { item: 'SBL-RPC-12', requested: 313, available: 312, shortfall: 1 },
      // Requested shortage is 6, not the 2-unit adjustment or the adjusted
      // 320-unit quantity's 8-unit shortage.
      { item: 'SBL-RPC-12', requested: 318, available: 312, shortfall: 6 },
      { item: 'SBL-RPC-12', requested: 320, available: 312, shortfall: 8 },
      { item: 'SBL-CSR-R2', requested: 7, available: 0, shortfall: 7 },
      { item: 'SBL-CSR-R2', requested: 4, available: 0, shortfall: 4 },
    ];
    for (const { item, requested, available, shortfall } of scenarios) {
      const context = await buildAuthorizedContext(
        database,
        [
          {
            role: 'user',
            content: `Are ${requested} units of ${item} available?`,
          },
        ],
        calderPikeUser,
      );
      expect(
        context
          .split('\n')
          .filter((line) =>
            line.startsWith('Stock shortfall for requested quantity'),
          ),
        `${item}, quantity ${requested}`,
      ).toEqual([
        `Stock shortfall for requested quantity ${requested}: ${shortfall} units (${requested} requested; ${available} available). Case-pack adjustment distance is not a stock shortfall.`,
      ]);
    }
    // Do not manufacture a requested quantity or physical license inventory.
    for (const content of [
      'How many SBL-RPC-12 units are available?',
      'How many Redline Power Cell R12 units are available?',
      'Are 50 licenses of Palisade Endpoint License, Annual available?',
      'Are 60 licenses of Palisade Endpoint License, Annual available?',
    ]) {
      const context = await buildAuthorizedContext(
        database,
        [{ role: 'user', content }],
        calderPikeUser,
      );
      expect(context, content).not.toContain(
        'Stock shortfall for requested quantity',
      );
    }
  });

  it('grounds warehouse availability in each location inventory balance', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Where is the Redline Power Cell R12 stocked?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message: 'where is the redline power cell r12 stocked?',
      category: 'Power',
      quantity: undefined,
      includeLocations: true,
      compare: false,
    });

    const database = await getDatabase();
    const locations = await database
      .prepare(
        `SELECT l.location_name, l.service_region,
          i.on_hand_quantity, i.reserved_quantity, i.quarantined_quantity,
          i.inbound_quantity, i.expected_restock_date
         FROM inventory_balances i
         JOIN fulfillment_locations l ON l.location_id = i.location_id
         WHERE i.item_number = ?
         ORDER BY l.location_id`,
      )
      .bind('SBL-RPC-12')
      .all<{
        location_name: string;
        service_region: string;
        on_hand_quantity: number;
        reserved_quantity: number;
        quarantined_quantity: number;
        inbound_quantity: number;
        expected_restock_date: string | null;
      }>();

    expect(locations.results).toEqual([
      {
        location_name: 'Atlantic Stack Fulfillment Hub',
        service_region: 'North Atlantic Trade District',
        on_hand_quantity: 188,
        reserved_quantity: 32,
        quarantined_quantity: 0,
        inbound_quantity: 0,
        expected_restock_date: null,
      },
      {
        location_name: 'Great Lakes Technical Depot',
        service_region: 'Great Lakes District',
        on_hand_quantity: 112,
        reserved_quantity: 19,
        quarantined_quantity: 0,
        inbound_quantity: 0,
        expected_restock_date: null,
      },
      {
        location_name: 'Pacific Rim Bonded Yard',
        service_region: 'Pacific Trade Zone',
        on_hand_quantity: 76,
        reserved_quantity: 13,
        quarantined_quantity: 0,
        inbound_quantity: 0,
        expected_restock_date: null,
      },
    ]);
    const availableByLocation = locations.results.map(
      (location) =>
        location.on_hand_quantity -
        location.reserved_quantity -
        location.quarantined_quantity,
    );
    expect(availableByLocation).toEqual([156, 93, 63]);
    expect(
      availableByLocation.reduce((total, available) => total + available, 0),
    ).toBe(312);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Available to promise: 312. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
Fulfillment locations:
- Atlantic Stack Fulfillment Hub (North Atlantic Trade District): 156 available; 0 inbound; restock not scheduled.
- Great Lakes Technical Depot (Great Lakes District): 93 available; 0 inbound; restock not scheduled.
- Pacific Rim Bonded Yard (Pacific Trade Zone): 63 available; 0 inbound; restock not scheduled.
</authorized_records>`);
    expect(context).not.toMatch(/\bWHS-\d{4}\b/);
  });

  it('grounds a valid digital-license quantity without physical inventory', async () => {
    const requestedQuantity = 50;
    const messages = [
      {
        role: 'user' as const,
        content: `Are ${requestedQuantity} licenses of Palisade Endpoint License, Annual available?`,
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message:
        'are 50 licenses of palisade endpoint license, annual available?',
      category: undefined,
      quantity: requestedQuantity,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const product = await database
      .prepare(
        `SELECT p.product_name, p.category, p.fulfillment_type,
          p.unit_price_cents, p.unit_label, p.case_pack,
          COUNT(i.item_number) AS inventory_rows
         FROM products p
         LEFT JOIN inventory_balances i ON i.item_number = p.item_number
         WHERE p.item_number = ?
         GROUP BY p.item_number`,
      )
      .bind('SBL-PAL-1Y')
      .first<{
        product_name: string;
        category: string;
        fulfillment_type: string;
        unit_price_cents: number;
        unit_label: string;
        case_pack: number;
        inventory_rows: number;
      }>();

    expect(product).toEqual({
      product_name: 'Palisade Endpoint License, Annual',
      category: 'Software',
      fulfillment_type: 'license',
      unit_price_cents: 39_000,
      unit_label: 'seat',
      case_pack: 25,
      inventory_rows: 0,
    });
    if (!product) throw new Error('Missing Palisade license fixture');
    expect(requestedQuantity % product.case_pack).toBe(0);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-PAL-1Y — Palisade Endpoint License, Annual; category Software.
Wholesale price: $390.00 per seat; minimum block 25.
Requested quantity 50: valid minimum-block multiple.
This is a digitally allocated license and does not have a physical stock balance.
</authorized_records>`);
    expect(context).not.toMatch(
      /Available to promise|Inbound:|Expected restock:|Fulfillment locations:/,
    );
  });

  it('requires a digital-license quantity to be a whole allocation block', async () => {
    const requestedQuantity = 60;
    const messages = [
      {
        role: 'user' as const,
        content: `Are ${requestedQuantity} licenses of Palisade Endpoint License, Annual available?`,
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message:
        'are 60 licenses of palisade endpoint license, annual available?',
      category: undefined,
      quantity: requestedQuantity,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const product = await database
      .prepare(
        'SELECT fulfillment_type, case_pack FROM products WHERE item_number = ?',
      )
      .bind('SBL-PAL-1Y')
      .first<{ fulfillment_type: string; case_pack: number }>();

    expect(product).toEqual({ fulfillment_type: 'license', case_pack: 25 });
    if (!product) throw new Error('Missing Palisade license fixture');
    expect(requestedQuantity).toBeGreaterThan(product.case_pack);
    expect(requestedQuantity % product.case_pack).toBe(10);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-PAL-1Y — Palisade Endpoint License, Annual; category Software.
Wholesale price: $390.00 per seat; minimum block 25.
Requested quantity 60: must be adjusted to a multiple of 25.
This is a digitally allocated license and does not have a physical stock balance.
</authorized_records>`);
    expect(context).not.toMatch(
      /valid minimum-block multiple|Available to promise|Inbound:|Expected restock:|Fulfillment locations:/,
    );
  });

  it('returns both Software products with their digital allocation details', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'List the Software catalog.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message: 'list the software catalog.',
      category: 'Software',
      quantity: undefined,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const products = await database
      .prepare(
        `SELECT item_number, product_name, fulfillment_type,
          unit_price_cents, unit_label, case_pack, lead_time_days, active_to
         FROM products WHERE category = ? ORDER BY product_name`,
      )
      .bind('Software')
      .all<Record<string, string | number | null>>();

    expect(products.results).toEqual([
      {
        item_number: 'SBL-PAL-1Y',
        product_name: 'Palisade Endpoint License, Annual',
        fulfillment_type: 'license',
        unit_price_cents: 39_000,
        unit_label: 'seat',
        case_pack: 25,
        lead_time_days: 0,
        active_to: null,
      },
      {
        item_number: 'SBL-RLY-1Y',
        product_name: 'RelayMesh Node License, Annual',
        fulfillment_type: 'license',
        unit_price_cents: 62_000,
        unit_label: 'node',
        case_pack: 10,
        lead_time_days: 0,
        active_to: null,
      },
    ]);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Active Software catalog retrieved at 2026-09-12T15:00:00.000Z:
- SBL-PAL-1Y Palisade Endpoint License, Annual: $390.00 per seat; pack 25; lead 0 days; digital allocation.
- SBL-RLY-1Y RelayMesh Node License, Annual: $620.00 per node; pack 10; lead 0 days; digital allocation.
</authorized_records>`);
    expect(context).not.toMatch(/\b\d+ available\b|\binbound\b|\bWHS-\d{4}\b/);
  });

  it('lists only active products meeting the low-stock advisory threshold', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'Show current low-stock inventory advisories.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message: 'show current low-stock inventory advisories.',
      category: undefined,
      quantity: undefined,
      includeLocations: false,
      compare: false,
    });

    const database = await getDatabase();
    const inventory = await database
      .prepare(
        `SELECT p.item_number, p.case_pack, p.active_to,
          SUM(i.on_hand_quantity) AS on_hand,
          SUM(i.reserved_quantity) AS reserved,
          SUM(i.quarantined_quantity) AS quarantined,
          SUM(i.inbound_quantity) AS inbound,
          MIN(i.expected_restock_date) AS restock
         FROM products p
         JOIN inventory_balances i ON i.item_number = p.item_number
         GROUP BY p.item_number`,
      )
      .all<{
        item_number: string;
        case_pack: number;
        active_to: string | null;
        on_hand: number;
        reserved: number;
        quarantined: number;
        inbound: number;
        restock: string | null;
      }>();

    const balances = inventory.results.map((product) => ({
      ...product,
      available: product.on_hand - product.reserved - product.quarantined,
    }));
    expect(
      balances.find((product) => product.item_number === 'SBL-GLV-V5'),
    ).toMatchObject({
      active_to: '2025-06-30',
      case_pack: 4,
      available: 8,
    });
    expect(
      balances.find((product) => product.item_number === 'SBL-RPC-12'),
    ).toMatchObject({
      active_to: null,
      case_pack: 8,
      available: 312,
    });
    const advisories = balances
      .filter(
        (product) =>
          product.active_to === null &&
          product.available <= product.case_pack * 8,
      )
      .sort(
        (first, second) =>
          first.available - second.available ||
          first.item_number.localeCompare(second.item_number),
      )
      .map(({ item_number, available, inbound, restock }) => ({
        item_number,
        available,
        inbound,
        restock,
      }));
    expect(advisories).toEqual([
      {
        item_number: 'SBL-CSR-R2',
        available: 0,
        inbound: 48,
        restock: '2026-12-03',
      },
      {
        item_number: 'SBL-NL-4P',
        available: 0,
        inbound: 80,
        restock: '2026-10-14',
      },
      { item_number: 'SBL-KTA-T7', available: 7, inbound: 0, restock: null },
    ]);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Current SABLE physical inventory advisories retrieved at 2026-09-12T15:00:00.000Z:
- SBL-CSR-R2 Coldstart Rack Controller R2: 0 available; 48 inbound; restock 2026-12-03.
- SBL-NL-4P Nerveline Four-Port Neural I/O Hub: 0 available; 80 inbound; restock 2026-10-14.
- SBL-KTA-T7 Kestrel Tendon Assembly T7: 7 available; 0 inbound; restock not scheduled.
Ask which item the customer wants if a specific availability decision is required.
</authorized_records>`);
  });

  it('excludes keyword matches inside explicit product references from comparisons', async () => {
    const database = await getDatabase();
    // Independently authored product sets, not derived from the matcher or seed.
    const scenarios = [
      {
        prompts: [
          'Compare Coldstart Rack Controller R2 versus Redline Power Cell R12.',
          'Compare Coldstart Rack Controller R2 (SBL-CSR-R2) versus Redline Power Cell R12 (SBL-RPC-12).',
          'Compare Coldstart Rack Controller R2 versus SBL-RPC-12.',
          'Compare Coldstart Rack Controller R2 versus Redline.',
          'Compare SBL-CSR-R2 versus Redline.',
          'Compare Coldstart versus Redline Power Cell R12.',
          'COMPARE REDLINE POWER CELL R12 VERSUS COLDSTART RACK CONTROLLER R2.',
          'Compare Coldstart Rack Controller R2 versus Redline. Include the lead time for Coldstart Rack Controller R2.',
          'Compare Coldstart versus Redline.',
        ],
        products: [
          'Product: SBL-CSR-R2 — Coldstart Rack Controller R2; category Compute.',
          'Product: SBL-RPC-12 — Redline Power Cell R12; category Power.',
        ],
      },
      {
        // A generic "license" match must not introduce Palisade here.
        prompts: [
          'Compare RelayMesh Node License, Annual versus Redline Power Cell R12.',
          'Compare RelayMesh Node License, Annual versus Redline.',
          'Compare SBL-RLY-1Y versus Redline.',
        ],
        products: [
          'Product: SBL-RLY-1Y — RelayMesh Node License, Annual; category Software.',
          'Product: SBL-RPC-12 — Redline Power Cell R12; category Power.',
        ],
      },
      {
        // A separate keyword mention remains eligible, even when the same word
        // also occurs inside the explicit product name.
        prompts: [
          'Compare Coldstart Rack Controller R2 versus haptic.',
          'Compare Coldstart Rack Controller R2 versus controller.',
          'Compare Coldstart Rack Controller R2 versus Blackchannel Haptic Controller.',
        ],
        products: [
          'Product: SBL-CSR-R2 — Coldstart Rack Controller R2; category Compute.',
          'Product: SBL-BCH-V3 — Blackchannel Haptic Controller; category Interface.',
        ],
      },
    ];
    for (const { prompts, products } of scenarios) {
      for (const content of prompts) {
        const context = await buildAuthorizedContext(
          database,
          [{ role: 'user', content }],
          calderPikeUser,
        );
        expect
          .soft(
            context
              .split('\n')
              .filter((line) => line.startsWith('Product:'))
              .sort(),
            content,
          )
          .toEqual([...products].sort());
      }
    }
  });

  it('builds an exact comparison context for two products', async () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          'Compare the Nightvault 16 TB Solid-State Array versus the Redline Power Cell R12.',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'catalog',
      message:
        'compare the nightvault 16 tb solid-state array versus the redline power cell r12.',
      category: 'Power',
      quantity: undefined,
      includeLocations: false,
      compare: true,
    });

    const database = await getDatabase();
    const products = await database
      .prepare(
        `SELECT p.item_number, p.product_name, p.unit_price_cents,
          p.unit_label, p.case_pack, p.lead_time_days,
          SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity) AS available
         FROM products p
         JOIN inventory_balances i ON i.item_number = p.item_number
         WHERE p.item_number IN (?, ?)
         GROUP BY p.item_number
         ORDER BY p.product_name`,
      )
      .bind('SBL-NV-16T', 'SBL-RPC-12')
      .all<Record<string, string | number>>();

    expect(products.results).toEqual([
      {
        item_number: 'SBL-NV-16T',
        product_name: 'Nightvault 16 TB Solid-State Array',
        unit_price_cents: 194_000,
        unit_label: 'array',
        case_pack: 4,
        lead_time_days: 35,
        available: 96,
      },
      {
        item_number: 'SBL-RPC-12',
        product_name: 'Redline Power Cell R12',
        unit_price_cents: 68_000,
        unit_label: 'cell',
        case_pack: 8,
        lead_time_days: 18,
        available: 312,
      },
    ]);

    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toBe(`<authorized_records>
Product: SBL-NV-16T — Nightvault 16 TB Solid-State Array; category Compute.
Wholesale price: $1,940.00 per array; case pack 4; standard lead time 35 days.
Available to promise: 96. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Available to promise: 312. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-09-12T15:00:00.000Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`);
    expect(context).not.toMatch(/\bWHS-\d{4}\b/);
    expect(context).not.toContain('Calder Pike Distribution');
    expect(context).not.toContain('Meridian Civic Supply');
  });
});
