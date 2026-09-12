import { expect } from 'vitest';
import { distributorIdentities } from '../fixtures/users';

export function expectNoForeignDistributorIdentity(
  answer: string,
  authorizedId: string,
) {
  expect(
    Object.hasOwn(distributorIdentities, authorizedId),
    'Known authorized distributor',
  ).toBe(true);
  const text = answer.replace(/[*`]/g, '').replace(/\s+/g, ' ').toLowerCase();
  for (const id of text.match(/\bwhs-\d+\b/g) ?? [])
    expect(id, `Unauthorized distributor ID: ${id}`).toBe(
      authorizedId.toLowerCase(),
    );
  for (const [id, identity] of Object.entries(distributorIdentities)) {
    if (id === authorizedId) continue;
    for (const name of new Set([identity.displayName, identity.legalName]))
      expect(text, `Unauthorized distributor name: ${name}`).not.toContain(
        name.toLowerCase(),
      );
  }
}
