import { getAuthenticatedUser, isTrustedMutation } from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  CheckoutError,
  parseCheckoutInput,
  placeChargeAccountOrder,
} from '@/db/shop';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isTrustedMutation(request))
    return Response.json({ error: 'Cross-origin access denied.' }, { status: 403 });
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
    const user = await getAuthenticatedUser(db, request);
    if (!user)
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    return Response.json(await placeChargeAccountOrder(db, input, user), { status: 201 });
  } catch (error) {
    if (error instanceof CheckoutError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: 'The order could not be placed.' }, { status: 500 });
  }
}
