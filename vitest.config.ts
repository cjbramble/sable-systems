import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const modelTest = process.env.SUPPORT_MODEL_TEST === '1';
// Only the explicit live test launcher may forward provider credentials.
const modelBindings: Record<string, string> = modelTest
  ? {
      SUPPORT_MODEL_PROVIDER: process.env.SUPPORT_MODEL_PROVIDER || 'local',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
      OPENROUTER_SUPPORT_MODEL: process.env.OPENROUTER_SUPPORT_MODEL || '',
    }
  : { SUPPORT_MODEL_PROVIDER: 'local', OPENROUTER_API_KEY: '' };
// Report output and process lifecycle tests need real Node filesystem/process APIs.
const nodeIntegrationTests = ['tests/integration/local-launchers.test.ts'];

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: '2026-05-15',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB', 'INITIALIZATION_DB'],
              bindings: { SABLE_LOCAL_DEMO: 'true', ...modelBindings },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: modelTest
            ? ['tests/model/**/*.test.ts']
            : ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...nodeIntegrationTests],
        },
      },
      ...(modelTest
        ? []
        : [
            {
              extends: true as const,
              test: {
                name: 'node',
                environment: 'node',
                include: nodeIntegrationTests,
              },
            },
          ]),
    ],
  },
});
