import type { Page } from '@playwright/test';

export class SupportPage {
  constructor(private readonly page: Page) {}

  get incidents() {
    return this.page.getByRole('navigation', {
      name: 'Open service incidents',
    });
  }

  get messages() {
    return this.page.getByRole('article').locator('.message-bubble');
  }

  get incidentTitles() {
    return this.incidents.getByRole('button').locator('strong');
  }

  get incidentSearch() {
    return this.page.getByRole('searchbox', {
      name: 'Search service incidents',
    });
  }

  incident(title: string) {
    return this.incidents.getByRole('button').filter({
      has: this.page.getByText(title, { exact: true }),
    });
  }

  async startIncident() {
    await this.page
      .getByRole('button', { name: 'New service incident' })
      .click();
  }

  async sendMessage(content: string) {
    await this.page
      .getByRole('textbox', { name: 'Message COV-E' })
      .fill(content);
    const response = this.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/chat' &&
        response.request().method() === 'POST',
    );
    await this.page.getByRole('button', { name: 'Send message' }).click();
    return response;
  }

  async reload() {
    await this.page.reload();
  }

  async openIncident(title: string) {
    await this.incident(title).click();
  }

  async searchIncidents(query: string) {
    await this.incidentSearch.fill(query);
  }

  async clearIncidentSearch() {
    await this.incidentSearch.clear();
  }
}
