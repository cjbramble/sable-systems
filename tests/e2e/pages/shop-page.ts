import type { Page } from '@playwright/test';
import { SessionControls } from './session-controls';
import { QuantityControl } from './quantity-control';

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

  get loadingError() {
    return this.page.getByRole('alert');
  }

  async retryAccount() {
    await this.page
      .getByRole('button', { name: 'Retry account', exact: true })
      .click();
  }

  async retryCatalog() {
    await this.page
      .getByRole('button', { name: 'Retry uplink', exact: true })
      .click();
  }

  get shippingRegion() {
    return this.cart.getByLabel('Destination region');
  }

  get accountTerms() {
    return this.cart.getByText(/^Account terms:/);
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

  productCard(itemNumber: string) {
    return this.page
      .getByRole('article')
      .filter({ has: this.page.getByText(itemNumber, { exact: true }) });
  }

  addCaseButton(itemNumber: string) {
    return this.productCard(itemNumber).getByRole('button', {
      name: 'Add case',
      exact: true,
    });
  }

  quantity(itemNumber: string, surface: 'catalog' | 'cart' = 'cart') {
    const container =
      surface === 'catalog'
        ? this.productCard(itemNumber)
        : this.cartLine(itemNumber);
    return new QuantityControl(container.locator('.quantity-control'));
  }

  removeItemButton(itemNumber: string) {
    return this.cartLine(itemNumber).getByRole('button', {
      name: /^Remove .+ from cart$/,
    });
  }

  get orderFields() {
    return this.cart.locator('.checkout-form-grid input');
  }

  get checkoutError() {
    return this.cart.getByRole('alert');
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
      name: /^(Place charge account order|Reserving inventory…)/,
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
    await this.addCaseButton(itemNumber).click();
  }

  async openCart() {
    await this.cartTrigger.click();
  }

  async closeCart() {
    await this.cart.getByRole('button', { name: 'Close', exact: true }).click();
  }

  async submitOrder() {
    await this.placeOrderButton.click();
  }

  async removeItem(itemNumber: string) {
    await this.removeItemButton(itemNumber).click();
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
      this.submitOrder(),
    ]);
    return response;
  }

  async openOrderHistory() {
    await this.cart.getByRole('link', { name: 'View order history' }).click();
    await this.page.waitForURL((url) => url.pathname === '/orders');
  }
}
