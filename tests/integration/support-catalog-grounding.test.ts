import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';
import { calderPikeUser } from '../fixtures/users';

describe('support catalog grounding', () => {
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
Available to promise as of 2026-09-02: 312. Inbound: 0. Expected restock: none scheduled.
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
Available to promise as of 2026-09-02: 0. Inbound: 48. Expected restock: 2026-12-03.
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
Available to promise as of 2026-09-02: 312. Inbound: 0. Expected restock: none scheduled.
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
Available to promise as of 2026-09-02: 312. Inbound: 0. Expected restock: none scheduled.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`);
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
Available to promise as of 2026-09-02: 312. Inbound: 0. Expected restock: none scheduled.
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
Active Software catalog as of 2026-09-02:
- SBL-PAL-1Y Palisade Endpoint License, Annual: $390.00 per seat; pack 25; lead 0 days; digital allocation.
- SBL-RLY-1Y RelayMesh Node License, Annual: $620.00 per node; pack 10; lead 0 days; digital allocation.
</authorized_records>`);
    expect(context).not.toMatch(/\b\d+ available\b|\binbound\b|\bWHS-\d{4}\b/);
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
Available to promise as of 2026-09-02: 96. Inbound: 0. Expected restock: none scheduled.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Available to promise as of 2026-09-02: 312. Inbound: 0. Expected restock: none scheduled.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>`);
    expect(context).not.toMatch(/\bWHS-\d{4}\b/);
    expect(context).not.toContain('Calder Pike Distribution');
    expect(context).not.toContain('Meridian Civic Supply');
  });
});
