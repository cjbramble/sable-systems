import type { Page } from '@playwright/test';

export class HomePage {
  constructor(private readonly page: Page) {}

  get ordersLink() {
    return this.page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Orders', exact: true });
  }

  async openOrders() {
    await this.ordersLink.click();
  }
}
