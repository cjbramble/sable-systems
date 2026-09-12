import type { Page } from '@playwright/test';

import { SupportMessage } from './support-message';
import { SessionControls } from './session-controls';

export class SupportPage {
  readonly session: SessionControls;
  constructor(private readonly page: Page) {
    this.session = new SessionControls(page);
  }

  get runtimeStatus() {
    return this.page.getByRole('status', { name: 'Model connection' });
  }

  get incidents() {
    return this.page.getByRole('navigation', {
      name: 'Open service incidents',
    });
  }

  get messageEntries() {
    return this.page.getByRole('article');
  }

  get messages() {
    return this.messageEntries.locator('.message-bubble');
  }

  messageContaining(text: string) {
    return new SupportMessage(this.messages.filter({ hasText: text }));
  }

  get requestError() {
    return this.page.getByRole('alert');
  }

  get messageInput() {
    return this.page.getByRole('textbox', { name: 'Message COV-E' });
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
    await this.messageInput.fill(content);
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

  async title() {
    return this.page.title();
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

  async deleteIncident(title: string, decision: 'cancel' | 'confirm') {
    // Register both listeners before clicking; native dialogs block page code
    // until handled, and a confirmed deletion may respond immediately.
    const dialogHandled = this.page
      .waitForEvent('dialog')
      .then(async (dialog) => {
        const prompt = { type: dialog.type(), message: dialog.message() };
        if (decision === 'confirm') await dialog.accept();
        else await dialog.dismiss();
        return prompt;
      });
    const response =
      decision === 'confirm'
        ? this.page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/incidents' &&
              response.request().method() === 'DELETE',
          )
        : Promise.resolve(null);
    const [prompt, deletionResponse] = await Promise.all([
      dialogHandled,
      response,
      this.incidents
        .getByRole('button', { name: `Delete ${title}`, exact: true })
        .click(),
    ]);
    return { prompt, response: deletionResponse };
  }
}
