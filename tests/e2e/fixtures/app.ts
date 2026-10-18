import { test as base } from '@playwright/test';
import {
  type Miniflare,
  Response,
  type Request as WorkerRequest,
} from 'miniflare';
import { createBuiltApp } from '../../../tools/runtime/built-app';
import { OPENROUTER_MODEL } from '../../../lib/support-model-config.mjs';
import { MODEL_READINESS_CACHE_MS } from '../../../lib/model-readiness.mjs';

import { LoginPage } from '../pages/login-page';
import { HomePage } from '../pages/home-page';
import { OrdersPage } from '../pages/orders-page';
import { ShopPage } from '../pages/shop-page';
import { SupportPage } from '../pages/support-page';

type App = {
  url: string;
  database: Awaited<ReturnType<Miniflare['getD1Database']>>;
  modelRequests: unknown[];
  // Resolves once the app's cached readiness result has expired.
  setModelMetadata: (payload: unknown) => Promise<void>;
};

type Fixtures = {
  localDemo: boolean;
  modelReply: string;
  modelResponses: { status: number; body: unknown }[] | null;
  app: App;
  loginPage: LoginPage;
  homePage: HomePage;
  ordersPage: OrdersPage;
  shopPage: ShopPage;
  supportPage: SupportPage;
};

export const test = base.extend<Fixtures>({
  localDemo: [true, { option: true }],
  modelReply: ['', { option: true }],
  modelResponses: [null, { option: true }],
  app: async ({ modelReply, modelResponses, localDemo }, provide) => {
    if (!modelReply && modelResponses === null)
      throw new Error(
        'Set a controlled modelReply or modelResponses for this test.',
      );
    const responseSequence = modelResponses?.slice() ?? null;
    const modelRequests: unknown[] = [];
    let modelMetadata: unknown = { data: { limit_remaining: 1 } };
    const unexpectedRequests: string[] = [];
    const runtime = await createBuiltApp({
      localDemo,
      apiKey: 'browser-test-key',
      model: OPENROUTER_MODEL,
      // Exercise real app endpoints; replace only worker-to-model transport.
      outboundService: async (request: WorkerRequest) => {
        if (
          request.method === 'GET' &&
          request.url === 'https://openrouter.ai/api/v1/key'
        ) {
          return Response.json(modelMetadata);
        }
        if (
          request.method === 'POST' &&
          request.url === 'https://openrouter.ai/api/v1/chat/completions'
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
            choices: [
              { finish_reason: 'stop', message: { content: modelReply } },
            ],
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
      await provide({
        url: url.origin,
        database,
        modelRequests,
        async setModelMetadata(payload) {
          modelMetadata = payload;
          await new Promise((resolve) =>
            setTimeout(resolve, MODEL_READINESS_CACHE_MS),
          );
        },
      });
    } finally {
      await runtime.dispose();
    }
    if (unexpectedRequests.length) {
      throw new Error(
        `Unexpected outbound requests: ${unexpectedRequests.join(', ')}`,
      );
    }
    // A skipped model call (for example a corrective retry) must not pass silently.
    if (responseSequence?.length) {
      throw new Error(
        `${responseSequence.length} planned model response(s) were never requested`,
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
