import { test, expect } from './fixtures/app';

test.use({ modelReply: 'Which shipment should I trace?' });

for (const width of [320, 1280]) {
  test(`preserves message whitespace and effective styles at ${width}px`, async ({
    page,
    loginPage,
    supportPage,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await loginPage.goto();
    await loginPage.signIn('mara.venn@calderpike.example', 'Sable-WHS-0427!');
    if (width < 768) await supportPage.openNavigation();
    await supportPage.startIncident();
    const question = 'Trace this shipment.\n\n  Keep these spaces.';
    expect((await supportPage.sendMessage(question)).status()).toBe(200);
    await expect(supportPage.messages).toHaveCount(2);
    const customerText = page.locator('.chat-message--user .message-bubble p');
    expect(await customerText.textContent()).toBe(question);
    const styles = await page
      .locator('.message-bubble')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            background: style.backgroundColor,
            color: style.color,
            border: style.border,
            radius: style.borderRadius,
            shadow: style.boxShadow,
            whiteSpace: style.whiteSpace,
            fontSize: style.fontSize,
            padding: style.padding,
          };
        }),
      );
    const size =
      width < 768
        ? { fontSize: '12px', padding: '11px 12px' }
        : { fontSize: '13px', padding: '13px 15px' };
    expect(styles).toEqual([
      {
        ...size,
        background: 'rgb(48, 39, 25)',
        color: 'rgb(241, 216, 173)',
        border: '1px solid rgb(140, 104, 47)',
        radius: '0px',
        shadow: 'rgba(28, 52, 67, 0.13) 0px 7px 20px 0px',
        whiteSpace: 'pre-wrap',
      },
      {
        ...size,
        background: 'rgb(10, 21, 24)',
        color: 'rgb(231, 238, 233)',
        border: '1px solid rgb(40, 66, 62)',
        radius: '0px',
        shadow: 'rgba(0, 0, 0, 0.18) 0px 8px 24px 0px',
        whiteSpace: 'normal',
      },
    ]);
    for (const author of await page.locator('.chat-message__meta strong').all())
      await expect(author).toHaveCSS('color', 'rgb(231, 238, 233)');
    await page.screenshot({ path: `reports/message-styles-${width}.png` });
  });
}
