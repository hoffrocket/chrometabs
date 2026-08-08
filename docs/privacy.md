# Privacy Policy

**Extension:** Tab Reaper
**Last updated:** 2026-08-08

## Summary

**Tab Reaper does not collect any data.**

It has no server, no analytics, no telemetry, no crash reporting, and no
third-party libraries. It makes no network requests of any kind — there is no
`fetch`, no `XMLHttpRequest`, and no remote endpoint anywhere in the extension's
source. Nothing about your browsing ever leaves your computer, because there is
nowhere for it to go.

Everything the extension knows lives in your own browser's extension storage and
is used only to decide which tabs to close. The source is public and auditable in
this repository.

## What the extension does

Once a minute, Tab Reaper looks at your open tabs and closes the ones you have
not used for longer than the idle timeout you configured. That is the whole
feature. To do it, the extension requests three permissions, explained below.

## Permission justifications

### `tabs`

Closing unused tabs is the extension's entire purpose, and that cannot be done
without the `tabs` permission. It is used to:

- enumerate the open tabs (`chrome.tabs.query`);
- track which tab you last looked at, via the `onActivated`, `onCreated`,
  `onReplaced`, and `onRemoved` events;
- close an idle tab (`chrome.tabs.remove`);
- read each tab's URL, so the extension can respect your settings — only
  `http:` and `https:` tabs are eligible for closing, and the hostname is
  compared against your never-close allowlist and your per-domain timeout rules.

A tab's URL is examined in memory at the moment of the check and then discarded.
Tab URLs, titles, and page contents are never stored, never logged, and never
transmitted. The extension keeps **no record of which tabs it closed** — recovery
is Chrome's own *Reopen closed tab* and History, not anything Tab Reaper retains.

### `storage`

Used for two things, both of which stay inside your browser:

- **`chrome.storage.sync` — your settings.** The on/off toggle, the global idle
  timeout, your never-close allowlist, and your per-domain timeout overrides, so
  they persist across restarts. Because this is Chrome's *sync* storage, these
  settings travel through your own Chrome profile sync if you have sync enabled —
  the same mechanism as your bookmarks, between your own devices, under your own
  Google account. They are not sent to the developer or to any third party. If
  you would rather they stayed on one machine, turn off extension sync in Chrome,
  or leave the allowlist and rules empty.
- **`chrome.storage.session` — "last active at" timestamps.** A map of tab ID to
  a timestamp, which is what makes "haven't used in a while" measurable. This has
  to be in storage rather than a variable because a Manifest V3 service worker is
  shut down between runs and an in-memory map would vanish with it. Session
  storage is cleared when you restart your browser.

No browsing history, page content, form data, credentials, or personal
information is stored.

### `alarms`

The idle check has to run on a schedule. `chrome.alarms` registers a single
repeating one-minute alarm that wakes the background service worker to run the
check. Under Manifest V3 the service worker is terminated when idle, so `alarms`
is the only supported way to do recurring work — a `setTimeout` would not survive
shutdown. The alarm carries no data; it is just a clock tick.

## Data handling, stated plainly

| | |
| --- | --- |
| Data collected | None |
| Data sold or shared | None |
| Data transmitted off your device | None |
| Analytics / telemetry / crash reporting | None |
| Third-party services or libraries | None |
| Remote code execution | None — all code ships in the package |
| Data retained by the developer | None |

The developer has no ability to see your tabs, your settings, or your usage,
because the extension never sends anything anywhere.

## Uninstalling

Removing the extension from `chrome://extensions` deletes its storage. Session
timestamps are gone immediately; synced settings are removed from your profile by
Chrome. Tabs already closed cannot be un-closed by uninstalling — use Chrome's
History.

## Changes

Any change to this policy will be a commit in this repository, so the full
history of what it has ever said is public. If a future version were ever to
collect data, that would require new permissions and a new version of this
document, both visible in the diff.

## Contact

Questions or concerns: open an issue at
<https://github.com/hoffrocket/chrometabs/issues>.
