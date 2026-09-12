import type { Page } from '@playwright/test';

export class LoginPage {
  constructor(private readonly page: Page) {}

  get heading() {
    return this.page.getByRole('heading', {
      name: 'Verify identity',
      exact: true,
    });
  }

  async goto(destination = '/support') {
    return this.page.goto(`/login?next=${encodeURIComponent(destination)}`);
  }

  async goHome() {
    await this.page
      .getByRole('link', { name: 'Return to SABLE Systems' })
      .click();
    await this.page.waitForURL((url) => url.pathname === '/');
  }

  async signIn(email: string, password: string, destination = '/support') {
    await this.page.getByLabel('Authorized email').fill(email);
    await this.page.getByLabel('Access phrase').fill(password);
    await this.page
      .getByRole('button', { name: 'Enter authorized channel', exact: true })
      .click();
    await this.page.waitForURL(
      (url) => url.pathname + url.search === destination,
    );
  }
}
