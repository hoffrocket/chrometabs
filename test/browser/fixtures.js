import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { test as base, chromium, expect } from '@playwright/test';

const EXTENSION_PATH = fileURLToPath(new URL('../../extension', import.meta.url));

/**
 * Playwright fixture that launches a real Chrome with the unpacked extension
 * loaded, and exposes helpers for talking to the service worker.
 *
 * MV3 extensions require a persistent context — there is no way to load an
 * unpacked extension into an incognito-style ephemeral context.
 */
export const test = base.extend({
  context: async ({}, use, testInfo) => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-reaper-'));
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    await use(context);

    await context.close();
    if (testInfo.status === testInfo.expectedStatus) {
      await fs.rm(profileDir, { recursive: true, force: true });
    }
  },

  // The MV3 service worker, awaited so tests never race extension startup.
  worker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },

  /** Helpers that run inside the extension's own context, so they have
   *  privileged access to the chrome.* APIs. */
  ext: async ({ worker }, use) => {
    const helpers = {
      /** Overwrite the extension's settings. */
      async setSettings(settings) {
        await worker.evaluate(async (s) => {
          await chrome.storage.sync.clear();
          await chrome.storage.sync.set(s);
        }, settings);
      },

      async getSettings() {
        return worker.evaluate(() => chrome.storage.sync.get(null));
      },

      /** Pretend a tab has not been touched for `ageMs`. Goes through the
       *  worker's own update queue so pending onCreated/onActivated writes
       *  cannot clobber the backdated timestamp. */
      async markIdle(tabId, ageMs) {
        await worker.evaluate(
          ({ tabId, ageMs }) =>
            self.__tabReaper.updateActivity((activity) => {
              activity[tabId] = Date.now() - ageMs;
            }),
          { tabId, ageMs },
        );
      },

      /**
       * Mark every tab as idle for `ageMs`.
       *
       * This deliberately backdates *all* tabs, including the active one.
       * Skipping the active tab made the helper depend on which tab happened
       * to hold focus — opening pages and reloading shifts that around, so
       * the tab a test wanted backdated sometimes wasn't, and the test failed
       * intermittently. Backdating everything is safe because sweep() re-stamps
       * active tabs before deciding anything, and the active tab is exempt
       * regardless.
       */
      async markAllIdle(ageMs) {
        await worker.evaluate(
          (ageMs) =>
            self.__tabReaper.updateActivity(async (activity) => {
              const tabs = await chrome.tabs.query({});
              const backdated = Date.now() - ageMs;
              for (const tab of tabs) {
                activity[tab.id] = backdated;
              }
            }),
          ageMs,
        );
      },

      /** Trigger a sweep and return its result. Calls the worker's own sweep()
       *  directly, since a service worker does not receive its own messages. */
      async sweep() {
        return worker.evaluate(() => self.__tabReaper.sweep());
      },

      /** [{id, url, active, pinned}] for every open tab. */
      async tabs() {
        return worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          return tabs.map((t) => ({
            id: t.id,
            url: t.url,
            active: t.active,
            pinned: t.pinned,
          }));
        });
      },

      /**
       * Open a tab via the chrome API so the extension sees onCreated, and
       * wait until the extension has recorded it.
       *
       * The wait matters: `chrome.tabs.create` resolves as soon as the tab
       * exists, but the extension's onCreated listener writes its timestamp
       * asynchronously afterwards. Without this, a `markIdle` call can be
       * queued *before* that write and get overwritten by it, leaving the tab
       * looking freshly used. Serializing the queue makes each update atomic
       * but does not order them, so the wait has to happen here.
       */
      async openTab(url, { pinned = false } = {}) {
        const tabId = await worker.evaluate(
          ({ url, pinned }) =>
            chrome.tabs.create({ url, pinned, active: false }).then((t) => t.id),
          { url, pinned },
        );

        await expect
          .poll(
            () =>
              worker.evaluate(
                (id) => self.__tabReaper.readActivity().then((a) => a[String(id)] !== undefined),
                tabId,
              ),
            { message: `extension never recorded tab ${tabId} (${url})` },
          )
          .toBe(true);

        return tabId;
      },

      async pin(tabId) {
        await worker.evaluate((tabId) => chrome.tabs.update(tabId, { pinned: true }), tabId);
      },

      async activate(tabId) {
        await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), tabId);
      },
    };
    await use(helpers);
  },
});

export { expect };
