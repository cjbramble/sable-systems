import {
  authenticateCredentials,
  createSession,
  isTrustedMutation,
  parseLoginInput,
} from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  consumeRequestQuota,
  loginQuotaKey,
  requestLimitResponse,
} from '@/db/request-limits';
import { isLocalDemoRequest } from '@/lib/local-demo';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isLocalDemoRequest(request))
    return Response.json(
      { error: 'Demo sign-in is available only in the local demo runtime.' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  if (!isTrustedMutation(request))
    return Response.json(
      { error: 'Cross-origin access denied.' },
      { status: 403 },
    );
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'The access request was not valid JSON.' },
      { status: 400 },
    );
  }

  const input = parseLoginInput(body);
  if (!input) {
    return Response.json(
      { error: 'Enter a valid authorized email and access phrase.' },
      { status: 400 },
    );
  }

  try {
    const db = await getDatabase();
    const globalRetry = await consumeRequestQuota(db, 'login:global', 60, 60);
    if (globalRetry) return requestLimitResponse(globalRetry);
    const accountRetry = await consumeRequestQuota(
      db,
      await loginQuotaKey(input.email),
      10,
      60,
    );
    if (accountRetry) return requestLimitResponse(accountRetry);
    const userId = await authenticateCredentials(
      db,
      input.email,
      input.password,
    );
    if (!userId) {
      return Response.json(
        { error: 'The supplied access credentials were not recognized.' },
        { status: 401 },
      );
    }
    const cookie = await createSession(db, userId, request);
    return Response.json(
      { authenticated: true },
      {
        headers: {
          'Cache-Control': 'no-store',
          'Set-Cookie': cookie,
        },
      },
    );
  } catch {
    return Response.json(
      { error: 'The access service is temporarily unavailable.' },
      { status: 503 },
    );
  }
}
