import type { AuthenticatedUser } from './auth';
import type { CatalogProduct } from '@/lib/contracts';
import { parseCustomerPo } from '@/lib/support-references';

type CheckoutLine = { itemNumber: string; quantity: number };
type CheckoutInput = {
  customerPoNumber: string;
  requestedShipDate: string;
  shippingRegion: string;
  items: CheckoutLine[];
};

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
    p.warranty_months,
    CASE WHEN p.fulfillment_type = 'license' THEN NULL
      ELSE COALESCE(SUM(i.on_hand_quantity - i.reserved_quantity - i.quarantined_quantity), 0)
    END AS available_quantity,
    COALESCE(SUM(i.inbound_quantity), 0) AS inbound_quantity,
    MIN(i.expected_restock_date) AS restock_date
    FROM products p
    LEFT JOIN inventory_balances i ON i.item_number = p.item_number
    WHERE p.active_to IS NULL
    GROUP BY p.item_number
    ORDER BY p.category, p.product_name`)
    .all<ProductRow>();

  return rows.results.map((row) => ({
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

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  // Date parsing can normalize impossible days into the following month.
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function parseCheckoutInput(value: unknown): CheckoutInput | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const customerPoNumber = parseCustomerPo(candidate.customerPoNumber);
  const requestedShipDate =
    typeof candidate.requestedShipDate === 'string'
      ? candidate.requestedShipDate.trim()
      : '';
  const shippingRegion =
    typeof candidate.shippingRegion === 'string'
      ? candidate.shippingRegion.trim()
      : '';
  if (
    !customerPoNumber ||
    !isCalendarDate(requestedShipDate) ||
    shippingRegion.length < 3 ||
    shippingRegion.length > 80 ||
    !Array.isArray(candidate.items) ||
    candidate.items.length === 0 ||
    candidate.items.length > 20
  )
    return null;

  const items: CheckoutLine[] = [];
  const seen = new Set<string>();
  for (const rawLine of candidate.items) {
    if (!rawLine || typeof rawLine !== 'object') return null;
    const line = rawLine as Record<string, unknown>;
    if (
      typeof line.itemNumber !== 'string' ||
      !Number.isInteger(line.quantity) ||
      Number(line.quantity) <= 0 ||
      Number(line.quantity) > 100_000 ||
      seen.has(line.itemNumber)
    )
      return null;
    seen.add(line.itemNumber);
    items.push({
      itemNumber: line.itemNumber,
      quantity: Number(line.quantity),
    });
  }
  return { customerPoNumber, requestedShipDate, shippingRegion, items };
}

export async function placeChargeAccountOrder(
  db: D1Database,
  input: CheckoutInput,
  user: AuthenticatedUser,
) {
  const createdAt = new Date().toISOString();
  const today = createdAt.slice(0, 10);
  if (!isCalendarDate(input.requestedShipDate)) {
    throw new CheckoutError('Enter a valid requested ship date.', 422);
  }
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
    if (line.quantity % product.casePack !== 0) {
      throw new CheckoutError(
        `${product.name} must be ordered in case packs of ${product.casePack}.`,
        422,
      );
    }
    totalCents += product.unitPriceCents * line.quantity;

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

  try {
    await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('UNIQUE') && message.includes('customer_po_number')) {
      throw new CheckoutError(
        'That purchase-order reference is already in use.',
        409,
      );
    }
    if (message.includes('UNIQUE')) {
      throw new CheckoutError(
        'An order reference conflict occurred. Submit the order again.',
        409,
      );
    }
    if (message.includes('CHECK constraint')) {
      throw new CheckoutError(
        'Inventory changed during checkout. Refresh and try again.',
        409,
      );
    }
    throw error;
  }

  return {
    orderId,
    chargeId,
    authorizationCode,
    totalCents,
    requestedShipDate: input.requestedShipDate,
  };
}

export class CheckoutError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
