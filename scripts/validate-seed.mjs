import assert from 'node:assert/strict';

import { AS_OF_DATE, buildSeedRecords } from '../db/seed.ts';

const records = buildSeedRecords();
const orders = records
  .filter(({ table }) => table === 'orders')
  .map(({ values }) => values);
const orderItems = records
  .filter(({ table }) => table === 'order_items')
  .map(({ values }) => values);
const products = records
  .filter(({ table }) => table === 'products')
  .map(({ values }) => values);
const distributors = records
  .filter(({ table }) => table === 'distributors')
  .map(({ values }) => values);
const users = records
  .filter(({ table }) => table === 'users')
  .map(({ values }) => values);
const credentials = records
  .filter(({ table }) => table === 'user_credentials')
  .map(({ values }) => values);
const returns = records
  .filter(({ table }) => table === 'returns')
  .map(({ values }) => values);
const deliveryEvents = new Map(
  records
    .filter(({ table }) => table === 'order_events')
    .map(({ values }) => values)
    .filter(({ event_type }) => event_type === 'delivered')
    .map(({ order_id, occurred_at }) => [order_id, occurred_at]),
);
const deliveredShipments = records
  .filter(({ table }) => table === 'shipments')
  .map(({ values }) => values)
  .filter(({ status }) => status === 'delivered');
const expectedCustomers = {
  'WHS-0427': 648,
  'WHS-1098': 24,
  'WHS-2714': 24,
  'WHS-5830': 24,
};
const expectedUserByCustomer = {
  'WHS-0427': 'USR-CPD-001',
  'WHS-1098': 'USR-MCS-001',
  'WHS-2714': 'USR-NPC-001',
  'WHS-5830': 'USR-HIX-001',
};
const customerCounts = Object.fromEntries(
  Object.keys(expectedCustomers).map((customerId) => [
    customerId,
    orders.filter((row) => row.customer_id === customerId).length,
  ]),
);
const primaryOrders = orders.filter((row) => row.customer_id === 'WHS-0427');
const futurePrimaryOrders = primaryOrders.filter(
  (row) => row.requested_ship_date > AS_OF_DATE,
).length;

assert.equal(orders.length, 720, 'expected exactly 720 orders');
assert.equal(distributors.length, 4, 'expected four authorized distributors');
assert.equal(users.length, 4, 'expected one user per authorized distributor');
assert.equal(credentials.length, 4, 'expected credentials for every user');
assert.ok(
  orders.every(
    (row) => row.placed_by_user_id === expectedUserByCustomer[row.customer_id],
  ),
  'expected every order user to belong to its distributor',
);
assert.deepEqual(
  customerCounts,
  expectedCustomers,
  'expected the agreed 90/10 tenant distribution',
);
assert.equal(
  products.length,
  18,
  'expected 16 active products plus two edge-case products',
);
assert.ok(
  orderItems.length >= 2_400,
  'expected a substantial multi-line wholesale history',
);
assert.ok(
  futurePrimaryOrders >= 160 && futurePrimaryOrders <= 165,
  'expected about 25% future Calder Pike releases',
);
assert.ok(
  orders.some((row) => row.order_id === 'SBL-2026-000417'),
  'expected the representative partial-shipment order',
);
assert.ok(
  returns.some((row) => row.return_id === 'RTN-2022-000014'),
  'expected the representative historical return',
);
assert.equal(
  deliveredShipments.length,
  449,
  'expected the fixed delivered history',
);
assert.equal(
  deliveryEvents.size,
  deliveredShipments.length,
  'expected one delivery event per delivered shipment',
);
const createdOnByOrder = new Map(
  orders.map((row) => [row.order_id, row.created_on]),
);
for (const {
  order_id: orderId,
  shipped_on: shippedOn,
  delivered_on: deliveredOn,
} of deliveredShipments) {
  assert.ok(
    createdOnByOrder.has(orderId) &&
      shippedOn &&
      deliveredOn &&
      createdOnByOrder.get(orderId) <= shippedOn &&
      shippedOn <= deliveredOn,
    `invalid shipment timeline for ${orderId}`,
  );
  assert.equal(
    deliveryEvents.get(orderId)?.slice(0, 10),
    deliveredOn,
    `delivery event must agree with shipment completion for ${orderId}`,
  );
}

// COV-E reads these rows as history, so they must be consistent at the as-of
// date: no future events, real shortfalls, no freight for licenses, and no
// in-transit shipment already past its estimate unless marked delayed.
const events = records
  .filter(({ table }) => table === 'order_events')
  .map(({ values }) => values);
const futureEvents = events.filter(
  ({ occurred_at }) => occurred_at.slice(0, 10) > AS_OF_DATE,
);
assert.deepEqual(
  futureEvents.map(({ event_id }) => event_id),
  [],
  'expected every order event on or before the as-of date',
);
for (const order of orders.filter(
  ({ status }) => status === 'partially_shipped',
)) {
  assert.ok(
    orderItems.some(
      (item) =>
        item.order_id === order.order_id &&
        item.shipped_quantity < item.ordered_quantity,
    ),
    `expected a shortfall on partially shipped ${order.order_id}`,
  );
}
const licenseItems = new Set(
  orderItems
    .filter(
      (item) =>
        products.find(({ item_number }) => item_number === item.item_number)
          ?.fulfillment_type === 'license',
    )
    .map(({ order_id, line_number }) => `${order_id}/${line_number}`),
);
const shippedLicenses = records
  .filter(({ table }) => table === 'shipment_items')
  .map(({ values }) => values)
  .filter(({ order_id, line_number }) =>
    licenseItems.has(`${order_id}/${line_number}`),
  );
assert.equal(
  shippedLicenses.length,
  0,
  'expected no license lines in freight shipments',
);
const overdueInTransit = records
  .filter(({ table }) => table === 'shipments')
  .map(({ values }) => values)
  .filter(
    ({ status, estimated_delivery_date }) =>
      status === 'in_transit' && estimated_delivery_date <= AS_OF_DATE,
  );
assert.deepEqual(
  overdueInTransit.map(({ shipment_id }) => shipment_id),
  [],
  'expected in-transit shipments to be due after the as-of date',
);

console.log(
  JSON.stringify(
    {
      orders: orders.length,
      distributors: distributors.length,
      users: users.length,
      credentials: credentials.length,
      customerCounts,
      products: products.length,
      orderItems: orderItems.length,
      futurePrimaryOrders,
      deliveredShipments: deliveredShipments.length,
      asOfDate: AS_OF_DATE,
    },
    null,
    2,
  ),
);
