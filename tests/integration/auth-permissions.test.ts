import { expect } from 'vitest';

import { GET as orders, POST as checkout } from '@/app/api/orders/route';
import { POST as chat } from '@/app/api/chat/route';
import { getAuthenticatedUser } from '@/db/auth';
import { saveSupportExchange } from '@/db/incidents';
import { checkoutCommand, createCheckoutFixture } from '../fixtures/checkout';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

test.for(['account_admin', 'buyer', 'support'] as const)(
  '%s can order for their distributor but cannot access a peer conversation',
  async (role, { database, supportApi }) => {
    const caseId = role.replaceAll('_', '-').toUpperCase();
    const userId = `USR-PERMISSION-${caseId}`;
    const customerPoNumber = `PERMISSION-${caseId}`;
    const incidentId = `INC-PERMISSION-${caseId}`;
    const messageId = `MSG-PERMISSION-${caseId}`;
    expect(
      await database
        .prepare('SELECT user_id FROM users WHERE user_id = ?')
        .bind(userId)
        .first(),
    ).toBeNull();
    await database
      .prepare(`INSERT INTO users
      (user_id, distributor_id, display_name, email, role, status, created_on)
      VALUES (?, ?, 'Permission Test', ?, ?, 'active', '2026-10-16')`)
      .bind(
        userId,
        calderPikeUser.distributorId,
        `${role}@permissions.example`,
        role,
      )
      .run();
    try {
      const user = await loadActiveUserFixture(database, userId);
      const session = await supportApi.session(user);
      expect(
        await getAuthenticatedUser(database, session.request({})),
      ).toMatchObject({ userId, role });
      const request = (path: string, body?: unknown) =>
        new Request(`http://localhost${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: session.request({}).headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const history = await orders(request('/api/orders'));
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        account: { customerId: user.distributorId, userId },
      });
      const { ordersForPO } = await createCheckoutFixture(
        database,
        customerPoNumber,
        ['SBL-RPC-12'],
      );
      const response = await checkout(
        request(
          '/api/orders',
          checkoutCommand(customerPoNumber, {
            expectedSubject: { userId, customerId: user.distributorId },
          }),
        ),
      );
      expect(response.status).toBe(201);
      expect((await ordersForPO()).results).toEqual([
        expect.objectContaining({
          customer_id: user.distributorId,
          placed_by_user_id: userId,
        }),
      ]);

      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      await saveSupportExchange(
        database,
        calderPikeUser,
        incidentId,
        messageId,
        'Help with delivery.',
        'Please provide the shipment reference.',
        0,
      );
      const before = (await supportApi.messages(incidentId)).results;
      const model = supportApi.mockModel('This must not be called.');
      const denied = await chat(
        request('/api/chat', {
          incidentId,
          messageId,
          expectedRevision: 0,
          message: 'Help with delivery.',
        }),
      );
      expect(denied.status).toBe(403);
      expect(model).not.toHaveBeenCalled();
      expect((await supportApi.messages(incidentId)).results).toEqual(before);
    } finally {
      // Remove this user's dependent order before removing its test account.
      // The checkout fixture also restores inventory after every outcome.
      await database
        .prepare(
          'DELETE FROM orders WHERE customer_po_number = ? AND placed_by_user_id = ?',
        )
        .bind(customerPoNumber, userId)
        .run();
      await supportApi.cleanup();
      await database
        .prepare('DELETE FROM users WHERE user_id = ?')
        .bind(userId)
        .run();
    }
  },
);
