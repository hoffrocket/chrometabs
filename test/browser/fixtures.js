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

      /**
       * Trigger a sweep and return its result. Calls the worker's own sweep()
       * directly, since a service worker does not receive its own messages.
       *
       * The result carries a `why` string summarizing the extension's own
       * verdict for each surviving tab. A bare "expected [1234], received []"
       * says nothing about *why* a tab survived, and these tests failed on CI
       * for a reason (`internal-page`, from an uncommitted URL) that the
       * verdicts would have named immediately.
       */
      async sweep() {
        const result = await worker.evaluate(() => self.__tabReaper.sweep());
        const why = (result.kept ?? [])
          .map(
            (v) =>
              `#${v.tabId} ${v.reason}` +
              ` idle=${Math.round(v.idleMs / 1000)}s/${v.thresholdMinutes}m` +
              (v.matchedRule ? ` rule=${v.matchedRule}` : ''),
          )
          .join('  |  ');
        return { ...result, why: `kept: ${why || '(nothing)'}` };
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

        // Wait for two separate things, both of which have bitten:
        //
        // 1. The extension has recorded the tab. onCreated writes the
        //    timestamp asynchronously after tabs.create resolves, so a
        //    markIdle queued before that write would be overwritten by it.
        //
        // 2. The tab's URL has committed to http(s). chrome.tabs.create
        //    resolves while the tab is still on about:blank, and the reaper
        //    only reaps http(s) tabs — so sweeping too early keeps the tab as
        //    an `internal-page` and the test sees nothing closed.
        await expect
          .poll(
            () =>
              worker.evaluate(async (id) => {
                const activity = await self.__tabReaper.readActivity();
                const recorded = activity[String(id)] !== undefined;
                let tabUrl = '';
                try {
                  tabUrl = (await chrome.tabs.get(id)).url ?? '';
                } catch {
                  return 'tab-gone';
                }
                if (!recorded) return 'not-recorded';
                if (!/^https?:/.test(tabUrl)) return `url-not-committed:${tabUrl || 'empty'}`;
                return 'ready';
              }, tabId),
            { message: `tab ${tabId} (${url}) never became reapable`, timeout: 15_000 },
          )
          .toBe('ready');

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
