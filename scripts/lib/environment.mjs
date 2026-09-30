import { existsSync } from 'node:fs';

// Existing shell/Cloud secrets take precedence over the local, ignored file.
export function loadLocalEnvironment() {
  if (existsSync('.env')) process.loadEnvFile('.env');
}
