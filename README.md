![Tab Reaper](assets/icon.svg)

# Tab Reaper

[![Tests](https://github.com/hoffrocket/chrometabs/actions/workflows/test.yml/badge.svg)](https://github.com/hoffrocket/chrometabs/actions/workflows/test.yml)

A Chrome extension that automatically closes tabs you haven't used in a while.
Browser tab hygiene, on a timer: the tabs you actually use stay, the ones you
opened yesterday and forgot don't.

The extension uses **no third-party libraries** — only the official `chrome.*`
extension APIs. Playwright appears solely as a `devDependency` for driving a
real browser in the tests; nothing under `extension/` imports it.

- [What it does](#what-it-does)
- [Installing in your own Chrome](#installing-in-your-own-chrome)
- [Settings](#settings)
- [Development workflow](#development-workflow)
- [Privacy](#privacy)
- [Releasing](#releasing)
- [Layout](#layout)
- [Implementation notes](#implementation-notes)

## What it does

Every minute, the extension checks each open tab. A tab is closed when it has
not been the active tab for longer than its idle threshold — the global timeout
(**12 hours** by default), or a per-domain override if one matches.

A tab is **kept** when it is:

| Reason | Detail |
| --- | --- |
| `active` | It's the tab you're looking at in its window. |
| `pinned` | Pinning is the "keep this forever" gesture. |
| `internal-page` | Only `http:` / `https:` tabs are reaped, so `chrome://`, `about:`, and extension pages are safe. |
| `allowlisted` | Its hostname matches your never-close list. |
| `not-idle-long-enough` | It's been used more recently than its threshold. |
| `disabled` | The extension is switched off. |

Tabs closed by a per-domain override report `idle-by-rule` along with the
pattern that matched, rather than a bare `idle`.

**Closed tabs are not logged anywhere.** Recovery is Chrome's own **Reopen
closed tab** (`⇧⌘T` / `Ctrl+Shift+T`) or History. Pinning is the only per-tab
rescue, so pin anything you would be annoyed to lose.

Requires Chrome 121 or newer.

## Installing in your own Chrome

The extension is not on the Web Store; install it unpacked.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the **`extension/`** subfolder — not the repo root:

   ```
   <path-to-repo>/extension
   ```

Tab Reaper appears immediately and starts working with the 12-hour default. To
reach the settings, click the puzzle-piece icon in the toolbar and pin **Tab
Reaper**, then click its icon — or go to `chrome://extensions` → Tab Reaper →
**Details** → **Extension options**.

Things worth knowing about an unpacked install:

- **Don't move or delete the folder.** Chrome reloads the extension from that
  path on every startup; if it disappears, the extension errors out.
- **After editing code**, press the ↻ reload button on the extension's card at
  `chrome://extensions`.
- **Settings live in `chrome.storage.sync`**, so they persist across reloads and
  follow your Google account. Removing and re-adding the extension gives it a
  new ID and a fresh, empty settings store.
- Chrome may periodically warn about developer-mode extensions. That's normal
  for any unpacked install.

**Before trusting it with real tabs**, set the timeout to 2 minutes, open a few
throwaway tabs, and watch it work — then set it back. With the 12-hour default
you won't otherwise see anything happen until tomorrow.

> **Why not a command-line install?** Chrome 151 stable removed the
> `--load-extension` switch, so scripted side-loading no longer works in stable
> Chrome. **Load unpacked** is unaffected. For scripted/automated loading, see
> [`npm run chrome`](#running-it-in-a-disposable-chrome), which uses the Chrome
> for Testing build.

## Settings

- **Automatically close idle tabs** — master on/off switch.
- **Idle timeout** — minutes of non-use before a tab is closed. Default 720
  (12 hours).
- **Never close these sites** — one hostname per line. Prefix with `*.` to
  include subdomains:

  ```
  example.com        # exactly example.com
  *.google.com       # google.com and any subdomain
  ```

- **Custom timeouts per site** — one `hostname = minutes` per line, overriding
  the global timeout for matching tabs. Same `*.` syntax:

  ```
  *.zoom.us = 10           # stale meeting tabs go quickly
  docs.google.com = 2880   # keep docs around for 2 days
  ```

  A rule can be shorter *or* longer than the global timeout. Lines that aren't
  `hostname = minutes` (or that have a non-positive number) are ignored, and the
  hint under the box shows exactly how your input was understood — so a typo
  that drops a line is visible immediately.

- **Reap now** — sweep immediately instead of waiting for the next tick.

### How the two lists interact

1. **Never-close wins.** A host in the never-close list is kept even if a custom
   timeout also matches it.
2. **Most specific rule wins.** An exact hostname beats a wildcard, and a deeper
   wildcard beats a shallower one — so with `*.google.com = 60` and
   `docs.google.com = 5`, docs uses 5 minutes and `mail.google.com` uses 60.
3. **Otherwise the global timeout applies.**

## Development workflow

### Setup

```sh
npm install
npx playwright install chromium   # one-time browser download (~95 MB)
```

The download is Chrome for Testing, used by both the test suite and
`npm run chrome`. Nothing in the shipped extension depends on it.

### Commands

| Command | What it does |
| --- | --- |
| `npm test` | Unit + browser tests. |
| `npm run test:unit` | Pure logic via `node:test`. No browser, milliseconds. |
| `npm run test:browser` | Playwright tests against a real Chrome. |
| `npm run chrome` | Opens a disposable Chrome with the extension loaded. |
| `npm run icons` | Rebuilds `extension/icons/*.png` from `assets/*.svg`. |
| `npm run screenshots` | Rebuilds the store listing screenshots in `assets/store/`. |
| `npm run package` | Builds `dist/tab-reaper-<version>.zip` for the Web Store. |
| `npm run verify:published` | Checks the published extension against a git ref. |
| `node scripts/smoke.js` | One end-to-end pass; `--screenshot out.png` to capture the options page. |

### The loop

Most changes are to reaping behaviour, which lives in
`extension/lib/reaper.js`. That module deliberately touches **no `chrome.*`
API**, so the fast path is:

1. Add or change a case in `test/unit/reaper.test.js`.
2. Edit `extension/lib/reaper.js`.
3. `npm run test:unit` — sub-second feedback.

Once the logic is right, confirm it behaves the same when wired to the real
browser APIs: add a case to `test/browser/` and run `npm run test:browser`.
Anything touching `background.js` (tab events, alarms, storage) needs a browser
test, because none of that can be exercised in plain Node.

When you fix a bug, add the test that fails without the fix — then verify it
really fails by reverting the fix temporarily. The activity-map race in
[Implementation notes](#implementation-notes) was found that way, and its
regression test only catches 1-of-8 recorded tabs when the fix is removed.

### Editing the icon

The grim reaper is authored as SVG in `assets/`, but Chrome only accepts PNG
for extension icons, so `npm run icons` rasterizes it into
`extension/icons/icon-{16,32,48,128}.png`. Both the SVG sources and the
generated PNGs are committed — the extension must work from a plain checkout,
with no build step before **Load unpacked**.

There are two source files on purpose:

| | Source | Used at | Why |
| --- | --- | --- | --- |
| ![the full grim reaper figure with scythe](assets/icon.svg) | `assets/icon.svg` | 48px, 128px | The full figure with scythe. |
| ![a cropped hooded skull](assets/icon-small.svg) | `assets/icon-small.svg` | 16px, 32px | The detailed art turns to mud at toolbar size: the scythe becomes a stray diagonal and the hem detail becomes noise, so the small variant crops to just the hooded skull. |

Those are the SVG sources at full size. What Chrome actually ships is the
rasterized PNG, so judge the result at `chrome://extensions` and in the toolbar,
not here.

Rasterizing happens in the headless Chrome the tests already use — no
image-processing dependency. The SVG is rendered at 4× the target size and then
downscaled on a canvas, which antialiases the curves far better than rasterizing
straight to 16px. The downscale is the half that is easy to forget: screenshotting
the 4× page directly is what the script used to do, and it silently committed
512×512 files named `icon-128.png` for a while. Chrome scaled them on the fly, so
nothing looked broken, but the store requires exact dimensions and the extension
was carrying 54KB of icons it could not use at face value.

`npm run icons` also writes **`assets/store/store-icon-128.png`**, the Chrome
Web Store listing icon. It isn't part of the extension, so it stays in
`assets/`. Same art, different rules: exactly 128×128 with the artwork inset to
96×96, because the store draws its own shadow and hover effects in that margin —
an edge-to-edge icon looks oversized beside every other listing. The art is also
trimmed to its ink before being fitted, since `icon.svg` carries slack inside its
own viewBox; scaling the viewBox alone leaves the visible mark at 69×90 and off
centre, reading smaller than its neighbours despite the file being correct.

After editing the art, run `npm run icons`, commit the PNGs, and reload the
extension at `chrome://extensions`. Check the small sizes, not just the 128px
version; `options.spec.js` asserts every declared icon actually loads, since a
missing icon file fails silently in the toolbar.

### Store listing screenshots

```sh
npm run screenshots
```

Writes `assets/store/screenshot-settings-1280x800.png` and a 640×400 twin — the
two sizes the Chrome Web Store accepts. A listing needs at least one screenshot
before it can be published.

The settings page is captured from a **real Chrome with the extension loaded**,
on its own `chrome-extension://` URL, with demo settings written through
`chrome.storage` first so the allowlist and per-domain rules are populated
rather than empty. A mock-up of the same form would drift from the real page and
is grounds for rejection anyway.

Two things make this more than a `page.screenshot()` call:

**The page doesn't fit the frame.** At its 520px column the content runs about
860px tall, so a 1280×800 capture would either crop the action bar or stretch the
layout. Instead the full-height capture is scaled to fit and composited onto a
backdrop with the product name beside it, so nothing is cut off and the aspect
ratio is untouched. The composition happens on a canvas in the browser that's
already open — the same no-dependency approach `make-icons.js` takes.

**The store forbids alpha.** It wants "JPEG or 24-bit PNG (no alpha)", and every
PNG a browser produces — `page.screenshot()`, `canvas.toDataURL()` — is 32-bit
RGBA. `scripts/lib/png.js` re-encodes as colour type 2, compositing over an
opaque background rather than merely dropping the alpha channel: discarding it
would expose whatever sat beneath a transparent pixel, which for a screenshot is
black, leaving dark fringes around the pane's shadow and rounded corners.
`test/unit/png.test.js` checks the encoded bytes against the PNG spec and
unfilters the scanlines with a separate implementation, rather than round-tripping
through this repo's own reader.

Re-run this after changing `options.html` or `options.css`, and commit the PNGs.

### Running it in a disposable Chrome

```sh
npm run chrome
```

This opens a **separate Chrome** with the extension side-loaded and its own
profile in `.chrome-dev-profile/` (gitignored) — your everyday browser and its
tabs are never touched. Delete that directory to reset to a clean state. Set
`CHROME_PATH` to use a different binary.

### Testing a 12-hour timeout without waiting 12 hours

Either set the timeout to 1 minute, or backdate tabs from the service worker
console (`chrome://extensions` → Tab Reaper → **service worker**):

```js
// Make every inactive tab look an hour old, then sweep.
await self.__tabReaper.updateActivity(async (activity) => {
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.active) activity[tab.id] = Date.now() - 3600_000;
  }
});
await self.__tabReaper.sweep();
```

`self.__tabReaper` exposes `sweep`, `readActivity`, `readSettings`, and
`updateActivity` for exactly this kind of poking; the test fixtures use the same
handle. Route timestamp edits through `updateActivity` rather than writing
`chrome.storage.session` directly, or a pending tab event may clobber them.

### How the tests are organized

- **`test/unit/`** (75 tests) is plain Node, no browser.
  - `reaper.test.js` (20) exercises `extension/lib/reaper.js`: thresholds,
    allowlist matching, rule parsing and specificity, exemptions.
  - `zip.test.js` (13) checks the hand-rolled ZIP writer's bytes against the
    spec, including that nothing is compressed — see
    [`docs/provenance.md`](docs/provenance.md) for why that matters.
  - `package.test.js` (10) extracts a real store package with the system `unzip`
    — an independent implementation, since our own reader could share a bug with
    our writer — and asserts the archive holds exactly the declared files, and
    that each icon is the size its manifest entry claims.
  - `crx.test.js` (8) reads CRX3 containers, and reads an archive built by the
    system `zip` so the reader isn't only ever tested against our own writer.
  - `treehash.test.js` (9) pins Chrome's per-file hash to expectations derived
    from the algorithm rather than from its own output.
  - `provenance.test.js` (14) builds a store-style CRX and tampers with it one
    way at a time, asserting each is caught. A verifier that only ever passes
    proves nothing.
- **`test/browser/`** (20 tests) loads the real extension into a real Chrome and
  drives it through the actual `chrome.tabs` API — opening tabs, pinning,
  activating, sweeping — then asserts which tabs survived.
  `test/browser/fixtures.js` provides the `ext` fixture, whose helpers run
  inside the extension's own privileged context.
  - `idle-close.spec.js` — reaping behaviour and exemptions.
  - `options.spec.js` — the settings UI, and that what it saves reaches the
    reaper.
- **`scripts/smoke.js`** is a single end-to-end pass, useful as a quick sanity
  check and for capturing a screenshot.

Browser tests run with `workers: 1`; each drives a real browser with a
persistent profile and they must not race over the same user-data dir.

### Continuous integration

`.github/workflows/test.yml` runs both suites on every push and pull request.
Unit tests go first — they need no browser, so a logic error fails in seconds.
The Chrome download is cached on the lockfile hash, and a failing run uploads
the Playwright report as an artifact.

**Writing browser tests that don't flake.** The extension reacts to tab events
asynchronously, so a test that sets something up and immediately sweeps is
racing the extension. Three traps cost several red CI runs:

- `chrome.tabs.create` resolves while the tab is still on `about:blank`. Sweep
  in that window and the reaper sees a non-`http(s)` URL, keeps the tab as
  `internal-page`, and closes nothing.
- A backdated timestamp can be overwritten by a tab event that lands *after*
  it, leaving the tab looking freshly used.
- `page.goto` on the options page resolves before the settings read behind
  `load()` has resolved. This one turned out to be an extension bug rather than
  a test bug — see below.

The `ext` fixture handles the first two: `openTab` waits for the extension to
record the tab *and* for its URL to commit, and `markIdle`/`markAllIdle` poll
until the backdating has actually stuck. Prefer those helpers over driving
`chrome.tabs` directly. `sweep()` also returns a `why` string of the extension's
own per-tab verdicts — attach it to closure assertions, because "expected
[1234], received []" doesn't say *why* a tab survived.

**Assert on state, not just on the UI's own claim.** The longest-lived flake
here was a test that typed a 1-minute timeout, saw `Saved.`, and then found
nothing to reap. The status text was true — a save *had* happened — but `load()`
had overwritten the typed value with the stored default first, so 720 was what
got saved. The page reported success for the wrong write. Two changes came out
of it: the form is now `disabled` until the settings read resolves (so a real
user's typing can't be discarded either), and the test asserts
`ext.getSettings()` rather than trusting the status line.

## Privacy

**The extension collects no data.** No server, no analytics, no telemetry, no
network requests at all — the source contains no `fetch` and no remote endpoint.
The three permissions it requests are the minimum the feature needs: `tabs` to
list, watch, and close tabs (and to check a URL's scheme and hostname against
your rules), `storage` to keep your settings and the per-tab "last active"
timestamps, and `alarms` for the one-minute tick that survives service-worker
eviction. Tab URLs are read in memory and discarded; nothing is logged, and the
extension keeps no record of what it closed.

**[Full policy → `docs/privacy.md`](docs/privacy.md)** — this is the document to
link as the privacy policy in the Chrome Web Store listing.

## Releasing

Releases are automated. Bump the version in `extension/manifest.json`, then push
a matching tag:

```sh
git commit -am "Release v0.2.0"
git tag v0.2.0
git push origin master --tags
```

`.github/workflows/release.yml` runs the full suite, checks the tag against the
manifest, and waits for your approval before submitting to the Chrome Web Store.

Authentication uses **workload identity federation**, so no credential is stored
in GitHub — GitHub mints a short-lived OIDC token per run and Google exchanges it
for a 10-minute access token scoped to the Web Store alone. There is nothing to
leak or rotate.

Two things need a human, both Google's limitation: **version 1 must be uploaded
through the dashboard by hand** (the API can only update an existing item), and
review still gates going live.

**[Full setup and security model → `docs/publishing.md`](docs/publishing.md)**

### Verifying a published release

A store listing normally tells you nothing about which source it was built from.
This one can be checked, by anyone, with no credentials:

```sh
git checkout v0.1.0
node scripts/verify-provenance.js --item <store item id> --ref v0.1.0
```

That downloads the CRX from Google's own update endpoint and compares every file
against the tag twice — against the source, and against the per-file hashes
Google signed into the package (the same ones Chrome checks before running an
extension). It exits non-zero on any mismatch.

Releases also carry a GitHub build attestation binding the package to the commit
that produced it, recorded in a public transparency log:

```sh
npm run package     # deterministic: same source, same bytes, any machine
gh attestation verify dist/tab-reaper-0.1.0.zip --repo hoffrocket/chrometabs
```

Byte-identity between a commit and the store *download* is not achievable — the
store repackages every upload — so the check is per-file rather than
whole-archive. **[What is and isn't provable, and why →
`docs/provenance.md`](docs/provenance.md)**

## Layout

```
extension/                MV3 extension — chrome.* APIs only
  manifest.json           permissions: tabs, storage, alarms
  background.js           service worker: tracks activity, runs sweeps
  lib/reaper.js           pure decision logic (no chrome.* — unit tested)
  options.html/.css/.js   settings UI
  icons/                  generated PNGs (committed; see npm run icons)
assets/                   icon source art (SVG)
  store/                  listing icon + screenshots (not shipped in the extension)
docs/
  privacy.md              privacy policy + permission justifications
  publishing.md           Web Store release setup and security model
  provenance.md           proving a published build came from a commit
test/
  unit/                   node:test — reaper logic, zip, packaging, provenance
  browser/                Playwright tests driving real Chrome
    fixtures.js           the `ext` fixture and extension-context helpers
scripts/
  launch-chrome.js        disposable Chrome for manual poking
  make-icons.js           SVG -> PNG rasterizer
  make-screenshots.js     store listing screenshots of the settings page
  smoke.js                end-to-end check + screenshot
  package.js              builds the store zip (explicit file allowlist)
  publish.js              uploads + publishes via the Web Store API v2
  verify-provenance.js    checks a published CRX against a git ref
  lib/zip.js              minimal ZIP writer (no dependencies)
  lib/png.js              PNG reader + 24-bit writer (the store forbids alpha)
  lib/crx.js              CRX3 + ZIP reader
  lib/treehash.js         Chrome's per-file hash, as the store signs it
  lib/provenance.js       the published-vs-source comparison
playwright.config.js
```

## Implementation notes

- **Decision logic is isolated from the `chrome.*` APIs.** `lib/reaper.js`
  decides what to close from plain data (tabs, timestamps, settings) and returns
  a *reason* for every tab rather than a boolean. That keeps the rules unit
  testable and makes sweeps self-explaining.
- **Activity lives in `chrome.storage.session`, not a variable.** MV3 service
  workers are killed and restarted at Chrome's discretion, so an in-memory `Map`
  of tab timestamps would vanish. `storage.session` clears on browser restart,
  which is the lifetime we want anyway.
- **Updates to the activity map are serialized.** Each update is a
  read-modify-write against storage, and tab events arrive in bursts (opening ten
  tabs fires ten `onCreated` events). Unserialized, later writes clobber earlier
  ones with a stale copy of the map, dropping timestamps so tabs look either
  immortal or instantly stale. `updateActivity()` funnels all mutations through
  one promise chain; `idle-close.spec.js` has a regression test that fails
  without it.
- **Tabs with no recorded timestamp are treated as just-used**, so a freshly
  installed or restarted extension never mass-closes long-standing tabs.
- **A `chrome.alarms` tick drives sweeps**, not `setTimeout` — timers don't
  survive service-worker eviction. The alarm is (re)created on install, on
  startup, and on every worker start, since an evicted worker restarts without
  firing either lifecycle event.
- **Malformed rule lines are dropped, not fatal.** One typo shouldn't disable
  every rule — so the options page reports what it understood and how many lines
  it ignored.
- **The options form is inert until it has loaded.** Populating it from
  `storage.sync` is asynchronous and overwrites every field, so an editable
  field before that point would silently discard whatever was typed into it —
  and then save the stale value while still reporting success.
- **The release tooling has no dependencies either.** Node ships `zlib` but no
  archive format, so `scripts/lib/zip.js` writes the ZIP container by hand
  (~120 lines) rather than pulling in a packaging library, and `publish.js`
  talks to Google's REST APIs with `fetch`.
- **The package is stored, not compressed, so its digest is reproducible.**
  Deflate output isn't standardised — with compression on, the same source
  produced two different digests across five Node versions (zlib 1.2.x vs
  1.3.x). Since a build attestation only means something if you can reproduce
  the digest it covers, and the store recompresses uploads anyway, the 23% size
  cost buys something real. Fixed timestamps and explicit entry order do the
  rest.
