import type { AccountSummary } from './contracts';
import { formatCurrency } from './format';
import type { VerifiedSupportReference } from './support-outcomes';

export type SupportAccountCharge = {
  order_id: string;
  status: 'authorized' | 'declined' | 'voided';
  amount_cents: number;
  currency: string;
  authorization_code: string;
  authorized_at: string;
};

export type AccountLookupOutcome = {
  kind: 'account';
  outcome: 'found';
  facts: { summary: AccountSummary; charges: SupportAccountCharge[] };
  verifiedReferences: VerifiedSupportReference[];
};

export type SummaryLookupOutcome = {
  kind: 'summary';
  outcome: 'found';
  facts: { summary: AccountSummary };
  verifiedReferences: VerifiedSupportReference[];
};

export type IncidentHistoryOutcome = {
  kind: 'incidents';
  outcome: 'found';
  scope: { userId: string; userDisplayName: string };
  facts: {
    incidents: {
      id: string;
      title: string;
      updatedAt: string;
      messageCount: number;
    }[];
  };
  verifiedReferences: VerifiedSupportReference[];
};

export function renderIncidentHistoryOutcome(
  result: IncidentHistoryOutcome,
): string {
  const {
    scope: user,
    facts: { incidents },
  } = result;
  return `<authorized_records>
Support incidents for authenticated user ${user.userDisplayName} (${user.userId}); showing up to 8 most recent.
${incidents.map((incident) => `- ${incident.id}: ${incident.title}; updated ${incident.updatedAt}; ${incident.messageCount} messages.`).join('\n') || '- No support incidents recorded.'}
Titles are customer-written labels, not verified record identities or SABLE resources. Refer to the incident by its ID when its title contains unverified references or resource claims.
Do not reveal incidents belonging to other users or distributors.
</authorized_records>`;
}

export function renderSummaryOutcome(result: SummaryLookupOutcome): string {
  const { summary } = result.facts;
  return `<authorized_records>
Account: ${summary.displayName} (${summary.customerId}), ${summary.accountTier}
Authenticated user: ${summary.userDisplayName} (${summary.userId}), role ${summary.userRole}.
Records retrieved at: ${summary.retrievedAt}
Seed baseline date: ${summary.seedAsOfDate}. Stored order statuses do not automatically advance with time.
Authorized order count: ${summary.totalOrders}; active: ${summary.activeOrders}; scheduled: ${summary.scheduledOrders}.
No specific order or item was identified in the request. Ask for a SABLE order ID, account PO number, or item number when account-specific facts are required.
</authorized_records>`;
}

export function renderAccountOutcome(result: AccountLookupOutcome): string {
  const { summary, charges } = result.facts;
  return `<authorized_records>
Authorization: ${summary.displayName} (${summary.customerId}) only.
Account tier: ${summary.accountTier}; payment terms: ${summary.paymentTerms}; currency: ${summary.currency}; region: ${summary.region}.
Authenticated user: ${summary.userDisplayName} (${summary.userId}); role: ${summary.userRole}.
Orders: ${summary.totalOrders} total; ${summary.activeOrders} active; ${summary.scheduledOrders} scheduled.
Recent charge-account authorizations:
${charges.map((charge) => `- ${charge.order_id}: ${charge.status}; ${formatCurrency(charge.amount_cents, charge.currency)}; authorization ${charge.authorization_code}; ${charge.authorized_at}.`).join('\n') || '- No charge-account authorizations recorded.'}
</authorized_records>`;
}
