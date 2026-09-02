import assert from 'node:assert/strict';

import { AS_OF_DATE, buildSeedStatements } from '../db/seed.ts';

const statements = buildSeedStatements();
const orders = statements.filter((row) =>
  row.sql.startsWith('INSERT INTO orders'),
);
const orderItems = statements.filter((row) =>
  row.sql.startsWith('INSERT INTO order_items'),
);
const products = statements.filter((row) =>
  row.sql.includes('INSERT INTO products'),
);
const distributors = statements.filter((row) =>
  row.sql.startsWith('INSERT INTO distributors'),
);
const users = statements.filter((row) =>
  row.sql.startsWith('INSERT INTO users'),
);
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
    orders.filter((row) => row.params[1] === customerId).length,
  ]),
);
const primaryOrders = orders.filter((row) => row.params[1] === 'WHS-0427');
const futurePrimaryOrders = primaryOrders.filter(
  (row) => String(row.params[5]) > AS_OF_DATE,
).length;

assert.equal(orders.length, 720, 'expected exactly 720 orders');
assert.equal(distributors.length, 4, 'expected four authorized distributors');
assert.equal(users.length, 4, 'expected one user per authorized distributor');
assert.ok(
  orders.every(
    (row) => row.params[2] === expectedUserByCustomer[String(row.params[1])],
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
  orders.some((row) => row.params[0] === 'SBL-2026-000417'),
  'expected the representative partial-shipment order',
);
assert.ok(
  statements.some(
    (row) =>
      row.sql.startsWith('INSERT INTO returns') &&
      row.params[0] === 'RTN-2022-000014',
  ),
  'expected the representative historical return',
);

console.log(
  JSON.stringify(
    {
      orders: orders.length,
      distributors: distributors.length,
      users: users.length,
      customerCounts,
      products: products.length,
      orderItems: orderItems.length,
      futurePrimaryOrders,
      asOfDate: AS_OF_DATE,
    },
    null,
    2,
  ),
);
