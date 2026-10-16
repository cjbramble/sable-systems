import {
  localDatabase,
  workerCompatibility,
} from './tools/runtime/worker-settings.ts';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { OPENROUTER_MODEL } from './lib/support-model-config.mjs';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_date: workerCompatibility.compatibilityDate,
  compatibility_flags: workerCompatibility.compatibilityFlags,
  d1_databases: [localDatabase],
};

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: {
          ...localBindingConfig,
          vars: {
            SABLE_LOCAL_DEMO: command === 'serve' ? 'true' : 'false',
            OPENROUTER_SUPPORT_MODEL:
              process.env.OPENROUTER_SUPPORT_MODEL || OPENROUTER_MODEL,
          },
          // Load only declared bindings/secrets, including shell/Cloud overrides.
          // The actual key is a runtime secret; it is never embedded in vars.
          secrets: { required: ['OPENROUTER_API_KEY'] },
        },
      }),
    ],
  };
});
