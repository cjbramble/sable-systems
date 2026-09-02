import { getDatabase } from '@/db/database';
import { getCatalog } from '@/db/shop';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = await getDatabase();
    return Response.json({ products: await getCatalog(db) });
  } catch {
    return Response.json({ error: 'Live inventory is unavailable.' }, { status: 503 });
  }
}
