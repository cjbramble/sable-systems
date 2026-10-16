import type { AuthenticatedUser } from './auth';
import { getAccountSummary } from './account';
import { listSupportIncidents } from './incidents';
import type {
  AccountLookupOutcome,
  SummaryLookupOutcome,
  IncidentHistoryOutcome,
  SupportAccountCharge,
} from '@/lib/support-account-outcomes';

export async function lookupSupportAccount(
  db: D1Database,
  user: AuthenticatedUser,
): Promise<AccountLookupOutcome> {
  const summary = await getAccountSummary(db, user);
  const charges = (
    await db
      .prepare(`SELECT c.order_id, c.status, c.amount_cents, c.currency,
        c.authorization_code, c.authorized_at
        FROM account_charges c
        JOIN orders o ON o.order_id = c.order_id
        WHERE o.customer_id = ?
        ORDER BY c.authorized_at DESC LIMIT 8`)
      .bind(user.distributorId)
      .all<SupportAccountCharge>()
  ).results;
  return {
    kind: 'account',
    outcome: 'found',
    facts: { summary, charges },
    verifiedReferences: charges.flatMap((charge) => [
      { namespace: 'order_id', identifier: charge.order_id },
      {
        namespace: 'authorization_code',
        identifier: charge.authorization_code,
      },
    ]),
  };
}

export async function lookupSupportSummary(
  db: D1Database,
  user: AuthenticatedUser,
): Promise<SummaryLookupOutcome> {
  return {
    kind: 'summary',
    outcome: 'found',
    facts: { summary: await getAccountSummary(db, user) },
    verifiedReferences: [],
  };
}

export async function lookupSupportIncidentHistory(
  db: D1Database,
  user: AuthenticatedUser,
): Promise<IncidentHistoryOutcome> {
  const incidents = (await listSupportIncidents(db, user))
    .slice(0, 8)
    .map(({ id, title, updatedAt, messages }) => ({
      id,
      title,
      updatedAt,
      messageCount: messages.length,
    }));
  return {
    kind: 'incidents',
    outcome: 'found',
    scope: { userId: user.userId, userDisplayName: user.userDisplayName },
    facts: { incidents },
    verifiedReferences: incidents.map(({ id }) => ({
      namespace: 'incident_id',
      identifier: id,
    })),
  };
}
