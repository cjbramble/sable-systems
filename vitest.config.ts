import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { Response as WorkerResponse } from 'miniflare';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const modelTest = process.env.SUPPORT_MODEL_TEST === '1';
const proxy =
  modelTest && (process.env.https_proxy || process.env.HTTPS_PROXY)
    ? new EnvHttpProxyAgent()
    : undefined;
// Only the explicit live test launcher may forward provider credentials.
const modelBindings: Record<string, string> = modelTest
  ? {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
      OPENROUTER_SUPPORT_MODEL: process.env.OPENROUTER_SUPPORT_MODEL || '',
    }
  : { OPENROUTER_API_KEY: 'offline-test-key', OPENROUTER_SUPPORT_MODEL: '' };
// Report output and process lifecycle tests need real Node filesystem/process APIs.
const nodeIntegrationTests = ['tests/integration/inference-launchers.test.ts'];

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
              // Workerd cannot use the cloud HTTP proxy directly. Forward only
              // explicit live OpenRouter requests through the host's proxy.
              outboundService: proxy
                ? async (request) => {
                    const url = new URL(request.url);
                    if (
                      url.origin !== 'https://openrouter.ai' ||
                      !['/api/v1/key', '/api/v1/chat/completions'].includes(
                        url.pathname,
                      )
                    )
                      return new WorkerResponse(
                        'Unexpected live test destination',
                        { status: 502 },
                      );
                    const response = await proxyFetch(request.url, {
                      method: request.method,
                      headers: Object.fromEntries(request.headers),
                      body:
                        request.method === 'GET'
                          ? undefined
                          : await request.arrayBuffer(),
                      dispatcher: proxy,
                      redirect: 'error',
                    });
                    return new WorkerResponse(await response.arrayBuffer(), {
                      status: response.status,
                      headers: Object.fromEntries(response.headers),
                    });
                  }
                : undefined,
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
