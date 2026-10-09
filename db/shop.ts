import type { AuthenticatedUser } from './auth';
import type {
  CatalogProduct,
  CheckoutFailure,
  CheckoutInput,
  CheckoutReceipt,
} from '@/lib/contracts';
import { isProductOrderable } from '@/lib/product-eligibility';
import {
  parseCheckoutFailure,
  parseCheckoutInput,
  parseCheckoutReceipt,
} from '@/lib/checkout';
import { sameSessionSubject } from '@/lib/session-subject';

type ProductRow = {
  item_number: string;
  product_name: string;
  category: string;
  fulfillment_type: 'physical' | 'license';
  unit_price_cents: number;
  unit_label: string;
  case_pack: number;
  lead_time_days: number;
  warranty_months: number;
  active_to: string | null;
  available_quantity: number | null;
  inbound_quantity: number | null;
  restock_date: string | null;
};

type InventoryRow = {
  location_id: string;
  available_quantity: number;
};

export async function getCatalog(db: D1Database): Promise<CatalogProduct[]> {
  const rows = await db
    .prepare(`SELECT
    p.item_number, p.product_name, p.category, p.fulfillment_type,
    p.unit_price_cents, p.unit_label, p.case_pack, p.lead_time_days,
    p.warranty_months, p.active_to,
    CASE WHEN p.fulfillment_type = 'license' THEN NULL
      ELSE COALESCE(SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity), 0)
    END AS available_quantity,
    COALESCE(SUM(i.inbound_quantity), 0) AS inbound_quantity,
    MIN(i.expected_restock_date) AS restock_date
    FROM products p
    LEFT JOIN inventory_balances i ON i.item_number = p.item_number
    GROUP BY p.item_number
    ORDER BY p.category, p.product_name`)
    .all<ProductRow>();

  return rows.results
    .filter((row) => isProductOrderable(row.active_to))
    .map((row) => ({
      itemNumber: row.item_number,
      name: row.product_name,
      category: row.category,
      fulfillmentType: row.fulfillment_type,
      unitPriceCents: row.unit_price_cents,
      unitLabel: row.unit_label,
      casePack: row.case_pack,
      leadTimeDays: row.lead_time_days,
      warrantyMonths: row.warranty_months,
      availableQuantity:
        row.fulfillment_type === 'license'
          ? null
          : Number(row.available_quantity ?? 0),
      inboundQuantity: Number(row.inbound_quantity ?? 0),
      restockDate: row.restock_date,
    }));
}

export async function placeChargeAccountOrder(
  db: D1Database,
  value: unknown,
  user: AuthenticatedUser,
): Promise<CheckoutReceipt> {
  const input = parseCheckoutInput(value);
  if (!input) {
    throw new CheckoutError(
      'Reload and review the account, PO, ship date, destination, and order lines before trying again.',
      400,
    );
  }
  if (
    !sameSessionSubject(input.expectedSubject, {
      userId: user.userId,
      customerId: user.distributorId,
    })
  ) {
    throw new CheckoutError(
      'Your signed-in account changed. Reload and review the order before authorizing it again.',
      409,
      'account_changed',
    );
  }
  const createdAt = new Date().toISOString();
  const intent = JSON.stringify({
    ...input,
    items: input.items.toSorted((left, right) =>
      left.itemNumber < right.itemNumber ? -1 : 1,
    ),
  });
  const existing = await recoverCheckout(db, input.commandId, intent);
  if (existing) return existing;
  try {
    return await createOrder(db, input, user, intent, createdAt);
  } catch (error) {
    if (error instanceof CheckoutError) {
      // A terminal rejection must also win the command's unique identity. This
      // prevents an earlier, still-running attempt from committing afterward.
      await db
        .prepare(`INSERT INTO checkout_commands (command_id, intent_json, status, response_json)
        VALUES (?, ?, ?, ?) ON CONFLICT(command_id) DO NOTHING`)
        .bind(
          input.commandId,
          intent,
          error.status,
          JSON.stringify({
            error: error.message,
            code: error.code,
          } satisfies CheckoutFailure),
        )
        .run();
    }
    // A concurrent winner can commit during validation, or the database can
    // commit our batch before losing its acknowledgment. Resolve identity first.
    const recovered = await recoverCheckout(db, input.commandId, intent);
    if (recovered) return recovered;
    throw error;
  }
}

