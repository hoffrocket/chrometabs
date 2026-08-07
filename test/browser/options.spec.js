import { test, expect } from './fixtures.js';

test('options page saves settings and the service worker reads them back', async ({
  context,
  extensionId,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await expect(page.locator('#enabled')).toBeChecked();
  await expect(page.locator('#idleMinutes')).toHaveValue('720');

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

test('the manifest declares icons that Chrome can actually load', async ({
  context,
  extensionId,
  worker,
}) => {
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  const declared = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ];
  expect(declared.length).toBeGreaterThan(0);

  // A missing icon file is a silent failure in the toolbar, so fetch each one.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  for (const relative of new Set(declared)) {
    const status = await page.evaluate(
      (url) => fetch(url).then((r) => r.status),
      `chrome-extension://${extensionId}/${relative}`,
    );
    expect(status, `${relative} should be fetchable`).toBe(200);
  }

  // The options header renders the same art; naturalWidth stays 0 if it 404s.
  const header = await page.evaluate(() => {
    const img = document.querySelector('h1 img');
    return { present: Boolean(img), width: img?.naturalWidth ?? 0 };
  });
  expect(header.present).toBe(true);
  expect(header.width).toBeGreaterThan(0);
});

test('the shipped default timeout is 12 hours', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await expect(page.locator('#idleMinutes')).toHaveValue('720');
  await expect(page.locator('#idleHint')).toContainText('12 hours');
});

test('options page saves per-domain rules and echoes how they parsed', async ({
  context,
  extensionId,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.fill('#rules', '*.zoom.us = 10\ndocs.google.com: 2880\ngarbage line');
  await expect(page.locator('#rulesHint')).toContainText('*.zoom.us after 10 minutes');
  await expect(page.locator('#rulesHint')).toContainText('docs.google.com after 2 days');
  await expect(page.locator('#rulesHint')).toContainText('1 line ignored');

  await page.click('#save');
  await expect(page.locator('#status')).toHaveText('Saved.');

  // The invalid line is dropped and the rest normalized to `pattern = minutes`.
  await expect(page.locator('#rules')).toHaveValue('*.zoom.us = 10\ndocs.google.com = 2880');
  expect(await ext.getSettings()).toMatchObject({
    rules: [
      { pattern: '*.zoom.us', minutes: 10 },
      { pattern: 'docs.google.com', minutes: 2880 },
    ],
  });
});

test('per-domain rules survive a reload and reach the reaper', async ({
  context,
  extensionId,
  ext,
}) => {
  await context.route(/^https?:\/\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }),
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.fill('#idleMinutes', '720');
  await page.fill('#rules', '*.zoom.us = 10');
  await page.click('#save');
  await expect(page.locator('#status')).toHaveText('Saved.');

  await page.reload();
  await expect(page.locator('#rules')).toHaveValue('*.zoom.us = 10');

  // A rule entered through the UI actually governs a sweep.
  const zoomId = await ext.openTab('https://call.zoom.us/j/9');
  const otherId = await ext.openTab('https://elsewhere.test/');
  await ext.markAllIdle(30 * 60_000);

  const result = await ext.sweep();
  expect(result.closed).toContain(zoomId);
  expect(result.closed).not.toContain(otherId);
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
