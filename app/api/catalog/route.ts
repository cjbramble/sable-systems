import { getAuthenticatedUser } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { getCatalog } from '@/db/shop';
import { logServerError } from '@/lib/server-log';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const db = await getDatabase();
    if (!(await getAuthenticatedUser(db, request)))
      return Response.json(
        { error: 'Authentication required.' },
        { status: 401 },
      );
    return Response.json({ products: await getCatalog(db) });
  } catch (error) {
    logServerError('catalog', error);
    return Response.json(
      { error: 'Live inventory is unavailable.' },
      { status: 503 },
    );
  }
}
