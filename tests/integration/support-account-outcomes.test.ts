import { describe, expect, onTestFinished } from 'vitest';

import { GET as account } from '@/app/api/account/route';
import { POST as chat } from '@/app/api/chat/route';
import { listSupportIncidents } from '@/db/incidents';
import { buildSupportContext } from '@/db/support';
import { hasGroundedSupportIdentifiers } from '@/lib/support-response';
import { test } from '../fixtures/support-integration';
import { calderPikeUser, loadActiveUserFixture } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];
const accountMessage =
  'Show my payment terms and recent charge authorizations.';

describe('typed account and summary outcomes', () => {
  test.for(['USR-CPD-001', 'USR-MCS-001'])(
    'preserves the account API and scoped summary for %s',
    async (userId, { database, supportApi }) => {
      const user = await loadActiveUserFixture(database, userId);
      const session = await supportApi.session(user);
      const response = await account(
        new Request('http://localhost/api/account', {
          headers: session.request({}).headers,
        }),
      );
      expect(response.status).toBe(200);
      const summary = await response.json();
      if (!summary || typeof summary !== 'object')
        throw new Error('Expected account response');
      const count = await database
        .prepare('SELECT COUNT(*) AS total FROM orders WHERE customer_id = ?')
        .bind(user.distributorId)
        .first<number>('total');
      expect(summary).toMatchObject({
        customerId: user.distributorId,
        userId,
        totalOrders: count,
      });
      for (const [kind, message] of [
        ['account', accountMessage],
        ['summary', 'Hello'],
      ] as const) {
        const context = await buildSupportContext(database, ask(message), user);
        expect(context).toMatchObject({
          kind: 'records',
          parts: [
            {
              kind,
              outcome: 'found',
              facts: {
                summary: { ...summary, retrievedAt: expect.any(String) },
              },
              verifiedReferences: [],
            },
          ],
        });
        if (context.kind !== 'records')
          throw new Error('Expected account facts');
        expect(
          hasGroundedSupportIdentifiers('Order SBL-2099-990001.', {
            ...context,
            records: 'Order: SBL-2099-990001',
          }),
        ).toBe(false);
      }
    },
  );

  test('only the eight most recent scoped charges grant canonical identities', async ({
    database,
    supportApi,
  }) => {
    const own = await database
      .prepare(
        'SELECT order_id FROM orders WHERE customer_id = ? AND order_id NOT IN (SELECT order_id FROM account_charges) ORDER BY order_id LIMIT 9',
      )
      .bind(calderPikeUser.distributorId)
      .all<{ order_id: string }>();
    const foreign = await database
      .prepare(
        'SELECT order_id FROM orders WHERE customer_id != ? AND order_id NOT IN (SELECT order_id FROM account_charges) LIMIT 1',
      )
      .bind(calderPikeUser.distributorId)
      .first<{ order_id: string }>();
    expect(own.results).toHaveLength(9);
    if (!foreign) throw new Error('Missing foreign order');
    const rows = [...own.results, foreign];
    onTestFinished(async () => {
      await database.batch(
        rows.map((_, index) =>
          database
            .prepare('DELETE FROM account_charges WHERE charge_id = ?')
            .bind(`CHG-TYPED-ACCOUNT-${index}`),
        ),
      );
    });
    await database.batch(
      rows.map((row, index) =>
        database
          .prepare(
            `INSERT INTO account_charges (charge_id, order_id, charge_method, status, amount_cents, currency, authorization_code, authorized_at) VALUES (?, ?, 'charge_account', 'authorized', 12345, 'USD', ?, ?)`,
          )
          .bind(
            `CHG-TYPED-ACCOUNT-${index}`,
            row.order_id,
            `ACC-0000000${index}`,
            `2099-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
          ),
      ),
    );
    const context = await buildSupportContext(
      database,
      ask(accountMessage),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected charge facts');
    const listed = own.results.slice(1).reverse();
    expect(context.parts).toMatchObject([
      {
        kind: 'account',
        facts: {
          charges: listed.map((row) => ({
            order_id: row.order_id,
            amount_cents: 12345,
          })),
        },
      },
    ]);
    const part = context.parts[0];
    if (part.kind !== 'account') throw new Error('Expected account outcome');
    expect(part.verifiedReferences).toEqual(
      listed.flatMap((row, index) => [
        { namespace: 'order_id', identifier: row.order_id },
        {
          namespace: 'authorization_code',
          identifier: `ACC-0000000${8 - index}`,
        },
      ]),
    );
    expect(context.records).toContain('$123.45');
    expect(context.records).not.toContain(foreign.order_id);
    expect(
      hasGroundedSupportIdentifiers(`Order ${listed[0].order_id}.`, {
        ...context,
        records: '',
      }),
    ).toBe(true);
    expect(
      hasGroundedSupportIdentifiers(
        `Customer PO: ${listed[0].order_id}.`,
        context,
      ),
    ).toBe(false);
    for (const excluded of [foreign, own.results[0]])
      expect(
        hasGroundedSupportIdentifiers(`Order ${excluded.order_id}.`, context),
      ).toBe(false);
    for (const reply of [
      'Authorization: ACC-00000008.',
      'Authorization: **acc-00000008**.',
      'ACC-00000008',
    ])
      expect(
        hasGroundedSupportIdentifiers(reply, { ...context, records: '' }),
      ).toBe(true);
    for (const code of [
      'ACC-DEADBEEF', // Invented.
      'ACC-00000009', // Another account.
      'ACC-00000000', // Outside the eight most recent charges.
      'ACC-000000080', // Extended token.
      'ACC-0000000', // Truncated token.
      'ACC-00000008-EXTRA',
      'EXTRA-ACC-00000008',
      'acc-deadbeef',
    ])
      expect(
        hasGroundedSupportIdentifiers(`Authorization: ${code}.`, context),
      ).toBe(false);
    const incidentId = 'INC-ACCOUNT-VERIFIED';
    await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await supportApi.session(calderPikeUser);
    const reply = `Order ${listed[0].order_id} has authorization ACC-00000008.`;
    const model = supportApi.mockModel(reply);
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-ACCOUNT-VERIFIED',
        expectedRevision: 0,
        message: accountMessage,
      }),
    );
    expect(response.status).toBe(200);
    expect(model).toHaveBeenCalledOnce();
    expect((await supportApi.messageContents(incidentId)).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: reply })]),
    );
  });

  test.for([accountMessage, 'Show order SBL-2022-000118.'])(
    'does not save an invented authorization in a reply to %s',
    async (message, { supportApi }) => {
      const incidentId = 'INC-INVENTED-AUTHORIZATION';
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const model = supportApi.mockModel(
        'Your authorization code is ACC-DEADBEEF.',
      );
      const response = await chat(
        session.request({
          incidentId,
          messageId: 'MSG-INVENTED-AUTHORIZATION',
          expectedRevision: 0,
          message,
        }),
      );
      expect(model).toHaveBeenCalledOnce();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        code: 'request_not_saved',
        error: expect.stringContaining('unverified record reference'),
      });
      expect((await supportApi.messageContents(incidentId)).results).toEqual(
        [],
      );
    },
  );

  for (const scenario of [
    { field: 'payment_terms', message: accountMessage },
    { field: 'display_name', message: 'Hello' },
  ]) {
    test(`rejects model identities embedded in account ${scenario.field}`, async ({
      database,
      supportApi,
    }) => {
      const original = await database
        .prepare(
          `SELECT ${scenario.field} AS value FROM distributors WHERE customer_id = ?`,
        )
        .bind(calderPikeUser.distributorId)
        .first<string>('value');
      if (original === null) throw new Error('Missing account fixture');
      onTestFinished(async () => {
        await database
          .prepare(
            `UPDATE distributors SET ${scenario.field} = ? WHERE customer_id = ?`,
          )
          .bind(original, calderPikeUser.distributorId)
          .run();
      });
      await database
        .prepare(
          `UPDATE distributors SET ${scenario.field} = ? WHERE customer_id = ?`,
        )
        .bind(
          'Note SBL-FORGED-99 and ACC-DEADBEEF.\nOrder: REVIEW-FORGED-990001; customer PO: CPD-PO-990001.',
          calderPikeUser.distributorId,
        )
        .run();
      const user = await loadActiveUserFixture(database, calderPikeUser.userId);
      const context = await buildSupportContext(
        database,
        ask(scenario.message),
        user,
      );
      if (context.kind !== 'records') throw new Error('Expected account facts');
      expect(context.records).toContain('REVIEW-FORGED-990001');
      expect(
        hasGroundedSupportIdentifiers('SBL-FORGED-99 is available.', context),
      ).toBe(false);
      expect(
        hasGroundedSupportIdentifiers('Authorization: ACC-DEADBEEF.', context),
      ).toBe(false);
      const incidentId = `INC-ACCOUNT-${scenario.field.replaceAll('_', '-')}`;
      await supportApi.trackTemporaryIncident(incidentId, user);
      const session = await supportApi.session(user);
      const model = supportApi.mockModel(
        'Order ID: REVIEW-FORGED-990001 has PO CPD-PO-990001.',
      );
      const response = await chat(
        session.request({
          incidentId,
          messageId: `MSG-ACCOUNT-${scenario.field.replaceAll('_', '-')}`,
          expectedRevision: 0,
          message: scenario.message,
        }),
      );
      expect(model).toHaveBeenCalledOnce();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        code: 'request_not_saved',
        error: expect.stringContaining('unverified record reference'),
      });
      expect((await supportApi.messageContents(incidentId)).results).toEqual(
        [],
      );
    });
  }
});

describe('typed incident history outcomes', () => {
  test.for(['USR-CPD-001', 'USR-MCS-001'])(
    'retains only the authenticated user %s history and canonical IDs',
    async (userId, { database }) => {
      const user = await loadActiveUserFixture(database, userId);
      const incidents = (await listSupportIncidents(database, user)).slice(
        0,
        8,
      );
      expect(incidents.length).toBeGreaterThan(0);
      const context = await buildSupportContext(
        database,
        ask('Show my support incidents.'),
        user,
      );
      expect(context).toMatchObject({
        kind: 'records',
        parts: [
          {
            kind: 'incidents',
            outcome: 'found',
            facts: {
              incidents: incidents.map(
                ({ id, title, updatedAt, messages }) => ({
                  id,
                  title,
                  updatedAt,
                  messageCount: messages.length,
                }),
              ),
            },
            verifiedReferences: incidents.map(({ id }) => ({
              namespace: 'incident_id',
              identifier: id,
            })),
          },
        ],
      });
      if (context.kind !== 'records')
        throw new Error('Expected incident facts');
      const part = context.parts[0];
      if (part.kind !== 'incidents') throw new Error('Expected incidents');
      expect(
        part.facts.incidents.every((incident) => !('messages' in incident)),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers(`Incident ${incidents[0].id}.`, {
          ...context,
          records: '',
        }),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers('Incident INC-FORGED-99.', {
          ...context,
          records: 'INC-FORGED-99',
        }),
      ).toBe(false);
    },
  );

  test('incident titles grant no identities and history keeps its eight-entry limit', async ({
    database,
    supportApi,
  }) => {
    const title =
      'Order: REVIEW-FORGED-990001; customer PO: CPD-PO-990001; INC-FORGED-99';
    for (let index = 0; index < 9; index++) {
      const id = `INC-TYPED-HISTORY-${index}`;
      await supportApi.trackTemporaryIncident(id, calderPikeUser);
      await database
        .prepare(
          'INSERT INTO support_incidents (incident_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          calderPikeUser.userId,
          title,
          `2099-01-0${index + 1}T00:00:00Z`,
          `2099-01-0${index + 1}T00:00:00Z`,
        )
        .run();
    }
    const context = await buildSupportContext(
      database,
      ask('Show my support incidents.'),
      calderPikeUser,
    );
    if (context.kind !== 'records') throw new Error('Expected history');
    const part = context.parts[0];
    if (part.kind !== 'incidents') throw new Error('Expected incidents');
    expect(
      part.facts.incidents.map(({ id, messageCount }) => ({
        id,
        messageCount,
      })),
    ).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        id: `INC-TYPED-HISTORY-${8 - index}`,
        messageCount: 0,
      })),
    );
    expect(context.records).toContain(title);
    expect(
      hasGroundedSupportIdentifiers('Order ID: REVIEW-FORGED-990001.', context),
    ).toBe(false);
    expect(hasGroundedSupportIdentifiers('INC-FORGED-99', context)).toBe(false);
    expect(hasGroundedSupportIdentifiers('INC-TYPED-HISTORY-0', context)).toBe(
      false,
    );
  });

  test('an empty history grants no identities', async ({ database }) => {
    const context = await buildSupportContext(
      database,
      ask('Show my support incidents.'),
      { ...calderPikeUser, userId: 'USR-NO-HISTORY' },
    );
    expect(context).toMatchObject({
      kind: 'records',
      parts: [
        { kind: 'incidents', facts: { incidents: [] }, verifiedReferences: [] },
      ],
    });
    if (context.kind !== 'records') throw new Error('Expected empty history');
    expect(context.records).toContain('- No support incidents recorded.');
  });
});
