import { getAuthenticatedUser, isTrustedMutation } from '@/db/auth';
import { getDatabase } from '@/db/database';
import {
  deleteSupportIncident,
  listSupportIncidents,
  parseIncidentId,
} from '@/db/incidents';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const db = await getDatabase();
    const user = await getAuthenticatedUser(db, request);
    if (!user)
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    return Response.json({ incidents: await listSupportIncidents(db, user) });
  } catch {
    return Response.json(
      { error: 'Support incident history is not available.' },
      { status: 503 },
    );
  }
}

export async function DELETE(request: Request) {
  if (!isTrustedMutation(request))
    return Response.json({ error: 'Cross-origin access denied.' }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'The request was not valid JSON.' }, { status: 400 });
  }
  const incidentId = parseIncidentId(
    body && typeof body === 'object'
      ? (body as Record<string, unknown>).incidentId
      : null,
  );
  if (!incidentId)
    return Response.json({ error: 'Enter a valid incident ID.' }, { status: 400 });

  try {
    const db = await getDatabase();
    const user = await getAuthenticatedUser(db, request);
    if (!user)
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    await deleteSupportIncident(db, user, incidentId);
    return new Response(null, { status: 204 });
  } catch {
    return Response.json(
      { error: 'The support incident could not be deleted.' },
      { status: 503 },
    );
  }
}
