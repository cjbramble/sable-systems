import type { Locator } from '@playwright/test';

// A message-scoped page component, reusable before and after history reloads.
export class SupportMessage {
  constructor(readonly bubble: Locator) {}

  get headings() {
    return this.bubble.getByRole('heading');
  }

  get strongText() {
    return this.bubble.locator('strong');
  }

  get emphasizedText() {
    return this.bubble.locator('em');
  }

  get code() {
    return this.bubble.locator('code');
  }

  get listItems() {
    return this.bubble.getByRole('listitem');
  }

  get tableHeaders() {
    return this.bubble.getByRole('columnheader');
  }

  get tableCells() {
    return this.bubble.getByRole('cell');
  }

  get embeddedHtml() {
    return this.bubble.locator('script, img, iframe');
  }

  link(name: string) {
    return this.bubble.getByRole('link', { name, exact: true });
  }
}
