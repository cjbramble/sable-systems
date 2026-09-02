import { getDatabase } from '@/db/database';
import { getAccountSummary } from '@/db/support';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDatabase();
    return Response.json(await getAccountSummary(db));
  } catch {
    return Response.json(
      { error: 'Wholesale records are not available.' },
      { status: 503 },
    );
  }
}
