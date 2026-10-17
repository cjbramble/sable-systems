import { getAuthenticatedUser } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { getAccountSummary } from '@/db/account';
import { logServerError } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const db = await getDatabase();
    const user = await getAuthenticatedUser(db, request);
    if (!user)
      return Response.json(
        { error: 'Authentication required.' },
        { status: 401 },
      );
    return Response.json(await getAccountSummary(db, user));
  } catch (error) {
    logServerError('account', error);
    return Response.json(
      { error: 'Wholesale records are not available.' },
      { status: 503 },
    );
  }
}
