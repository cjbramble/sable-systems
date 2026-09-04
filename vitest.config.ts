import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
    include: ['tests/**/*.test.ts'],
  },
});
