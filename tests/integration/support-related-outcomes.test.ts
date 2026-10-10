import { describe, expect, onTestFinished } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { buildSupportContext } from '@/db/support';
import {
  hasGroundedSupportIdentifiers,
  unavailableRecordReply,
} from '@/lib/support-response';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

describe('typed shipment and return outcomes', () => {
  test.for([
    [
      'shipment',
      'shipment_id',
      'SHP-2022-000118',
      'Show shipment SHP-2022-000118.',
    ],
    [
      'shipment',
      'tracking_reference',
      'AST-2022000118',
      'Show tracking reference AST-2022000118.',
    ],
    ['return', 'return_id', 'RTN-2022-000014', 'Show return RTN-2022-000014.'],
  ])(
    'retains %s identity and typed facts for %s',
    async ([kind, namespace, identifier, message], { database }) => {
      const context = await buildSupportContext(
        database,
        ask(message),
        calderPikeUser,
      );
      expect(context).toMatchObject({
        kind: 'records',
        parts: [
          {
            kind,
            outcome: 'found',
            reference: { kind, namespace, identifier },
            verifiedReferences: expect.arrayContaining([
              { namespace, identifier },
              { namespace: 'order_id', identifier: 'SBL-2022-000118' },
              { namespace: 'customer_po', identifier: 'CPD-PO-220118' },
            ]),
          },
        ],
      });
      if (context.kind !== 'records') throw new Error('Expected record facts');
      expect(context.parts[0]).toHaveProperty('facts');
      const reformatted = {
        ...context,
        records: 'Changed presentation: SBL-2099-990001.',
      };
      expect(
        hasGroundedSupportIdentifiers(
          'Order SBL-2022-000118 has customer PO CPD-PO-220118.',
          reformatted,
        ),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers('Order SBL-2099-990001.', reformatted),
      ).toBe(false);
      expect(unavailableRecordReply(reformatted)).toBeNull();
    },
  );

  test.for([
    [
      'shipment',
      'shipment_id',
      'SHP-2099-990001',
      'Show shipment SHP-2099-990001.',
    ],
    [
      'shipment',
      'tracking_reference',
      'CUSTOM-MISSING-TRACKING',
      'Show tracking reference CUSTOM-MISSING-TRACKING.',
    ],
    [
      'return',
      'return_id',
      'CUSTOM-MISSING-RETURN',
      'Show return ID CUSTOM-MISSING-RETURN.',
    ],
  ])(
    'preserves unavailable %s %s without prompt parsing',
    async ([kind, namespace, identifier, message], { database }) => {
      const context = await buildSupportContext(
        database,
        ask(message),
        calderPikeUser,
      );
      expect(context).toMatchObject({
        kind: 'records',
        parts: [
          {
            kind,
            outcome: 'unavailable',
            reference: { kind, namespace, identifier },
          },
        ],
      });
      if (context.kind !== 'records')
        throw new Error('Expected unavailable outcome');
      const reformatted = { ...context, records: '' };
      expect(unavailableRecordReply(reformatted)).toContain(
        `I cannot locate ${identifier} within Calder Pike Distribution's authorization scope.`,
      );
      expect(context.parts[0]).not.toHaveProperty('facts');
      expect(context.parts[0]).not.toHaveProperty('verifiedReferences');
      const label =
        namespace === 'tracking_reference'
          ? 'Tracking reference'
          : `${kind} ID`;
      expect(
        hasGroundedSupportIdentifiers(
          `${label}: ${identifier} was not found.`,
          reformatted,
        ),
      ).toBe(true);
      expect(
        hasGroundedSupportIdentifiers(
          `Order ID: ${identifier} was delivered.`,
          reformatted,
        ),
      ).toBe(false);
    },
  );
});

