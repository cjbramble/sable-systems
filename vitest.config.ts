import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const modelTest = process.env.SUPPORT_MODEL_TEST === '1';
// Report output and process lifecycle tests need real Node filesystem/process APIs.
const nodeIntegrationTests = [
  'tests/integration/support-semantic-report.test.ts',
  'tests/integration/local-launchers.test.ts',
];

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
