import { describe, expect } from 'vitest';

import { POST as chat } from '@/app/api/chat/route';
import { saveSupportExchange } from '@/db/incidents';
import { buildSupportContext } from '@/db/support';
import { test } from '../fixtures/support-integration';
import { calderPikeUser } from '../fixtures/users';

const ask = (content: string) => [{ role: 'user' as const, content }];

async function catalogRecords(database: D1Database, content: string) {
  const context = await buildSupportContext(
    database,
    ask(content),
    calderPikeUser,
  );
  expect(context.kind, content).toBe('records');
  if (context.kind !== 'records') throw new Error(context.message);
  return context.records;
}

function productRecords(records: string, itemNumber: string) {
  const product = records
    .split(/(?=Product: )/)
    .find((part) => part.startsWith(`Product: ${itemNumber} `));
  expect(product, itemNumber).toBeDefined();
  return product!;
}

function modelRecords(model: { mock: { calls: unknown[][] } }, call = 0) {
  const request = model.mock.calls[call][1] as RequestInit;
  const { messages } = JSON.parse(request.body as string) as {
    messages: { content: string }[];
  };
  return (JSON.parse(messages[1].content) as { records: string }).records;
}

describe('support catalog quantities', () => {
  test('uses the complete grouped integer in stock and case-pack calculations', async ({
    database,
  }) => {
    const records = await catalogRecords(
      database,
      'Are 1,000 units of SBL-RPC-12 available?',
    );
    expect(records).toContain(
      'Requested quantity 1000: valid case-pack multiple;',
    );
    expect(records).toContain(
      'Stock shortfall for requested quantity 1000: 688 units (1000 requested; 312 available).',
    );
    expect(records).not.toContain('Requested quantity 0:');
  });

  for (const content of [
    'Compare availability for 8 units of SBL-RPC-12 and 12 units of SBL-SWC-12.',
    'Are 8 units of SBL-RPC-12 and 12 units of SBL-SWC-12 available?',
    'Compare 12 units of SBL-SWC-12 and 8 units of SBL-RPC-12.',
    'Compare 8 units of Redline Power Cell R12 and 12 units of Signal-Weave Active Cable, 12 m.',
    'Compare 12 units of Signal-Weave and 8 units of Redline.',
    'Compare SBL-RPC-12 at 8 units with SBL-SWC-12 at 12 units.',
    'Compare 8 units of Redline Power Cell R12 (SBL-RPC-12) and 12 units of Signal-Weave Active Cable, 12 m (SBL-SWC-12).',
  ]) {
    test(`retains each requested product quantity: ${content}`, async ({
      database,
    }) => {
      const records = await catalogRecords(database, content);
      expect(records.match(/^Product:/gm)).toHaveLength(2);
      const redline = productRecords(records, 'SBL-RPC-12');
      const cable = productRecords(records, 'SBL-SWC-12');
      expect(redline).toContain(
        'Requested quantity 8: valid case-pack multiple;',
      );
      expect(redline).not.toContain('Requested quantity 12:');
      expect(cable).toContain(
        'Requested quantity 12: valid case-pack multiple;',
      );
      expect(cable).not.toContain('Requested quantity 8:');
      expect(records).not.toContain('Ordering restriction:');
    });
  }

  for (const content of [
    'Compare SBL-RPC-12 and SBL-SWC-12 for 24 units each.',
    'Compare both SBL-RPC-12 and SBL-SWC-12 for 24 units.',
    'Compare SBL-RPC-12 and SBL-SWC-12 for 24 units per item.',
  ]) {
    test(`applies an explicitly shared quantity: ${content}`, async ({
      database,
    }) => {
      const records = await catalogRecords(database, content);
      for (const item of ['SBL-RPC-12', 'SBL-SWC-12'])
        expect(productRecords(records, item)).toContain(
          'Requested quantity 24: valid case-pack multiple;',
        );
    });
  }

  test('keeps product model numbers and capacities separate from requested quantities', async ({
    database,
  }) => {
    const records = await catalogRecords(
      database,
      'Compare Nightvault 16 TB Solid-State Array and Signal-Weave Active Cable, 12 m.',
    );
    expect(records.match(/^Product:/gm)).toHaveLength(2);
    expect(records).not.toContain('Requested quantity');
    expect(records).not.toContain('Stock shortfall for requested quantity');
  });

  test('retains the supported six-digit range independently of checkout limits', async ({
    database,
  }) => {
    const records = await catalogRecords(
      database,
      'Are 999,999 units of SBL-RPC-12 available?',
    );
    expect(records).toContain(
      'Requested quantity 999999: not a multiple of case pack 8;',
    );
    expect(records).toContain(
      'Stock shortfall for requested quantity 999999: 999687 units',
    );
  });

  test('keeps quantities separate for physical products and license allocations', async ({
    database,
  }) => {
    const records = await catalogRecords(
      database,
      'Compare 8 units of SBL-RPC-12 and 20 licenses of SBL-RLY-1Y.',
    );
    expect(records.match(/^Product:/gm)).toHaveLength(2);
    expect(records).not.toContain('Palisade');
    expect(productRecords(records, 'SBL-RPC-12')).toContain(
      'Requested quantity 8: valid case-pack multiple;',
    );
    const license = productRecords(records, 'SBL-RLY-1Y');
    expect(license).toContain(
      'Requested quantity 20: valid minimum-block multiple.',
    );
    expect(license).not.toContain('Stock shortfall');
    expect(license).not.toContain('Available to promise:');
  });

  for (const expression of [
    '1.5',
    '0',
    '-8',
    '+8',
    '1,00',
    '1,000,000',
    '8-12',
  ]) {
    test(`clarifies the unsupported complete quantity ${expression}`, async ({
      database,
    }) => {
      const context = await buildSupportContext(
        database,
        ask(`Are ${expression} units of SBL-RPC-12 available?`),
        calderPikeUser,
      );
      expect(context).toMatchObject({ kind: 'clarification' });
    });
  }

  for (const content of [
    'Compare SBL-RPC-12 and SBL-SWC-12 for 24 units total.',
    'Compare 8 units and 12 units of SBL-RPC-12.',
    'Are 24 units available?',
    'Compare 24 units each of SBL-RPC-12, SBL-SWC-12, SBL-CSR-R2, and SBL-RLY-1Y.',
  ]) {
    test(`clarifies a quantity without an unambiguous supported target set: ${content}`, async ({
      database,
    }) => {
      expect(
        await buildSupportContext(database, ask(content), calderPikeUser),
      ).toMatchObject({
        kind: 'clarification',
      });
    });
  }

  test('clarifies an invalid quantity before considering an unknown item', async ({
    database,
  }) => {
    expect(
      await buildSupportContext(
        database,
        ask('Are 1.5 units of SBL-UNKNOWN-999 available?'),
        calderPikeUser,
      ),
    ).toMatchObject({ kind: 'clarification' });
  });

  test('keeps an unknown item from borrowing facts from a named product', async ({
    database,
  }) => {
    const records = await catalogRecords(
      database,
      'Compare 8 units of SBL-RPC-12 and 12 units of SBL-UNKNOWN-999.',
    );
    expect(records).toContain(
      'No catalog item matching SBL-UNKNOWN-999 was found.',
    );
    expect(records).not.toContain('Product:');
  });
});

