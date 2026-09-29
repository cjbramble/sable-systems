import { createHash } from 'node:crypto';
import { expect, test } from './fixtures/app';

test.use({ localDemo: false, modelResponses: [[], { scope: 'test' }] });

test('disables published demo credentials and existing sessions without local opt-in', async ({
  page,
  app,
}) => {
  const login = await page.request.post('/api/auth/login', {
    data: {
      email: 'mara.venn@calderpike.example',
      password: 'Sable-WHS-0427!',
    },
  });
  expect(login.status()).toBe(403);
  expect(login.headers()['set-cookie']).toBeUndefined();

  // Account lookup initializes the disposable database; then simulate a valid
  // session copied from a previously enabled local run.
  expect((await page.request.get('/api/account')).status()).toBe(401);
  const token = 'security-test-existing-session';
  const hash = createHash('sha256').update(token).digest('base64url');
  await app.database
    .prepare(`INSERT INTO sessions
    (session_id, token_hash, user_id, created_at, last_seen_at, expires_at)
    VALUES ('security-test-session', ?, 'USR-CPD-001', ?, ?, ?)`)
    .bind(
      hash,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    )
    .run();
  for (const endpoint of [
    '/api/auth/session',
    '/api/orders',
    '/api/incidents',
  ]) {
    const response = await page.request.get(endpoint, {
      headers: { Cookie: `sable_session=${token}` },
    });
    expect(response.status()).toBe(401);
  }
  expect(app.modelRequests).toEqual([]);
});
