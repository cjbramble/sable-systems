import { describe, expect, it } from 'vitest';

import { getDatabase } from '@/db/database';
import { buildAuthorizedContext } from '@/db/support';
import {
  createSupportModelRequest,
  extractSupportModelContent,
} from '@/lib/support-model';
import { calderPikeUser } from './fixtures/users';

function claimsMatching(value: string, pattern: RegExp) {
  return new Set(value.match(pattern) ?? []);
}

describe('support model factuality', () => {
  it('uses only authorized identifiers, amounts, and dates for an exact order', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'What is the status of SBL-2026-000417?',
      },
    ];
    const database = await getDatabase();
    const authorizedContext = await buildAuthorizedContext(
      database,
      messages,
      calderPikeUser,
    );
    const [modelUrl, modelRequest] = createSupportModelRequest({
      distributorName: calderPikeUser.distributorDisplayName,
      distributorId: calderPikeUser.distributorId,
      authorizedContext,
      messages,
      generation: {
        temperature: 0,
        topP: 1,
        maxTokens: 300,
        seed: 417,
      },
    });

    const response = await fetch(modelUrl, modelRequest);
    expect(response.ok).toBe(true);
    const answer = extractSupportModelContent(await response.json());
    expect(answer).not.toBeNull();
    if (!answer) return;

    expect(answer).toContain('SBL-2026-000417');
    expect(answer).toMatch(/partially[_ -]shipped/i);
    expect(answer).not.toMatch(/WHS-1098|Meridian Civic Supply/i);

    const claimPatterns = [
      /\bSBL-\d{4}-\d{6}\b/g,
      /\b[A-Z]{3}-(?:PO|REL)-\d{6}\b/g,
      /\$\d[\d,]*(?:\.\d{2})?/g,
      /\b20\d{2}-\d{2}-\d{2}\b/g,
    ];
    for (const pattern of claimPatterns) {
      const authorizedClaims = claimsMatching(authorizedContext, pattern);
      for (const claim of claimsMatching(answer, pattern))
        expect(authorizedClaims.has(claim), `Unsupported claim: ${claim}`).toBe(
          true,
        );
    }
  }, 120_000);
});
