import { expect, test } from './fixtures/app';

test.use({ modelResponses: [[], { scope: 'test' }] });

// The calendar date in a zone, plus whole days and years, as YYYY-MM-DD.
const localDate = (timeZone: string, days = 0, years = 0) => {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone })
    .format(new Date())
    .split('-')
    .map(Number);
  return new Date(Date.UTC(year + years, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
};

for (const timezoneId of ['Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
  test.describe(`ship date in ${timezoneId}`, () => {
    test.use({ timezoneId });

    test('offers and accepts the customer-local date plus the cart lead time as the earliest ship date', async ({
      loginPage,
      shopPage,
    }) => {
      await shopPage.goto();
      await loginPage.signIn(
        'imani.kade@meridiancivic.example',
        'Sable-WHS-1098!',
        '/shop',
      );
      // SBL-RPC-12 has an 18-day lead time.
      await shopPage.addCase('SBL-RPC-12');
      // The zone's date may roll over while the cart renders; accept either day.
      const before = localDate(timezoneId, 18);
      await shopPage.openCart();
      const shipDate = shopPage.cart.getByLabel('Requested ship date');
      await expect(shipDate).toHaveAttribute('min', /^\d{4}-\d{2}-\d{2}$/);
      const today = (await shipDate.getAttribute('min'))!;
      expect([before, localDate(timezoneId, 18)]).toContain(today);
      expect([
        localDate(timezoneId, 0, 5),
        localDate(timezoneId, 1, 5),
      ]).toContain(await shipDate.getAttribute('max'));
      // The 14-day default moves up to the earliest date the cart allows.
      await expect(shipDate).toHaveValue(today);

      // The browser sends its zone; integration tests pin the clock for the
      // boundary cases.
      await shopPage.fillOrder({
        customerPoNumber: `MCS-E2E-TZ-${timezoneId
          .split('/')[1]
          .replace(/[^A-Za-z0-9]+/g, '-')
          .toUpperCase()}`,
        requestedShipDate: today,
        shippingRegion: 'Great Lakes District',
      });
      await shopPage.chargeConsent.check();
      const response = await shopPage.placeOrder();
      expect(response.request().postDataJSON()).toMatchObject({
        requestedShipDate: today,
        timeZone: timezoneId,
      });
      expect(response.status()).toBe(201);
    });
  });
}

test('raises the earliest ship date with the longest lead time in the cart', async ({
  loginPage,
  shopPage,
}) => {
  await shopPage.goto();
  await loginPage.signIn(
    'imani.kade@meridiancivic.example',
    'Sable-WHS-1098!',
    '/shop',
  );
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Licenses have no lead time.
  await shopPage.addCase('SBL-PAL-1Y');
  await shopPage.openCart();
  const shipDate = shopPage.cart.getByLabel('Requested ship date');
  const minimum = async () => (await shipDate.getAttribute('min'))!;
  expect([localDate(timeZone), localDate(timeZone, 1)]).toContain(
    await minimum(),
  );
  // A date the buyer chose later than the lead time is kept.
  await shipDate.fill(localDate(timeZone, 40));
  await shopPage.closeCart();
  await shopPage.addCase('SBL-RPC-12');
  await shopPage.openCart();
  expect([localDate(timeZone, 18), localDate(timeZone, 19)]).toContain(
    await minimum(),
  );
  await expect(shipDate).toHaveValue(localDate(timeZone, 40));
  await shopPage.closeCart();
  // SBL-KTA-T7 has a 60-day lead time, past the chosen date.
  await shopPage.addCase('SBL-KTA-T7');
  await shopPage.openCart();
  const earliest = await minimum();
  expect([localDate(timeZone, 60), localDate(timeZone, 61)]).toContain(
    earliest,
  );
  await expect(shipDate).toHaveValue(earliest);
  await shopPage.removeItem('SBL-KTA-T7');
  await expect(shipDate).toHaveValue(localDate(timeZone, 40));
});
