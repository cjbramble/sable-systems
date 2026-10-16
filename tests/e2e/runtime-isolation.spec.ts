import { test, expect } from '@playwright/test';
import { Response } from 'miniflare';
import { createBuiltApp } from '../../tools/runtime/built-app';

test('built app instances have independent disposable databases', async () => {
  const options = {
    localDemo: false,
    apiKey: 'offline-isolation-key',
    model: 'offline-model',
    outboundService: async () =>
      new Response('Outbound calls disabled', { status: 502 }),
  };
  const first = await createBuiltApp(options);
  try {
    await first.ready;
    const database = await first.getD1Database('DB');
    await database.exec(
      "CREATE TABLE isolation_probe (value TEXT); INSERT INTO isolation_probe VALUES ('first');",
    );
    const second = await createBuiltApp(options);
    try {
      await second.ready;
      expect((await first.ready).origin).not.toBe((await second.ready).origin);
      const otherDatabase = await second.getD1Database('DB');
      expect(
        await otherDatabase
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name = 'isolation_probe'",
          )
          .first(),
      ).toBeNull();
      expect(
        await database.prepare('SELECT value FROM isolation_probe').first(),
      ).toEqual({ value: 'first' });
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
  }
});
