import type { AuthenticatedUser } from '@/db/auth';

export const calderPikeUser: AuthenticatedUser = {
  userId: 'USR-CPD-001',
  distributorId: 'WHS-0427',
  userDisplayName: 'Mara Venn',
  email: 'mara.venn@calderpike.example',
  role: 'account_admin',
  distributorDisplayName: 'Calder Pike Distribution',
  accountTier: 'Obsidian Preferred',
  paymentTerms: 'Net 45',
  currency: 'USD',
  region: 'North Atlantic Trade District',
};
