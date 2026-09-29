import {
  clearSessionCookie,
  isTrustedMutation,
  revokeSession,
} from '@/db/auth';
import { getDatabase } from '@/db/database';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isTrustedMutation(request))
    return Response.json(
      { error: 'Cross-origin access denied.' },
      { status: 403 },
    );
  try {
    await revokeSession(await getDatabase(), request);
  } catch {
    // Keep the credential so a retry can revoke the same server session.
    return Response.json(
      { error: 'Sign-out could not be confirmed. Please try again.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(
    { authenticated: false },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': clearSessionCookie(request),
      },
    },
  );
}
