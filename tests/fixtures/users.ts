import type { AuthenticatedUser } from '@/db/auth';

export const distributorIdentities = {
  'WHS-0427': {
    displayName: 'Calder Pike Distribution',
    legalName: 'Calder Pike Distribution Cooperative',
  },
  'WHS-1098': {
    displayName: 'Meridian Civic Supply',
    legalName: 'Meridian Civic Supply Limited',
  },
  'WHS-2714': {
    displayName: 'Northline Prosthetics Cooperative',
    legalName: 'Northline Prosthetics Cooperative',
  },
  'WHS-5830': {
    displayName: 'Halcyon Industrial Exchange',
    legalName: 'Halcyon Industrial Exchange Incorporated',
  },
} as const;

export async function loadActiveUserFixture(
  database: D1Database,
  userId: string,
): Promise<AuthenticatedUser> {
  const user = await database
    .prepare(`SELECT u.user_id AS userId, u.distributor_id AS distributorId,
      u.display_name AS userDisplayName, u.email, u.role,
      d.display_name AS distributorDisplayName, d.account_tier AS accountTier,
      d.payment_terms AS paymentTerms, d.currency, d.region
      FROM users u JOIN distributors d ON d.customer_id = u.distributor_id
      WHERE u.user_id = ? AND u.status = 'active' AND d.account_status = 'active'`)
    .bind(userId)
    .first<AuthenticatedUser>();
  if (!user) throw new Error(`Missing active user fixture: ${userId}`);
  return user;
}

export const calderPikeUser: AuthenticatedUser = {
  userId: 'USR-CPD-001',
  distributorId: 'WHS-0427',
  userDisplayName: 'Mara Venn',
  email: 'mara.venn@calderpike.example',
  role: 'account_admin',
  distributorDisplayName: distributorIdentities['WHS-0427'].displayName,
  accountTier: 'Obsidian Preferred',
  paymentTerms: 'Net 45',
  currency: 'USD',
  region: 'North Atlantic Trade District',
};
