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
    // Clearing the browser credential still signs out this device if storage is unavailable.
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
