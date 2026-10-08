import { describe, expect } from 'vitest';

import { POST } from '@/app/api/orders/route';
import { revokeSession } from '@/db/auth';
import { placeChargeAccountOrder } from '@/db/shop';
import {
  createCheckoutFixture,
  snapshotCheckoutState,
} from '../fixtures/checkout';
import { test } from '../fixtures/support-integration';
import { loadActiveUserFixture } from '../fixtures/users';

const order = {
  requestedShipDate: '2031-01-01',
  shippingRegion: 'Great Lakes District',
  items: [{ itemNumber: 'SBL-RPC-12', quantity: 8 }],
};

describe('checkout account context', () => {
  for (const changed of ['customer', 'user'] as const) {
    test(`rejects a changed ${changed} at the API and business boundary without writes`, async ({
      database,
      supportApi,
      onTestFinished,
    }) => {
      const customerPoNumber = `SUBJECT-MISMATCH-${changed.toUpperCase()}`;
      await createCheckoutFixture(database, customerPoNumber, ['SBL-RPC-12']);
      const user = await loadActiveUserFixture(database, 'USR-MCS-001');
      let reviewedUser = await loadActiveUserFixture(database, 'USR-CPD-001');
      if (changed === 'user') {
        await database
          .prepare(`INSERT INTO users
          (user_id, distributor_id, email, display_name, role, status, created_on, last_login_at)
          VALUES ('USR-MCS-REVIEW', 'WHS-1098', 'review@meridiancivic.example',
          'Review Buyer', 'buyer', 'active', '2026-01-01', NULL)`)
          .run();
        onTestFinished(async () => {
          await database
            .prepare("DELETE FROM users WHERE user_id = 'USR-MCS-REVIEW'")
            .run();
        });
        reviewedUser = await loadActiveUserFixture(database, 'USR-MCS-REVIEW');
      }
      const session = await supportApi.session(user);
      const input = {
        ...order,
        customerPoNumber,
        expectedSubject: {
          // Exercise each comparison independently: a matching user ID must not
          // make an unreviewed distributor acceptable, or vice versa.
          userId: changed === 'customer' ? user.userId : reviewedUser.userId,
          customerId: reviewedUser.distributorId,
        },
      };
      const before = await snapshotCheckoutState(database);
      const response = await POST(
        new Request('http://localhost/api/orders', {
          method: 'POST',
          headers: session.request({}).headers,
          body: JSON.stringify(input),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: 'account_changed',
        error:
          'Your signed-in account changed. Reload and review the order before authorizing it again.',
      });
      expect(await snapshotCheckoutState(database)).toEqual(before);
      await expect(
        placeChargeAccountOrder(database, input, user),
      ).rejects.toMatchObject({
        status: 409,
        code: 'account_changed',
      });
      expect(await snapshotCheckoutState(database)).toEqual(before);
    });
  }

  test('requires the reviewed subject even for an otherwise valid authenticated order', async ({
    database,
    supportApi,
  }) => {
    const customerPoNumber = 'SUBJECT-MISSING';
    await createCheckoutFixture(database, customerPoNumber, ['SBL-RPC-12']);
    const session = await supportApi.session(
      await loadActiveUserFixture(database, 'USR-MCS-001'),
    );
    const before = await snapshotCheckoutState(database);
    const response = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: session.request({}).headers,
        body: JSON.stringify({ ...order, customerPoNumber }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await snapshotCheckoutState(database)).toEqual(before);
  });

  test('accepts a renewed session for the reviewed user and keeps server-owned order identity', async ({
    database,
    supportApi,
  }) => {
    const customerPoNumber = 'SUBJECT-RENEWED';
    const { ordersForPO } = await createCheckoutFixture(
      database,
      customerPoNumber,
      ['SBL-RPC-12'],
    );
    const user = await loadActiveUserFixture(database, 'USR-MCS-001');
    const original = await supportApi.session(user);
    await revokeSession(database, original.request({}));
    const renewed = await supportApi.session(user);
    expect(renewed.request({}).headers.get('Cookie')).not.toBe(
      original.request({}).headers.get('Cookie'),
    );
    const response = await POST(
      new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: renewed.request({}).headers,
        body: JSON.stringify({
          ...order,
          customerPoNumber,
          expectedSubject: { userId: 'USR-MCS-001', customerId: 'WHS-1098' },
          // Extra client ownership fields must never choose the account to charge.
          customerId: 'WHS-0427',
          placedByUserId: 'USR-CPD-001',
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect((await ordersForPO()).results).toEqual([
      expect.objectContaining({
        customer_id: 'WHS-1098',
        placed_by_user_id: 'USR-MCS-001',
        order_total_cents: 544_000,
      }),
    ]);
  });
});
