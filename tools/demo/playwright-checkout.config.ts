import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from '../../playwright.config';

// Playwright reloads its config in child processes; inherit one run directory.
const directory = (process.env.SUPPORT_CHECKOUT_RECORDING_DIR ??= resolve(
  'reports/demo-recordings',
  `checkout-${new Date().toISOString().replace(/[:.]/g, '-')}`,
));
const viewport = { width: 1440, height: 900 };

// Record the existing test unchanged; pacing and media output are opt-in.
export default defineConfig(base, {
  testDir: '../../tests/e2e',
  testMatch: 'checkout.spec.ts',
  grep: /removes a cart item, places a charge-account order, and finds it in persisted history/,
  outputDir: resolve(directory, 'results'),
  projects: base.projects?.map((project) => ({
    ...project,
    use: { ...project.use, viewport },
  })),
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(directory, 'report'), open: 'never' }],
    ['json', { outputFile: resolve(directory, 'results.json') }],
  ],
  use: {
    ...base.use,
    viewport,
    launchOptions: { slowMo: 650 },
    trace: 'on',
    video: {
      mode: 'on',
      size: viewport,
      show: {
        test: { level: 'file', fontSize: 18, position: 'bottom-left' },
      },
    },
  },
});
