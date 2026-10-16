import { expect, test } from './fixtures/app';

test.use({ modelResponses: [] });
test.beforeEach(async ({ loginPage }) => {
  await loginPage.goto('/shop');
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
});

for (const width of [320, 390, 1280]) {
  test(`fits the shop header and keeps actions reachable at ${width}px`, async ({
    page,
    shopPage,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await expect(shopPage.cartTrigger).toBeVisible();
    const pageWidth = () =>
      page.evaluate(() => document.documentElement.scrollWidth);
    expect(await pageWidth()).toBeLessThanOrEqual(width);
    for (const control of [
      page.getByRole('link', { name: 'SABLE home', exact: true }),
      page.getByRole('button', { name: 'Sign out', exact: true }),
      shopPage.cartTrigger,
    ]) {
      await expect(control).toBeInViewport({ ratio: 1 });
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    await shopPage.addCase('SBL-RPC-12');
    expect(await pageWidth()).toBeLessThanOrEqual(width);
    await shopPage.cartTrigger.focus();
    await shopPage.cartTrigger.press('Enter');
    await expect(shopPage.cart).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(shopPage.cartTrigger).toBeFocused();
  });
}

for (const area of ['catalog', 'orders'] as const) {
  test(`shows a visible focus indicator for ${area} search`, async ({
    page,
    ordersPage,
  }) => {
    if (area === 'orders') await ordersPage.goto();
    const input = page.getByLabel(
      area === 'orders' ? 'Search order history' : 'Search catalog',
      { exact: true },
    );
    await input.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((element) =>
        [element, element.parentElement!].some((candidate) => {
          const style = getComputedStyle(candidate);
          return (
            (style.outlineStyle !== 'none' &&
              parseFloat(style.outlineWidth) >= 2) ||
            style.boxShadow !== 'none'
          );
        }),
      ),
    ).toBe(true);
  });
}

test('uses readable table headings with sufficient measured contrast, including hover', async ({
  ordersPage,
}) => {
  await ordersPage.goto();
  const header = ordersPage.table.getByRole('columnheader').first();
  for (const hover of [false, true]) {
    if (hover) await header.hover();
    const metrics = await header.evaluate((element) => {
      const foreground = getComputedStyle(element);
      const background = getComputedStyle(element.parentElement!);
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      };
      const fg = luminance(foreground.color);
      const bg = luminance(background.backgroundColor);
      return {
        contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
        fontSize: parseFloat(foreground.fontSize),
        background: background.backgroundColor,
      };
    });
    expect(metrics.background).toBe('rgb(13, 29, 32)');
    expect(metrics.contrast).toBeGreaterThanOrEqual(4.5);
    expect(metrics.fontSize).toBeGreaterThanOrEqual(11);
  }
});

test('keeps the wide order table scrolling inside a 320px page', async ({
  page,
  ordersPage,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await ordersPage.goto();
  await expect(ordersPage.orderRows.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await ordersPage.table
    .getByRole('columnheader')
    .first()
    .scrollIntoViewIfNeeded();
  const scroll = ordersPage.table.locator('..');
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  await scroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect(
    await scroll.evaluate((element) => element.scrollLeft),
  ).toBeGreaterThan(0);
  await expect(
    ordersPage.table.getByRole('columnheader').last(),
  ).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
});
