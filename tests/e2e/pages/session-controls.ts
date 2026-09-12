import type { Page } from '@playwright/test';

export class SessionControls {
  constructor(private readonly page: Page) {}

  get signOutButton() {
    return this.page.getByRole('button', { name: 'Sign out', exact: true });
  }

  get error() {
    return this.page
      .getByRole('alert')
      .filter({ hasText: 'Sign-out could not be confirmed.' });
  }

  async signOut() {
    await this.signOutButton.click();
  }
}