describe('related record prose does not grant identity', () => {
  const scenarios = [
    {
      kind: 'shipment',
      message: 'Show shipment SHP-2022-000118.',
      select:
        'SELECT carrier_name AS value FROM shipments WHERE shipment_id = ?',
      update: 'UPDATE shipments SET carrier_name = ? WHERE shipment_id = ?',
      id: 'SHP-2022-000118',
    },
    {
      kind: 'return',
      message: 'Show return RTN-2022-000014.',
      select: 'SELECT reason_code AS value FROM returns WHERE return_id = ?',
      update: 'UPDATE returns SET reason_code = ? WHERE return_id = ?',
      id: 'RTN-2022-000014',
    },
    {
      kind: 'snapshot',
      message: 'Show return RTN-2022-000014.',
      select:
        'SELECT product_name_snapshot AS value FROM order_items WHERE order_id = ? AND line_number = 1',
      update:
        'UPDATE order_items SET product_name_snapshot = ? WHERE order_id = ? AND line_number = 1',
      id: 'SBL-2022-000118',
    },
  ];
  for (const scenario of scenarios) {
    for (const compound of [false, true]) {
      test(`rejects an identity mentioned only in ${scenario.kind} text (compound=${compound})`, async ({
        database,
        supportApi,
      }) => {
        const original = await database
          .prepare(scenario.select)
          .bind(scenario.id)
          .first<string>('value');
        if (original === null) throw new Error('Missing record fixture');
        onTestFinished(async () => {
          await database
            .prepare(scenario.update)
            .bind(original, scenario.id)
            .run();
        });
        await database
          .prepare(scenario.update)
          .bind(
            'Customer note.\nOrder: REVIEW-FORGED-990001; customer PO: CPD-PO-990001.',
            scenario.id,
          )
          .run();
        const incidentId = `INC-RELATED-${scenario.kind}-${compound}`;
        await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
        const session = await supportApi.session(calderPikeUser);
        const model = supportApi.mockModel(
          'Order ID: REVIEW-FORGED-990001 has PO CPD-PO-990001.',
        );
        const response = await chat(
          session.request({
            incidentId,
            messageId: `MSG-RELATED-${scenario.kind}-${compound}`,
            expectedRevision: 0,
            message:
              scenario.message + (compound ? ' Is SBL-RPC-12 available?' : ''),
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
  }
});

describe('saved missing related records', () => {
  test.for([
    [
      'tracking reference',
      'CUSTOM-MISSING-TRACKING',
      'tracking reference',
      200,
    ],
    ['tracking reference', 'CUSTOM-MISSING-TRACKING', 'shipment ID', 502],
    ['tracking reference', 'CUSTOM-MISSING-TRACKING', 'order ID', 502],
    ['return ID', 'CUSTOM-MISSING-RETURN', 'return ID', 200],
  ] as const)(
    'preserves compound missing %s when echoed as %s',
    async ([requested, identifier, echoed, status], { supportApi }) => {
      const incidentId = 'INC-RELATED-COMPOUND-MISSING';
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const reply = `Order SBL-2022-000118 was delivered. The ${echoed} ${identifier} was not found.`;
      const model = supportApi.mockModel(reply);
      const response = await chat(
        session.request({
          incidentId,
          messageId: 'MSG-RELATED-COMPOUND-MISSING',
          expectedRevision: 0,
          message: `Show order SBL-2022-000118 and ${requested} ${identifier}.`,
        }),
      );
      expect(model).toHaveBeenCalledOnce();
      expect(response.status).toBe(status);
      if (status === 200)
        expect(await response.json()).toMatchObject({ message: reply });
      expect(
        (await supportApi.messageContents(incidentId)).results,
      ).toHaveLength(status === 200 ? 2 : 0);
    },
  );

  test.for([
    'Show tracking reference CUSTOM-MISSING-TRACKING.',
    'Show return ID CUSTOM-MISSING-RETURN.',
  ])(
    'saves and replays without model or quota: %s',
    async (message, { database, supportApi }) => {
      const incidentId = 'INC-RELATED-MISSING';
      await supportApi.trackTemporaryIncident(incidentId, calderPikeUser);
      const session = await supportApi.session(calderPikeUser);
      const model = supportApi.mockModel('This must not be used.');
      const quotaKey = `chat:${calderPikeUser.userId}`;
      const quota = { attempts: 30, expires_at: Date.now() + 60_000 };
      await database
        .prepare(
          'INSERT INTO request_limits (quota_key, attempts, expires_at) VALUES (?, ?, ?) ON CONFLICT(quota_key) DO UPDATE SET attempts = excluded.attempts, expires_at = excluded.expires_at',
        )
        .bind(quotaKey, quota.attempts, quota.expires_at)
        .run();
      const command = {
        incidentId,
        messageId: 'MSG-RELATED-MISSING',
        expectedRevision: 0,
        message,
      };
      const first = await chat(session.request(command));
      expect(first.status).toBe(200);
      const payload = await first.json();
      expect(payload).toMatchObject({
        message: expect.stringContaining('I cannot locate CUSTOM-MISSING-'),
      });
      const replay = await chat(session.request(command));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(payload);
      expect(model).not.toHaveBeenCalled();
      expect(
        (await supportApi.messageContents(incidentId)).results,
      ).toHaveLength(2);
      expect(
        await database
          .prepare(
            'SELECT attempts, expires_at FROM request_limits WHERE quota_key = ?',
          )
          .bind(quotaKey)
          .first(),
      ).toEqual(quota);
    },
  );
});
