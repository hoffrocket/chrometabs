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

  // Each icon must be the size it is declared under. Chrome scales a mismatched
  // icon silently, so this went unnoticed until the store rejected the
  // dimensions: the rasterizer rendered at 4x without downscaling and every
  // icon shipped at 4x its declared size, quadrupling the package for nothing.
  const declaredSizes = { ...(manifest.icons ?? {}), ...(manifest.action?.default_icon ?? {}) };
  for (const [size, relative] of Object.entries(declaredSizes)) {
    const actual = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    }, `chrome-extension://${extensionId}/${relative}`);
    expect(actual, `${relative} is declared as ${size}px`).toEqual({
      width: Number(size),
      height: Number(size),
    });
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

  // Assert the value actually landed, not just that the page said "Saved.".
  // This test used to flake because load() overwrote the typed 1 with the
  // stored 720 and saved that instead, so the sweep found nothing idle while
  // every visible signal looked right.
  expect(await ext.getSettings()).toMatchObject({ idleMinutes: 1 });

  const doomed = await ext.openTab('https://doomed.test/');
  await ext.markIdle(doomed, 10 * 60_000);

  await page.click('#reapNow');

  await expect(page.locator('#status')).toContainText('Closed 1 tab');
  expect((await ext.tabs()).map((t) => t.id)).not.toContain(doomed);
});

test('the form does not clobber input typed while settings are still loading', async ({
  context,
  extensionId,
  ext,
}) => {
  // Stall the settings read so the load is unambiguously still in flight when
  // the test interacts with the form. Without the disabled-until-loaded guard,
  // a value typed in this window is silently overwritten when load() resolves
  // — and then saved, so the user's edit is lost with no error.
  //
  // The read is issued immediately and only its *resolution* is delayed. If the
  // stub instead deferred the read itself, it would observe storage as of
  // t+1000ms — i.e. after this test's save — and render the new value anyway,
  // masking the very clobbering being tested.
  //
  // `window.__readResolved` lets the assertions wait for the stalled read to
  // land rather than sleeping — the damage only becomes visible at that moment.
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__readResolved = false;
    const original = chrome.storage.sync.get.bind(chrome.storage.sync);
    chrome.storage.sync.get = (...args) => {
      const inFlight = original(...args);
      return new Promise((resolve) =>
        setTimeout(() => {
          window.__readResolved = true;
          resolve(inFlight);
        }, 1000),
      );
    };
  });
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  // While loading, the controls are inert and marked as such.
  await expect(page.locator('body')).toHaveAttribute('data-loading', '');
  await expect(page.locator('#idleMinutes')).toBeDisabled();
  await expect(page.locator('#save')).toBeDisabled();

  // fill() waits for the field to become enabled, so this types *after* load().
  await page.fill('#idleMinutes', '5');
  await page.click('#save');
  await expect(page.locator('#status')).toHaveText('Saved.');
  expect(await ext.getSettings()).toMatchObject({ idleMinutes: 5 });

  // The stalled read has now resolved, so a load() that ignored the edit would
  // have overwritten the field with the pre-edit value by this point.
  await page.waitForFunction(() => window.__readResolved === true);
  await expect(page.locator('#idleMinutes')).toHaveValue('5');

  // And the reverted field would be written straight back on the next save,
  // which is how the edit gets lost for real.
  await page.click('#save');
  await expect(page.locator('#status')).toHaveText('Saved.');
  expect(await ext.getSettings()).toMatchObject({ idleMinutes: 5 });
});
