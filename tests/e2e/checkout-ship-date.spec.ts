import { expect, test } from './fixtures/app';

test.use({ modelResponses: [[], { scope: 'test' }] });

// The calendar date in a zone, as YYYY-MM-DD.
const localDate = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());

for (const timezoneId of ['Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
  test.describe(`ship date in ${timezoneId}`, () => {
    test.use({ timezoneId });

    test('offers and accepts the customer-local date as the earliest ship date', async ({
      loginPage,
      shopPage,
    }) => {
      await shopPage.goto();
      await loginPage.signIn(
        'imani.kade@meridiancivic.example',
        'Sable-WHS-1098!',
        '/shop',
      );
      await shopPage.addCase('SBL-RPC-12');
      await shopPage.openCart();

      const today = localDate(timezoneId);
      const shipDate = shopPage.cart.getByLabel('Requested ship date');
      await expect(shipDate).toHaveAttribute('min', today);

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
