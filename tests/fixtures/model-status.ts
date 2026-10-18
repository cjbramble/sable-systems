import { onTestFinished, vi } from 'vitest';

import { GET } from '@/app/api/status/route';
import { createSession, revokeSession } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { MODEL_READINESS_CACHE_MS } from '@/lib/model-readiness.mjs';
import { calderPikeUser } from './users';

const STATUS_URL = 'http://localhost/api/status';
let clockOffset = 0;

export async function signedInStatusRequest() {
  const database = await getDatabase();
  const cookie = await createSession(
    database,
    calderPikeUser.userId,
    new Request(STATUS_URL),
  );
  const request = new Request(STATUS_URL, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  onTestFinished(() => revokeSession(database, request));
  return request;
}

// Each call moves Date past the per-isolate readiness cache, so every check
// reaches the (mocked) provider. Only Date is faked; I/O and timers are real.
export async function uncachedModelStatus(request?: Request) {
  const signedIn = request ?? (await signedInStatusRequest());
  clockOffset += MODEL_READINESS_CACHE_MS + 1;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + clockOffset);
  try {
    return await GET(signedIn);
  } finally {
    vi.useRealTimers();
  }
}