async function recoverCheckout(
  db: D1Database,
  commandId: string,
  intent: string,
): Promise<CheckoutReceipt | null> {
  const saved = await db
    .prepare(
      'SELECT intent_json, status, response_json FROM checkout_commands WHERE command_id = ?',
    )
    .bind(commandId)
    .first<{ intent_json: string; status: number; response_json: string }>();
  if (!saved) return null;
  // Normalized intent includes the authenticated user and distributor. A
  // different owner receives the same conflict as any other intent mismatch.
  if (saved.intent_json !== intent) {
    throw new CheckoutError(
      'These checkout details conflict with an earlier submission. Check order history before starting another order.',
      409,
      'command_conflict',
    );
  }
  const response: unknown = JSON.parse(saved.response_json);
  if (saved.status !== 201) {
    const failure = parseCheckoutFailure(response);
    if (!failure || ![409, 422].includes(saved.status))
      throw new Error('Stored checkout rejection is invalid.');
    throw new CheckoutError(failure.error, saved.status, failure.code);
  }
  const receipt = parseCheckoutReceipt(response, commandId);
  if (!receipt) throw new Error('Stored checkout receipt is invalid.');
  return receipt;
}

async function createOrder(
  db: D1Database,
  input: CheckoutInput,
  user: AuthenticatedUser,
  intent: string,
  createdAt: string,
): Promise<CheckoutReceipt> {
  const today = createdAt.slice(0, 10);
  if (input.requestedShipDate < today) {
    throw new CheckoutError('Requested ship date cannot be in the past.', 422);
  }

  const catalog = await getCatalog(db);
  const productById = new Map(
    catalog.map((product) => [product.itemNumber, product]),
  );
  let totalCents = 0;
  const inventoryUpdates: D1PreparedStatement[] = [];

  for (const line of input.items) {
    const product = productById.get(line.itemNumber);
    if (!product)
      throw new CheckoutError(`Item ${line.itemNumber} is not orderable.`, 422);
    // Expectations guard consent; the server's catalog snapshot owns the charge.
    if (line.expectedUnitPriceCents !== product.unitPriceCents) {
      throw new CheckoutError(
        'Prices changed. Review the updated order and authorize it again.',
        409,
        'price_changed',
      );
    }
    if (line.quantity % product.casePack !== 0) {
      throw new CheckoutError(
        `${product.name} must be ordered in case packs of ${product.casePack}.`,
        422,
      );
    }
    totalCents += product.unitPriceCents * line.quantity;
    if (!Number.isSafeInteger(totalCents)) {
      throw new CheckoutError('The order total is too large.', 422);
    }

    if (product.fulfillmentType === 'license') continue;
    const balances = await db
      .prepare(`SELECT location_id,
      on_hand_quantity - reserved_quantity - quarantined_quantity AS available_quantity
      FROM inventory_balances
      WHERE item_number = ? AND on_hand_quantity - reserved_quantity - quarantined_quantity > 0
      ORDER BY available_quantity DESC, location_id`)
      .bind(product.itemNumber)
      .all<InventoryRow>();
    let remaining = line.quantity;
    for (const balance of balances.results) {
      if (remaining === 0) break;
      const allocation = Math.min(
        remaining,
        Number(balance.available_quantity),
      );
      inventoryUpdates.push(
        db
          .prepare(`UPDATE inventory_balances
          SET reserved_quantity = reserved_quantity + ?, updated_at = ?
          WHERE item_number = ? AND location_id = ?`)
          .bind(allocation, createdAt, product.itemNumber, balance.location_id),
      );
      remaining -= allocation;
    }
    if (remaining > 0) {
      throw new CheckoutError(
        `${product.name} has only ${line.quantity - remaining} units available.`,
        409,
      );
    }
  }

  const year = today.slice(0, 4);
  const randomValue = crypto.getRandomValues(new Uint32Array(1))[0];
  const orderId = `SBL-${year}-${800000 + (randomValue % 200000)}`;
  const chargeId = `CHG-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const authorizationCode = `ACC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const receipt: CheckoutReceipt = {
    commandId: input.commandId,
    currency: user.currency,
    orderId,
    chargeId,
    authorizationCode,
    totalCents,
    requestedShipDate: input.requestedShipDate,
  };
  const statements: D1PreparedStatement[] = [
    ...inventoryUpdates,
    db
      .prepare(`INSERT INTO orders (
      order_id, customer_id, placed_by_user_id, customer_po_number, created_on,
      requested_ship_date, status, currency, order_total_cents, shipping_region
    ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`)
      .bind(
        orderId,
        user.distributorId,
        user.userId,
        input.customerPoNumber,
        today,
        input.requestedShipDate,
        user.currency,
        totalCents,
        input.shippingRegion,
      ),
  ];
  input.items.forEach((line, index) => {
    const product = productById.get(line.itemNumber)!;
    statements.push(
      db
        .prepare(`INSERT INTO order_items (
      order_id, line_number, item_number, product_name_snapshot, unit_price_cents,
      ordered_quantity, allocated_quantity, shipped_quantity, cancelled_quantity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`)
        .bind(
          orderId,
          index + 1,
          product.itemNumber,
          product.name,
          product.unitPriceCents,
          line.quantity,
          line.quantity,
        ),
    );
  });
  statements.push(
    db
      .prepare(`INSERT INTO order_events (
      event_id, order_id, occurred_at, event_type, customer_safe_description
    ) VALUES (?, ?, ?, 'order_confirmed', ?)`)
      .bind(
        `EVT-${crypto.randomUUID()}`,
        orderId,
        createdAt,
        `Wholesale order confirmed for requested ship date ${input.requestedShipDate}. Charge account authorization confirmed.`,
      ),
    db
      .prepare(`INSERT INTO account_charges (
      charge_id, order_id, charge_method, status, amount_cents, currency,
      authorization_code, authorized_at
    ) VALUES (?, ?, 'charge_account', 'authorized', ?, ?, ?, ?)`)
      .bind(
        chargeId,
        orderId,
        totalCents,
        user.currency,
        authorizationCode,
        createdAt,
      ),
  );

  statements.push(
    db
      .prepare(`INSERT INTO checkout_commands (command_id, order_id, intent_json, status, response_json)
      VALUES (?, ?, ?, 201, ?)`)
      .bind(input.commandId, orderId, intent, JSON.stringify(receipt)),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (
      message.includes(
        'UNIQUE constraint failed: orders.customer_id, orders.customer_po_number',
      )
    ) {
      throw new CheckoutError(
        'That purchase-order reference is already in use.',
        409,
      );
    }
    if (
      [
        'orders.order_id',
        'account_charges.charge_id',
        'account_charges.authorization_code',
        'order_events.event_id',
      ].some((column) =>
        message.includes(`UNIQUE constraint failed: ${column}`),
      )
    ) {
      throw new CheckoutError(
        'An order reference conflict occurred. Submit the order again.',
        409,
      );
    }
    if (
      message.includes(
        'CHECK constraint failed: reserved_quantity + quarantined_quantity <= on_hand_quantity',
      )
    ) {
      throw new CheckoutError(
        'Inventory changed during checkout. Refresh and try again.',
        409,
      );
    }
    throw error;
  }

  return receipt;
}

export class CheckoutError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: CheckoutFailure['code'],
  ) {
    super(message);
  }
}
