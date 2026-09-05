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
