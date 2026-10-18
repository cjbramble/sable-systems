import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Playwright reloads its config in child processes; inherit one run directory.
const directory = (process.env.SUPPORT_DEMO_RECORDING_DIR ??= resolve(
  'reports/demo-recordings',
  new Date().toISOString().replace(/[:.]/g, '-'),
));

// Opt-in recording only; the normal test suites do not discover this directory.
export default defineConfig({
  testDir: '.',
  testMatch: 'app-demo.spec.ts',
  outputDir: directory,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: { actionTimeout: 15_000, navigationTimeout: 30_000 },
});
