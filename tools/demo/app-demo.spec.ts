import {
  expect,
  test,
  type BrowserContext,
  type Video,
} from '@playwright/test';
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as WorkerResponse,
  type Request as WorkerRequest,
} from 'miniflare';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessScope } from '../../scripts/lib/process-scope.mjs';
import { loadLocalEnvironment } from '../../scripts/lib/environment.mjs';
import {
  getSupportModelConfig,
  OPENROUTER_KEY_URL,
  supportModelHeaders,
} from '../../lib/support-model-config.mjs';
import { ShopPage } from '../../tests/e2e/pages/shop-page';
import { SupportPage } from '../../tests/e2e/pages/support-page';

test('landing to checkout to live COV-E order lookup', async ({
  browser,
  playwright,
}, info) => {
  const scope = createProcessScope();
  const directory = info.outputPath('capture');
  const viewport = { width: 1440, height: 900 };
  await mkdir(directory, { recursive: true });
  loadLocalEnvironment();
  const config = getSupportModelConfig({
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_SUPPORT_MODEL: process.env.OPENROUTER_SUPPORT_MODEL,
  });
  const headers = supportModelHeaders(config);
  const calls: { request: unknown; response: unknown }[] = [];
  const stages: { name: string; seconds: number }[] = [];
  const errors: string[] = [];
  let runtime: Miniflare | undefined;
  let context: BrowserContext | undefined;
  let video: Video | null | undefined;
  let receipt: { orderId: string; totalCents: number } | undefined;
  let savedOrder: unknown;
  const answers: string[] = [];
  let started = 0;
  const mark = (name: string) =>
    stages.push({ name, seconds: (performance.now() - started) / 1000 });
  const pause = (ms: number) => delay(ms, undefined, { signal: scope.signal });

  try {
    const serverPath = resolve('dist/server');
    const files = await readdir(serverPath, { recursive: true });
    // A disposable production-build instance. No working database is read or written.
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        host: '127.0.0.1',
        port: 0,
        cf: false,
        modulesRoot: serverPath,
        modules: [
          'index.js',
          ...files.filter(
            (file) => file !== 'index.js' && /\.m?js$/.test(file),
          ),
        ].map((file) => ({
          type: 'ESModule' as const,
          path: resolve(serverPath, file),
        })),
        compatibilityDate: '2026-05-15',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        d1Persist: false,
        bindings: {
          SABLE_LOCAL_DEMO: 'true',
          OPENROUTER_API_KEY: config.apiKey,
          OPENROUTER_SUPPORT_MODEL: config.model,
        },
        assets: {
          directory: resolve('dist/client'),
          binding: 'ASSETS',
          routerConfig: { has_user_worker: true },
        },
        outboundService: async (request: WorkerRequest) => {
          const allowed =
            (request.method === 'GET' && request.url === OPENROUTER_KEY_URL) ||
            (request.method === 'POST' && request.url === config.url);
          if (!allowed)
            throw new Error(
              `Unexpected outbound request: ${request.method} ${request.url}`,
            );
          const body =
            request.method === 'POST' ? await request.text() : undefined;
          const response = await fetch(request.url, {
            method: request.method,
            body,
            headers,
            signal: AbortSignal.any([
              scope.signal,
              AbortSignal.timeout(90_000),
            ]),
          });
          const text = await response.text();
          if (body)
            calls.push({
              request: JSON.parse(body),
              response: JSON.parse(text),
            });
          return new WorkerResponse(text, {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      }),
    );
    const baseURL = (await runtime.ready).origin;
    const auth = await playwright.request.newContext({ baseURL });
    let storageState;
    try {
      const login = await auth.post('/api/auth/login', {
        headers: { Origin: baseURL },
        data: {
          email: 'mara.venn@calderpike.example',
          password: 'Sable-WHS-0427!',
        },
      });
      expect(login.status()).toBe(200);
      storageState = await auth.storageState();
    } finally {
      await auth.dispose();
    }

    context = await browser.newContext({
      baseURL,
      storageState,
      viewport,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      recordVideo: { dir: directory, size: viewport },
    });
    started = performance.now();
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    video = page.video();
    const shop = new ShopPage(page);
    const support = new SupportPage(page);

    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.getByRole('link', { name: 'Enter procurement' }),
    ).toBeVisible();
    mark('landing');
    await page.screenshot({ path: resolve(directory, '01-landing.png') });
    await pause(2300);
    await page.getByRole('link', { name: 'Enter procurement' }).hover();
    await pause(400);
    await page.getByRole('link', { name: 'Enter procurement' }).click();
    await expect(shop.signedInUser).toContainText('Mara Venn');
    await shop.chooseCategory('Power');
    const card = shop.productCard('SBL-RPC-12');
    await card.scrollIntoViewIfNeeded();
    mark('product');
    await page.screenshot({ path: resolve(directory, '02-product.png') });
    await pause(1700);
    await shop.addCaseButton('SBL-RPC-12').hover();
    await pause(400);
    await shop.addCase('SBL-RPC-12');
    await pause(600);
    await shop.openCart();
    const requestedShipDate = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await shop.fillOrder({
      customerPoNumber: 'CPD-DEMO-ORDER',
      requestedShipDate,
      shippingRegion: 'North Atlantic Trade District',
    });
    await shop.chargeConsent.check();
    await expect(shop.cartTotal).toHaveText('$5,440.00');
    mark('checkout');
    await page.screenshot({ path: resolve(directory, '03-checkout.png') });
    await pause(2300);
    const response = await shop.placeOrder();
    expect(response.status()).toBe(201);
    receipt = await response.json();
    expect(receipt?.totalCents).toBe(544000);
    await expect(shop.confirmationHeading).toBeVisible();
    await expect(shop.confirmationValue('Order')).toHaveText(receipt!.orderId);
    mark('confirmation');
    await page.screenshot({ path: resolve(directory, '04-confirmation.png') });
    await pause(3400);
    await shop.closeCart();
    await page
      .getByRole('link', { name: 'COV-E Support', exact: true })
      .click();
    await expect(support.messageInput).toBeEditable();
    await expect(support.runtimeStatus).toContainText(/online/i);
    await support.startIncident();
    mark('support');
    await pause(700);

    for (const [index, question] of [
      `Find order ${receipt!.orderId}. What did I order and what is the total?`,
      'What is its status, and has it shipped?',
    ].entries()) {
      await support.messageInput.pressSequentially(question, { delay: 26 });
      await pause(550);
      const reply = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/chat' &&
          r.request().method() === 'POST',
        { timeout: 90_000 },
      );
      mark(`question-${index + 1}`);
      await page.getByRole('button', { name: 'Send message' }).click();
      const result = await reply;
      expect(result.status()).toBe(200);
      await expect(support.responding).toHaveCount(0);
      await expect(support.messages).toHaveCount(3 + index * 2);
      const answer = await support.messages.last().innerText();
      answers.push(answer);
      mark(`answer-${index + 1}`);
      await page.screenshot({
        path: resolve(directory, `05-answer-${index + 1}.png`),
      });
      await pause(index === 0 ? 4500 : 6500);
    }

    const db = await runtime.getD1Database('DB');
    savedOrder = await db
      .prepare(
        'SELECT order_id, customer_id, status, order_total_cents, requested_ship_date FROM orders WHERE order_id = ?',
      )
      .bind(receipt!.orderId)
      .first();
    expect(savedOrder).toEqual({
      order_id: receipt!.orderId,
      customer_id: 'WHS-0427',
      status: 'confirmed',
      order_total_cents: 544000,
      requested_ship_date: requestedShipDate,
    });
    const shipments = await db
      .prepare('SELECT COUNT(*) AS count FROM shipments WHERE order_id = ?')
      .bind(receipt!.orderId)
      .first();
    expect(shipments?.count).toBe(0);
    expect(answers[0]).toContain('SBL-RPC-12');
    expect(answers[0]).toMatch(/\b8\b/);
    expect(answers[0]).toContain('$5,440');
    expect(answers[1]).toMatch(/confirmed/i);
    expect(answers[1]).toMatch(
      /not (?:yet )?(?:shipped|dispatched)|no shipment|hasn.t (?:been )?shipped/i,
    );
    expect(calls).toHaveLength(2);
    // These simple questions should be concise without customer style instructions.
    for (const answer of answers)
      expect(answer.trim().split(/\s+/).length).toBeLessThanOrEqual(75);
    expect(errors).toEqual([]);
    mark('end');
  } finally {
    try {
      await writeFile(
        resolve(directory, 'evidence.json'),
        JSON.stringify(
          {
            stages,
            receipt,
            savedOrder,
            answers,
            modelCalls: calls,
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        await context?.close();
        if (video) await video.saveAs(resolve(directory, 'raw.webm'));
      } finally {
        try {
          await runtime?.dispose();
        } finally {
          await scope.stop();
          scope.dispose();
        }
      }
    }
    console.info(`Demo capture: ${directory}`);
  }
});
