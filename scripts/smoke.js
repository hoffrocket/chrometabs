#!/usr/bin/env node
/**
 * End-to-end smoke check against the *real* installed Google Chrome (rather
 * than Playwright's bundled Chromium), plus a screenshot of the options page.
 *
 *   node scripts/smoke.js [--screenshot out.png]
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));

// Chrome 151 stable dropped support for --load-extension, so an unpacked
// extension can only be side-loaded into Chrome for Testing (which is what
// `channel: 'chromium'` resolves to). Override with CHROME_PATH if you have a
// build that still allows it.
const executablePath = process.env.CHROME_PATH || chromium.executablePath();
if (!fs.existsSync(executablePath)) {
  console.error(`Chrome not found at ${executablePath}; run: npx playwright install chromium`);
  process.exit(1);
}

const shotIndex = process.argv.indexOf('--screenshot');
const shotPath = shotIndex !== -1 ? process.argv[shotIndex + 1] : null;

const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'tab-reaper-smoke-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const version = await worker.evaluate(() => chrome.runtime.getManifest().version);
  console.log(`Service worker registered in real Chrome (extension v${version}).`);

  await context.route(/^https?:\/\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }),
  );

  await worker.evaluate(() =>
    chrome.storage.sync.set({ enabled: true, idleMinutes: 30, allowlist: ['keep.test'] }),
  );

  const ids = await worker.evaluate(async () => {
    const made = await Promise.all([
      chrome.tabs.create({ url: 'https://stale.test/', active: false }),
      chrome.tabs.create({ url: 'https://keep.test/', active: false }),
      chrome.tabs.create({ url: 'https://pinned.test/', active: false, pinned: true }),
    ]);
    const [stale, keep, pinned] = made.map((t) => t.id);
    return { stale, keep, pinned };
  });

  // chrome.tabs.onCreated writes a fresh timestamp asynchronously; let those
  // writes land before backdating, or they will clobber the backdated values.
  await new Promise((resolve) => setTimeout(resolve, 750));
  await worker.evaluate(async (ids) => {
    const stored = await chrome.storage.session.get('lastActive');
    const activity = stored.lastActive ?? {};
    for (const id of Object.values(ids)) activity[id] = Date.now() - 60 * 60_000;
    await chrome.storage.session.set({ lastActive: activity });
  }, ids);

  const result = await worker.evaluate(() => self.__tabReaper.sweep());
  const closed = result.closed;
  console.log(`Sweep closed ${closed.length} tab(s).`);

  if (!closed.includes(ids.stale)) fail('the stale tab was not closed');
  if (closed.includes(ids.keep)) fail('an allowlisted tab was closed');
  if (closed.includes(ids.pinned)) fail('a pinned tab was closed');
  if (process.exitCode !== 1) console.log('Reaping behaviour correct in real Chrome.');

  if (shotPath) {
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.setViewportSize({ width: 640, height: 720 });
    await page.goto(`chrome-extension://${id}/options.html`);
    await page.waitForSelector('#idleHint:not(:empty)');
    await page.screenshot({ path: shotPath });
    console.log(`Screenshot written to ${shotPath}`);
  }
} finally {
  await context.close();
  await fsp.rm(profile, { recursive: true, force: true });
}
