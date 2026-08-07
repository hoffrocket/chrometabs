# Tab Reaper

A Chrome extension that automatically closes tabs you haven't used for a
configurable amount of time.

The extension itself uses **no third-party libraries** — only the official
`chrome.*` extension APIs. Playwright appears solely as a `devDependency` for
driving a real browser in the tests; nothing in `extension/` imports it.

## What it does

A tab is closed when it has not been the active tab for longer than the
configured idle period. A tab is **kept** when it is:

| Reason | Detail |
| --- | --- |
| `active` | It's the tab you're looking at in its window. |
| `pinned` | Pinning is the "keep this forever" gesture. |
| `internal-page` | Only `http:` / `https:` tabs are reaped, so `chrome://`, `about:`, and extension pages are safe. |
| `allowlisted` | Its hostname matches your allowlist. |
| `not-idle-long-enough` | It's been used more recently than the threshold. |
| `disabled` | The extension is switched off. |

Closed tabs are not logged anywhere — use Chrome's own **Reopen closed tab**
(`⇧⌘T` / `Ctrl+Shift+T`) or History to get one back.

## Settings

Open the options page (click the toolbar icon, or `chrome://extensions` →
Tab Reaper → Details → Extension options):

- **Automatically close idle tabs** — master on/off switch.
- **Idle timeout** — minutes of non-use before a tab is closed. Default 60.
- **Never close these sites** — one hostname per line. Prefix with `*.` to
  include subdomains:

  ```
  example.com        # exactly example.com
  *.google.com       # google.com and any subdomain
  ```

- **Reap now** — run a sweep immediately, instead of waiting for the next tick.

## Trying it by hand

```sh
npm install
npx playwright install chromium   # one-time browser download
npm run chrome
```

This opens a **separate, disposable Chrome** with the extension side-loaded and
its own profile in `.chrome-dev-profile/` — your everyday browser and its tabs
are never touched. Delete that directory to reset.

> **Note on Chrome versions:** Chrome 151 stable removed the
> `--load-extension` command-line switch, so scripted side-loading only works
> in the Chrome for Testing build that `npx playwright install chromium`
> downloads. That is what `npm run chrome` uses. To try it in your *real*
> Chrome, load `extension/` manually via `chrome://extensions` → **Developer
> mode** → **Load unpacked**. Set `CHROME_PATH` to override the binary.

Testing a 60-minute timeout by waiting an hour is no fun. Either set the
timeout to 1 minute, or backdate a tab from the service worker console
(`chrome://extensions` → Tab Reaper → **service worker**):

```js
// Make every inactive tab look an hour old, then sweep.
await self.__tabReaper.updateActivity(async (activity) => {
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.active) activity[tab.id] = Date.now() - 3600_000;
  }
});
await self.__tabReaper.sweep();
```

## Tests

```sh
npm test            # unit + browser
npm run test:unit   # pure logic, node:test, no browser
npm run test:browser
node scripts/smoke.js --screenshot /tmp/options.png
```

- `test/unit/` exercises `extension/lib/reaper.js`, which holds all the
  reaping decisions and touches no `chrome.*` API — so the threshold, allowlist
  and exemption rules are testable in plain Node.
- `test/browser/` loads the real extension into a real Chrome via Playwright
  and drives it through the actual `chrome.tabs` API: opening tabs, pinning,
  activating, sweeping, and asserting which tabs survive. `test/browser/fixtures.js`
  provides the `ext` helper that runs code inside the extension's own context.
- `scripts/smoke.js` is a single end-to-end pass, handy for a screenshot.

## Layout

```
extension/
  manifest.json     MV3 manifest — permissions: tabs, storage, alarms
  background.js     service worker: tracks tab activity, runs sweeps
  lib/reaper.js     pure decision logic (no chrome.* — unit tested)
  options.html/.css/.js   settings UI
test/
  unit/             node:test over lib/reaper.js
  browser/          Playwright tests driving real Chrome
scripts/
  launch-chrome.js  disposable Chrome for manual poking
  smoke.js          end-to-end check + screenshot
```

## Implementation notes

- **Activity lives in `chrome.storage.session`, not a variable.** MV3 service
  workers are killed and restarted at Chrome's discretion, so an in-memory
  `Map` of tab timestamps would vanish. `storage.session` is cleared on browser
  restart, which is the lifetime we want anyway.
- **Updates to the activity map are serialized.** Each update is a
  read-modify-write against storage, and tab events arrive in bursts (opening
  ten tabs fires ten `onCreated` events). Unserialized, later writes clobber
  earlier ones with a stale copy of the map — dropping timestamps so tabs look
  either immortal or instantly stale. `updateActivity()` funnels all mutations
  through one promise chain; `test/browser/idle-close.spec.js` has a regression
  test that fails without it.
- **Tabs with no recorded timestamp are treated as just-used**, so a freshly
  installed or restarted extension never mass-closes long-standing tabs.
- **A `chrome.alarms` tick drives sweeps**, not `setTimeout` — timers do not
  survive service-worker eviction.
