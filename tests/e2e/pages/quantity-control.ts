import type { Locator } from '@playwright/test';

export class QuantityControl {
  constructor(private readonly root: Locator) {}

  get decrease() {
    return this.root.getByRole('button', { name: /^Remove \d+ / });
  }

  get increase() {
    return this.root.getByRole('button', { name: /^Add \d+ / });
  }

  get value() {
    return this.root.locator('strong');
  }
}
