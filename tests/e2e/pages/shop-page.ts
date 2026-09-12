import type { Page } from '@playwright/test';
import { SessionControls } from './session-controls';

export class ShopPage {
  readonly session: SessionControls;
  constructor(private readonly page: Page) {
    this.session = new SessionControls(page);
  }

  categoryTab(category: string) {
    return this.page.getByRole('button', { name: category, exact: true });
  }

  get productCategories() {
    return this.page.getByRole('article').locator('[data-slot="badge"]');
  }

  async chooseCategory(category: string) {
    await this.categoryTab(category).click();
  }

  get signedInUser() {
    return this.page.locator('.shop-account strong');
  }

  get cartTrigger() {
    return this.page.getByRole('button', { name: /^Cart \d+$/ });
  }

  get cart() {
    return this.page.getByRole('dialog', { name: 'Procurement queue' });
  }

  get cartLines() {
    return this.cart.locator('.checkout-line');
  }

  cartLine(itemNumber: string) {
    return this.cartLines.filter({
      has: this.page.getByText(itemNumber, { exact: true }),
    });
  }

  cartQuantity(itemNumber: string) {
    return this.cartLine(itemNumber).locator('.quantity-control strong');
  }

  get cartTotal() {
    return this.cart.locator('.checkout-total strong');
  }

  get chargeConsent() {
    return this.cart.getByRole('checkbox', { name: /^Charge this order to/ });
  }

  get placeOrderButton() {
    return this.cart.getByRole('button', {
      name: 'Place charge account order',
      exact: true,
    });
  }

  get confirmationHeading() {
    return this.cart.getByRole('heading', {
      name: 'Order entered.',
      exact: true,
    });
  }

  confirmationValue(label: string) {
    return this.cart
      .locator('.order-success dl > div')
      .filter({
        has: this.page.getByText(label, { exact: true }),
      })
      .getByRole('definition');
  }

  async goto(category?: string) {
    return this.page.goto(
      category ? `/shop?category=${encodeURIComponent(category)}` : '/shop',
    );
  }

  async addCase(itemNumber: string) {
    await this.page
      .getByRole('article')
      .filter({ has: this.page.getByText(itemNumber, { exact: true }) })
      .getByRole('button', { name: 'Add case', exact: true })
      .click();
  }

  async openCart() {
    await this.cartTrigger.click();
  }

  async removeItem(itemNumber: string) {
    await this.cartLine(itemNumber)
      .getByRole('button', { name: /^Remove .+ from cart$/ })
      .click();
  }

  async fillOrder(details: {
    customerPoNumber: string;
    requestedShipDate: string;
    shippingRegion: string;
  }) {
    await this.cart
      .getByLabel('Purchase-order reference')
      .fill(details.customerPoNumber);
    await this.cart
      .getByLabel('Requested ship date')
      .fill(details.requestedShipDate);
    await this.cart
      .getByLabel('Destination region')
      .fill(details.shippingRegion);
  }

  async placeOrder() {
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/orders' &&
          response.request().method() === 'POST',
      ),
      this.placeOrderButton.click(),
    ]);
    return response;
  }

  async openOrderHistory() {
    await this.cart.getByRole('link', { name: 'View order history' }).click();
    await this.page.waitForURL((url) => url.pathname === '/orders');
  }
}
