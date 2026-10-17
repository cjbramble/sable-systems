import { describe, expect, vi } from 'vitest';

import { POST as login } from '@/app/api/auth/login/route';
import { DELETE as deleteIncident } from '@/app/api/incidents/route';
import { POST as placeOrder } from '@/app/api/orders/route';
import { test } from '../fixtures/support-integration';

// Pad a valid JSON body with trailing whitespace to an exact byte size.
function sizedRequest(
  url: string,
  method: string,
  payload: unknown,
  size: number,
) {
  const body = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > size) throw new Error('Payload exceeds the requested size');
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body + ' '.repeat(size - bytes),
  });
}

const routes = [
  {
    name: 'sign-in',
    limit: 4 * 1024,
    // An unknown account: the limit check must not depend on valid credentials.
    send: (size: number) =>
      login(
        sizedRequest(
          'http://localhost/api/auth/login',
          'POST',
          {
            email: 'body-limit@calderpike.example',
            password: 'wrong-password-phrase',
          },
          size,
        ),
      ),
    accepted: 401,
    tooLarge: 'The access request was too large.',
  },
  {
    name: 'checkout',
    limit: 16 * 1024,
    send: (size: number) =>
      placeOrder(sizedRequest('http://localhost/api/orders', 'POST', {}, size)),
    accepted: 401,
    tooLarge: 'The order request was too large.',
  },
  {
    name: 'incident deletion',
    limit: 1024,
    send: (size: number) =>
      deleteIncident(
        sizedRequest(
          'http://localhost/api/incidents',
          'DELETE',
          { incidentId: 'INC-BODY-LIMIT-0001' },
          size,
        ),
      ),
    accepted: 401,
    tooLarge: 'The request was too large.',
  },
];

describe('JSON request body limits', () => {
  for (const route of routes)
    test(`${route.name} reads exactly ${route.limit} bytes and rejects larger bodies before database work`, async ({
      database,
      onTestFinished,
    }) => {
      onTestFinished(async () => {
        await database.prepare('DELETE FROM request_limits').run();
      });
      expect((await route.send(route.limit)).status).toBe(route.accepted);

      const prepare = vi.spyOn(database, 'prepare');
      try {
        const rejected = await route.send(route.limit + 1);
        expect(rejected.status).toBe(413);
        expect(await rejected.json()).toEqual({ error: route.tooLarge });
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
    });
});
