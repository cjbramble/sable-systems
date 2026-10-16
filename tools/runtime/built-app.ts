import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Miniflare,
  convertV4MiniflareOptions,
  type Request,
  type Response,
} from 'miniflare';
import { validateBuiltConfig } from './built-config';
import { localDatabase, workerCompatibility } from './worker-settings';

type BuiltAppOptions = {
  localDemo: boolean;
  apiKey: string;
  model: string;
  outboundService: (request: Request) => Promise<Response>;
};

/** Callers own readiness and disposal, including failure paths. No environment is inherited. */
export async function createBuiltApp(
  options: BuiltAppOptions,
): Promise<Miniflare> {
  const serverPath = fileURLToPath(
    new URL('../../dist/server', import.meta.url),
  );
  validateBuiltConfig(
    JSON.parse(await readFile(resolve(serverPath, 'wrangler.json'), 'utf8')),
  );
  const files = await readdir(serverPath, { recursive: true });
  return new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      cf: false,
      // Vinext dynamically loads chunks; register all of them, entrypoint first.
      modulesRoot: serverPath,
      modules: [
        'index.js',
        ...files.filter((file) => file !== 'index.js' && /\.m?js$/.test(file)),
      ].map((file) => ({
        type: 'ESModule' as const,
        path: resolve(serverPath, file),
      })),
      ...workerCompatibility,
      d1Databases: [localDatabase.binding],
      d1Persist: false,
      bindings: {
        SABLE_LOCAL_DEMO: String(options.localDemo),
        OPENROUTER_API_KEY: options.apiKey,
        OPENROUTER_SUPPORT_MODEL: options.model,
      },
      assets: {
        directory: resolve(serverPath, '../client'),
        binding: 'ASSETS',
        routerConfig: { has_user_worker: true },
      },
      outboundService: options.outboundService,
    }),
  );
}
