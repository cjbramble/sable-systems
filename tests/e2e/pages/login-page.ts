import type { Page } from '@playwright/test';

export class LoginPage {
  constructor(private readonly page: Page) {}

  async goto() {
    return this.page.goto('/login?next=/support');
  }

  async signIn(email: string, password: string) {
    await this.page.getByLabel('Authorized email').fill(email);
    await this.page.getByLabel('Access phrase').fill(password);
    await this.page
      .getByRole('button', { name: 'Enter authorized channel', exact: true })
      .click();
    await this.page.waitForURL('**/support');
  }
}
