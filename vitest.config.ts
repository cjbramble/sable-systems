import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const modelTest = process.env.SUPPORT_MODEL_TEST === '1';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-05-15',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
      },
    }),
  ],
  test: {
    include: modelTest
      ? ['tests/model/**/*.test.ts']
      : ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});
