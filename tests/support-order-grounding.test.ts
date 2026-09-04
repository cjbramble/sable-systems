import { describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/db/auth';
import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import { classifySupportQuery } from '@/lib/support-query';

const calderPikeUser: AuthenticatedUser = {
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

describe('support order grounding', () => {
  it('builds an exact, tenant-scoped context for a known order', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'What is the status of SBL-2026-000417?',
      },
    ];

    expect(classifySupportQuery(messages)).toEqual({
      kind: 'order',
      identifier: 'SBL-2026-000417',
    });

    const database = await getDatabase();
    const context = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );

    expect(context).toContain(
      'Authorization: Calder Pike Distribution (WHS-0427) only.',
    );
    expect(context).toContain(
      'Order: SBL-2026-000417; customer PO: CPD-PO-260417; status: partially_shipped.',
    );
    expect(context).toContain(
      'Created: 2026-08-03; requested ship date: 2026-08-26; destination: North Atlantic Trade District.',
    );
    expect(context).toContain('Order total: $78,320.00.');
    expect(context).toContain(
      'SBL-RPC-12 Redline Power Cell R12: ordered 64, allocated 64, shipped 32, cancelled 0; price $680.00 per unit.',
    );
    expect(context).toContain(
      'SBL-SWC-12 Signal-Weave Active Cable, 12 m: ordered 120, allocated 120, shipped 120, cancelled 0; price $290.00 per unit.',
    );
    expect(context.match(/\bSBL-\d{4}-\d{6}\b/g)).toEqual(['SBL-2026-000417']);
    expect(context).not.toContain('WHS-1098');
    expect(context).not.toContain('Meridian Civic Supply');
  });
});
