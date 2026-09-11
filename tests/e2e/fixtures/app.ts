import { test as base } from '@playwright/test';
import { Miniflare, Response } from 'miniflare';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LoginPage } from '../pages/login-page';
import { HomePage } from '../pages/home-page';
import { OrdersPage } from '../pages/orders-page';
import { ShopPage } from '../pages/shop-page';
import { SupportPage } from '../pages/support-page';

type App = {
  url: string;
  database: Awaited<ReturnType<Miniflare['getD1Database']>>;
  modelRequests: unknown[];
};

type Fixtures = {
  modelReply: string;
  modelResponses: { status: number; body: unknown }[] | null;
  app: App;
  loginPage: LoginPage;
  homePage: HomePage;
  ordersPage: OrdersPage;
  shopPage: ShopPage;
  supportPage: SupportPage;
};

const projectPath = (path: string) =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url));

export const test = base.extend<Fixtures>({
  modelReply: ['', { option: true }],
  modelResponses: [null, { option: true }],
  app: async ({ modelReply, modelResponses }, provide) => {
    if (!modelReply && modelResponses === null)
      throw new Error(
        'Set a controlled modelReply or modelResponses for this test.',
      );
    const responseSequence = modelResponses?.slice() ?? null;
    const modelRequests: unknown[] = [];
    const unexpectedRequests: string[] = [];
    const serverPath = projectPath('dist/server');
    const files = await readdir(serverPath, { recursive: true });
    const runtime = new Miniflare({
      host: '127.0.0.1',
      port: 0,
      cf: false,
      // Vinext loads chunks dynamically, so register the complete server build
      // explicitly, with the worker entrypoint first.
      modulesRoot: serverPath,
      modules: [
        'index.js',
        ...files.filter((file) => file !== 'index.js' && /\.m?js$/.test(file)),
      ].map((file) => ({
        type: 'ESModule' as const,
        path: resolve(serverPath, file),
      })),
      compatibilityDate: '2026-05-15',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      d1Persist: false,
      assets: {
        directory: projectPath('dist/client'),
        binding: 'ASSETS',
        routerConfig: { has_user_worker: true },
      },
      // Exercise real app endpoints; replace only worker-to-model transport.
      outboundService: async (request) => {
        if (
          request.method === 'GET' &&
          request.url === 'http://127.0.0.1:8017/v1/models'
        ) {
          return Response.json({ data: [{ id: 'customer-support-local' }] });
        }
        if (
          request.method === 'POST' &&
          request.url === 'http://127.0.0.1:8017/v1/chat/completions'
        ) {
          modelRequests.push(await request.json());
          if (responseSequence !== null) {
            const planned = responseSequence.shift();
            if (!planned) {
              unexpectedRequests.push('Model response sequence exhausted');
              return new Response(
                'No model response configured for this request',
                {
                  status: 502,
                },
              );
            }
            return Response.json(planned.body, { status: planned.status });
          }
          return Response.json({
            choices: [{ message: { content: modelReply } }],
          });
        }
        unexpectedRequests.push(`${request.method} ${request.url}`);
        return new Response('Unexpected outbound request blocked by test', {
          status: 502,
        });
      },
    });
    try {
      const url = await runtime.ready;
      const database = await runtime.getD1Database('DB');
      await provide({ url: url.origin, database, modelRequests });
    } finally {
      await runtime.dispose();
    }
    if (unexpectedRequests.length) {
      throw new Error(
        `Unexpected outbound requests: ${unexpectedRequests.join(', ')}`,
      );
    }
  },
  baseURL: async ({ app }, provide) => {
    await provide(app.url);
  },
  loginPage: async ({ page }, provide) => {
    await provide(new LoginPage(page));
  },
  homePage: async ({ page }, provide) => {
    await provide(new HomePage(page));
  },
  ordersPage: async ({ page }, provide) => {
    await provide(new OrdersPage(page));
  },
  shopPage: async ({ page }, provide) => {
    await provide(new ShopPage(page));
  },
  supportPage: async ({ page }, provide) => {
    await provide(new SupportPage(page));
  },
});

export { expect } from '@playwright/test';
