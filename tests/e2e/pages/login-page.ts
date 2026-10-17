import { expect, type Page } from '@playwright/test';

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

  // The form re-renders its controlled inputs while the session check runs,
  // which can clear values typed earlier. Wait until it accepts input, and
  // confirm both values before submitting.
  async signIn(email: string, password: string, destination = '/support') {
    const submit = this.page.getByRole('button', {
      name: 'Enter authorized channel',
      exact: true,
    });
    const emailInput = this.page.getByLabel('Authorized email');
    const passwordInput = this.page.getByLabel('Access phrase');
    await expect(submit).toBeEnabled();
    await emailInput.fill(email);
    await passwordInput.fill(password);
    await expect(emailInput).toHaveValue(email);
    await expect(passwordInput).toHaveValue(password);
    await submit.click();
    await this.page.waitForURL(
      (url) => url.pathname + url.search === destination,
    );
  }
}
