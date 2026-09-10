import { test as base } from 'vitest';

import { getDatabase } from '@/db/database';
import { createSupportApiFixture } from './support-api';

// Both fixtures are test-scoped. Do not share sessions or cleanup state.
export const test = base
  .extend('database', async () => getDatabase())
  .extend('supportApi', ({ database }, { onCleanup }) => {
    const fixture = createSupportApiFixture(database);
    onCleanup(() => fixture.cleanup());
    return fixture;
  });
