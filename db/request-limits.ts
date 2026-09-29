// D1 serializes the cleanup and increment together, so quotas survive worker
// restarts and simultaneous requests cannot each claim the last available slot.
export async function consumeRequestQuota(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
) {
  const results = await db.batch<{ attempts: number; expires_at: number }>([
    db.prepare('DELETE FROM request_limits WHERE expires_at <= ?').bind(now),
    db
      .prepare(`INSERT INTO request_limits (quota_key, attempts, expires_at)
        VALUES (?, 1, ?)
        ON CONFLICT(quota_key) DO UPDATE SET attempts = MIN(attempts + 1, ?)
        RETURNING attempts, expires_at`)
      .bind(key, now + windowSeconds * 1000, limit + 1),
  ]);
  const quota = results[1].results[0];
  if (!quota) throw new Error('Request quota could not be checked.');
  return quota.attempts <= limit
    ? 0
    : Math.max(1, Math.ceil((quota.expires_at - now) / 1000));
}

export async function loginQuotaKey(email: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(email.toLowerCase()),
  );
  return `login:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function requestLimitResponse(retryAfter: number) {
  return Response.json(
    { error: 'Too many requests. Please wait and try again.' },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
        'Cache-Control': 'no-store',
      },
    },
  );
}
