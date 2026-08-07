import { test, expect } from './fixtures.js';

test('options page saves settings and the service worker reads them back', async ({
  context,
  extensionId,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await expect(page.locator('#enabled')).toBeChecked();
  await expect(page.locator('#idleMinutes')).toHaveValue('60');

  await page.fill('#idleMinutes', '15');
  await page.fill('#allowlist', 'Example.com\n*.google.com\nexample.com');
  await page.click('#save');

  await expect(page.locator('#status')).toHaveText('Saved.');
  // Duplicates and casing are normalized on save.
  await expect(page.locator('#allowlist')).toHaveValue('example.com\n*.google.com');

  expect(await ext.getSettings()).toMatchObject({
    enabled: true,
    idleMinutes: 15,
    allowlist: ['example.com', '*.google.com'],
  });
});

test('options page rejects a non-positive interval', async ({ context, extensionId, ext }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.fill('#idleMinutes', '0');
  await page.click('#save');

  await expect(page.locator('#status')).toContainText('greater than 0');
  expect(await ext.getSettings()).not.toMatchObject({ idleMinutes: 0 });
});

test('settings survive a reload of the options page', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.uncheck('#enabled');
  await page.fill('#idleMinutes', '240');
  await page.click('#save');
  await expect(page.locator('#status')).toHaveText('Saved.');

  await page.reload();

  await expect(page.locator('#enabled')).not.toBeChecked();
  await expect(page.locator('#idleMinutes')).toHaveValue('240');
});

test('"Reap now" closes idle tabs from the options page', async ({
  context,
  extensionId,
  ext,
}) => {
  // http(s) only — a bare '**/*' would also intercept the options page itself.
  await context.route(/^https?:\/\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }),
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.fill('#idleMinutes', '1');
  await page.click('#save');
  await expect(page.locator('#status')).toHaveText('Saved.');

  const doomed = await ext.openTab('https://doomed.test/');
  await ext.markIdle(doomed, 10 * 60_000);

  await page.click('#reapNow');

  await expect(page.locator('#status')).toContainText('Closed 1 tab');
  expect((await ext.tabs()).map((t) => t.id)).not.toContain(doomed);
});
