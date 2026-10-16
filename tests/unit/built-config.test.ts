import { describe, expect, it } from 'vitest';
import { validateBuiltConfig } from '../../tools/runtime/built-config';
import {
  localDatabase,
  workerCompatibility,
} from '../../tools/runtime/worker-settings';

const validConfig = () => ({
  main: 'index.js',
  compatibility_date: workerCompatibility.compatibilityDate,
  compatibility_flags: [...workerCompatibility.compatibilityFlags],
  d1_databases: [{ ...localDatabase }],
  assets: { directory: '../client' },
  vars: {
    SABLE_LOCAL_DEMO: 'false',
    OPENROUTER_SUPPORT_MODEL: 'controlled-model',
  },
});

describe('built Worker contract', () => {
  it('accepts the supported production build', () => {
    expect(() => validateBuiltConfig(validConfig())).not.toThrow();
  });
  it.each([
    null,
    [],
    { main: 'other.js' },
    { compatibility_date: '2025-01-01' },
    { compatibility_flags: [] },
    { d1_databases: [] },
    { d1_databases: [{ ...localDatabase, binding: 'OTHER' }] },
    { assets: { directory: '/some/working/directory' } },
    { vars: { SABLE_LOCAL_DEMO: 'true', OPENROUTER_SUPPORT_MODEL: 'model' } },
    { vars: { SABLE_LOCAL_DEMO: 'false' } },
    {
      vars: {
        ...validConfig().vars,
        OPENROUTER_API_KEY: 'secret-must-not-appear',
      },
    },
  ])('rejects malformed, unsafe or drifting configuration %#', (override) => {
    const value =
      override === null || Array.isArray(override)
        ? override
        : { ...validConfig(), ...override };
    expect(() => validateBuiltConfig(value)).toThrow(/Worker configuration/);
    try {
      validateBuiltConfig(value);
    } catch (error) {
      expect(String(error)).not.toContain('secret-must-not-appear');
    }
  });
});
