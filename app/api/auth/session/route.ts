import { getAuthenticatedUser } from '@/db/auth';
import { getDatabase } from '@/db/database';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const user = await getAuthenticatedUser(await getDatabase(), request);
    if (!user) {
      return Response.json(
        { authenticated: false },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      { authenticated: true, user },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'The access service is temporarily unavailable.' },
      { status: 503 },
    );
  }
}
