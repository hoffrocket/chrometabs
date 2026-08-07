import { test, expect } from './fixtures.js';

const MINUTE = 60_000;

// The extension only reaps http/https, so the tests need real-looking URLs.
// Rather than hit the network, every http(s) request is fulfilled locally with
// a stub page. Note the http/https-only pattern: a bare '**/*' would also
// intercept chrome-extension:// loads and break the options page.
async function stubNetwork(context) {
  await context.route(/^https?:\/\//, (route) => {
    const url = new URL(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><title>${url.hostname}</title><h1>${url.hostname}</h1>`,
    });
  });
}

test.beforeEach(async ({ context }) => {
  await stubNetwork(context);
});

test('closes a tab that has been idle past the threshold', async ({ ext }) => {
  await ext.setSettings({ enabled: true, idleMinutes: 30, allowlist: [] });

  const staleId = await ext.openTab('https://stale.test/');
  await expect.poll(async () => (await ext.tabs()).some((t) => t.id === staleId)).toBe(true);

  await ext.markIdle(staleId, 31 * MINUTE);
  const result = await ext.sweep();

  expect(result.closed).toContain(staleId);
  const remaining = await ext.tabs();
  expect(remaining.map((t) => t.id)).not.toContain(staleId);
});

test('keeps a tab that is still within the threshold', async ({ ext }) => {
  await ext.setSettings({ enabled: true, idleMinutes: 30, allowlist: [] });

  const freshId = await ext.openTab('https://fresh.test/');
  await ext.markIdle(freshId, 5 * MINUTE);

  const result = await ext.sweep();

  expect(result.closed).not.toContain(freshId);
  expect((await ext.tabs()).map((t) => t.id)).toContain(freshId);
});

test('never closes the active tab, however stale it looks', async ({ ext }) => {
  await ext.setSettings({ enabled: true, idleMinutes: 1, allowlist: [] });

  const id = await ext.openTab('https://active.test/');
  await ext.activate(id);
  await ext.markIdle(id, 999 * MINUTE);

  const result = await ext.sweep();

  expect(result.closed).not.toContain(id);
  const active = (await ext.tabs()).find((t) => t.id === id);
  expect(active).toBeTruthy();
});

test('never closes a pinned tab', async ({ ext }) => {
  await ext.setSettings({ enabled: true, idleMinutes: 1, allowlist: [] });

  const pinnedId = await ext.openTab('https://pinned.test/', { pinned: true });
  const normalId = await ext.openTab('https://normal.test/');
  await ext.markAllIdle(60 * MINUTE);

  const result = await ext.sweep();

  expect(result.closed).not.toContain(pinnedId);
  expect(result.closed).toContain(normalId);
  expect((await ext.tabs()).map((t) => t.id)).toContain(pinnedId);
});

test('never closes an allowlisted host, including via wildcard', async ({ ext }) => {
  await ext.setSettings({
    enabled: true,
    idleMinutes: 1,
    allowlist: ['keep.test', '*.wild.test'],
  });

  const exactId = await ext.openTab('https://keep.test/a');
  const subId = await ext.openTab('https://deep.wild.test/b');
  const otherId = await ext.openTab('https://reapme.test/c');
  await ext.markAllIdle(60 * MINUTE);

  const result = await ext.sweep();

  expect(result.closed).not.toContain(exactId);
  expect(result.closed).not.toContain(subId);
  expect(result.closed).toContain(otherId);
});

test('closes nothing while disabled', async ({ ext }) => {
  await ext.setSettings({ enabled: false, idleMinutes: 1, allowlist: [] });

  const id = await ext.openTab('https://stale.test/');
  await ext.markAllIdle(999 * MINUTE);

  const result = await ext.sweep();

  expect(result.closed).toEqual([]);
  expect((await ext.tabs()).map((t) => t.id)).toContain(id);
});

test('a burst of new tabs all get recorded (no lost-update race)', async ({ ext, worker }) => {
  await ext.setSettings({ enabled: true, idleMinutes: 30, allowlist: [] });

  // Opening many tabs at once fires a burst of onCreated events, each of which
  // is a read-modify-write on the activity map. If those interleave, some tabs
  // end up with no timestamp at all.
  const ids = await worker.evaluate(async () => {
    const made = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        chrome.tabs.create({ url: `https://burst-${i}.test/`, active: false }),
      ),
    );
    return made.map((t) => t.id);
  });

  await expect
    .poll(async () => {
      const activity = await worker.evaluate(() => self.__tabReaper.readActivity());
      return ids.filter((id) => activity[String(id)] !== undefined).length;
    })
    .toBe(ids.length);
});

test('activating a stale tab resets its idle clock', async ({ ext }) => {
  await ext.setSettings({ enabled: true, idleMinutes: 30, allowlist: [] });

  const parked = await ext.openTab('https://parked.test/');
  const revisited = await ext.openTab('https://revisited.test/');
  await ext.markAllIdle(60 * MINUTE);

  // Visiting the tab fires chrome.tabs.onActivated, which should refresh it.
  await ext.activate(revisited);
  // Move focus away so `revisited` is no longer the active tab and therefore
  // has to survive on its refreshed timestamp alone.
  await ext.activate(parked);
  await ext.markIdle(parked, 60 * MINUTE);

  const result = await ext.sweep();

  expect(result.closed).not.toContain(revisited);
});