describe('saved quantity clarification', () => {
  test('saves and replays clarification without quota or inference, then accepts a corrected quantity', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-QUANTITY-CLARIFICATION';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('The requested quantity is available.');
    const quotaKey = `chat:${calderPikeUser.userId}`;
    const quota = { attempts: 30, expires_at: Date.now() + 60_000 };
    await database
      .prepare(`INSERT INTO request_limits (quota_key, attempts, expires_at)
        VALUES (?, ?, ?) ON CONFLICT(quota_key) DO UPDATE SET attempts = excluded.attempts,
        expires_at = excluded.expires_at`)
      .bind(quotaKey, quota.attempts, quota.expires_at)
      .run();
    const command = {
      incidentId,
      messageId: 'MSG-QUANTITY-CLARIFICATION',
      expectedRevision: 0,
      message: 'Are 1.5 units of SBL-RPC-12 available?',
    };
    const first = await chat(session.request(command));
    expect(first.status).toBe(200);
    const payload = (await first.json()) as {
      message: string;
      revision: number;
    };
    expect(payload.message).toMatch(/quantity|units/i);
    expect(model).not.toHaveBeenCalled();
    const replay = await chat(session.request(command));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(payload);
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(2);
    expect(
      await database
        .prepare(
          'SELECT attempts, expires_at FROM request_limits WHERE quota_key = ?',
        )
        .bind(quotaKey)
        .first(),
    ).toEqual(quota);
    expect(model).not.toHaveBeenCalled();

    await database
      .prepare('DELETE FROM request_limits WHERE quota_key = ?')
      .bind(quotaKey)
      .run();
    const corrected = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-QUANTITY-CORRECTED',
        expectedRevision: payload.revision,
        message: 'Are 24 units of it available?',
      }),
    );
    expect(corrected.status).toBe(200);
    expect(model).toHaveBeenCalledOnce();
    expect(modelRecords(model)).toContain('Product: SBL-RPC-12 ');
    expect(modelRecords(model)).toContain(
      'Requested quantity 24: valid case-pack multiple;',
    );
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(4);
  });

  test('clarifies an invalid compound quantity without sending any records to the model', async ({
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-QUANTITY-COMPOUND';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('The order was delivered.');
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-QUANTITY-COMPOUND',
        expectedRevision: 0,
        message:
          'Show order SBL-2022-000118 and check 1.5 units of SBL-RPC-12.',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: expect.stringMatching(/quantity|units/i),
    });
    expect(model).not.toHaveBeenCalled();
    expect((await fixture.messageContents(incidentId)).results).toHaveLength(2);
  });

  test('applies a shared follow-up quantity to both saved product targets', async ({
    database,
    supportApi: fixture,
  }) => {
    const incidentId = 'INC-QUANTITY-SAVED-BOTH';
    await fixture.trackTemporaryIncident(incidentId, calderPikeUser);
    await saveSupportExchange(
      database,
      calderPikeUser,
      incidentId,
      'MSG-QUANTITY-SAVED-FIRST',
      'Compare SBL-RPC-12 and SBL-SWC-12.',
      'Both products are available.',
      0,
    );
    const session = await fixture.session(calderPikeUser);
    const model = fixture.mockModel('Both requested quantities are available.');
    const response = await chat(
      session.request({
        incidentId,
        messageId: 'MSG-QUANTITY-SAVED-BOTH',
        expectedRevision: 1,
        message: 'Compare both for 24 units.',
      }),
    );
    expect(response.status).toBe(200);
    expect(model).toHaveBeenCalledOnce();
    const records = modelRecords(model);
    for (const item of ['SBL-RPC-12', 'SBL-SWC-12'])
      expect(productRecords(records, item)).toContain(
        'Requested quantity 24: valid case-pack multiple;',
      );
  });
});
