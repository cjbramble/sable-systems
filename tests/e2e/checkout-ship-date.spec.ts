import { expect, test } from './fixtures/app';

test.use({ modelResponses: [[], { scope: 'test' }] });

// The calendar date in a zone, as YYYY-MM-DD.
const localDate = (timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());

for (const timezoneId of ['Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
  test.describe(`ship date in ${timezoneId}`, () => {
    test.use({ timezoneId });

    test('offers the customer-local date as the earliest ship date', async ({
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

      const shipDate = shopPage.cart.getByLabel('Requested ship date');
      await expect(shipDate).toHaveAttribute('min', localDate(timezoneId));
    });
  });
}
