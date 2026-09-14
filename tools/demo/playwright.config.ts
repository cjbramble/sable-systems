import { defineConfig } from '@playwright/test';

// Opt-in recording only; the normal test suites do not discover this directory.
export default defineConfig({
  testDir: '.',
  testMatch: 'app-demo.spec.ts',
  outputDir: `../../reports/demo-recordings/${new Date().toISOString().replace(/[:.]/g, '-')}`,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { actionTimeout: 15_000, navigationTimeout: 30_000 },
});
