import {
  authenticateCredentials,
  createSession,
  isTrustedMutation,
  parseLoginInput,
} from '@/db/auth';
import { getDatabase } from '@/db/database';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
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
