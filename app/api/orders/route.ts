import { getDatabase } from '@/db/database';
import {
  CheckoutError,
  parseCheckoutInput,
  placeChargeAccountOrder,
} from '@/db/shop';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'The request was not valid JSON.' }, { status: 400 });
  }
  const input = parseCheckoutInput(body);
  if (!input) {
    return Response.json({ error: 'Enter a valid PO, ship date, destination, and order lines.' }, { status: 400 });
  }
  try {
    const db = await getDatabase();
    return Response.json(await placeChargeAccountOrder(db, input), { status: 201 });
  } catch (error) {
    if (error instanceof CheckoutError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: 'The order could not be placed.' }, { status: 500 });
  }
}
