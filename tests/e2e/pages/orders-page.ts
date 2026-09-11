import type { Page } from '@playwright/test';

export class OrdersPage {
  constructor(private readonly page: Page) {}

  get heading() {
    return this.page.getByRole('heading', {
      name: 'Order history.',
      exact: true,
    });
  }

  get signedInUser() {
    return this.page.locator('.shop-account strong');
  }

  get table() {
    return this.page.getByRole('table');
  }

  get orderRows() {
    return this.table.locator('tbody').getByRole('row');
  }

  orderCells(orderId: string) {
    return this.orderRows
      .filter({ has: this.page.getByText(orderId, { exact: true }) })
      .getByRole('cell');
  }

  async search(query: string) {
    await this.page.getByPlaceholder('Order ID, PO, or buyer').fill(query);
    const [response] = await Promise.all([
      this.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/orders' &&
          response.request().method() === 'GET' &&
          url.searchParams.get('query') === query
        );
      }),
      this.page.getByRole('button', { name: 'Search', exact: true }).click(),
    ]);
    return response;
  }

  async reload() {
    await this.page.reload();
  }

  async goto() {
    return this.page.goto('/orders');
  }

  async goHome() {
    await this.page
      .getByRole('link', { name: 'SABLE home', exact: true })
      .click();
    await this.page.waitForURL((url) => url.pathname === '/');
  }

  async signOut() {
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/auth/logout' &&
          response.request().method() === 'POST',
      ),
      this.page.getByRole('button', { name: 'Sign out', exact: true }).click(),
    ]);
    await this.page.waitForURL((url) => url.pathname === '/login');
    return response;
  }
}
