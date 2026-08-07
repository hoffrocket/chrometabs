/**
 * Pure decision logic for Tab Reaper.
 *
 * Nothing in this file touches the `chrome.*` APIs, so it can be exercised
 * directly by unit tests as well as by the service worker.
 */

export const DEFAULT_SETTINGS = {
  enabled: true,
  idleMinutes: 60,
  allowlist: [],
};

/** Schemes we are willing to reap. Internal pages (chrome://, about:, the
 *  options page itself, the Web Store) are always left alone. */
const REAPABLE_SCHEMES = new Set(['http:', 'https:']);

export function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const minutes = Number(settings.idleMinutes);
  return {
    enabled: settings.enabled !== false,
    idleMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SETTINGS.idleMinutes,
    allowlist: parseAllowlist(settings.allowlist),
  };
}

/**
 * Accepts either an array of patterns or a newline/comma separated string.
 * Patterns are hostnames, optionally with a leading `*.` to include
 * subdomains: `example.com`, `*.example.com`, `mail.google.com`.
 */
export function parseAllowlist(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
  const seen = new Set();
  for (const item of items) {
    const pattern = String(item).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (pattern) seen.add(pattern);
  }
  return [...seen];
}

export function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isAllowlisted(url, allowlist) {
  const host = hostname(url);
  if (!host) return false;
  return allowlist.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === pattern;
  });
}

function isReapableUrl(url) {
  try {
    return REAPABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Explains why a single tab would or would not be closed. Returning a reason
 * for every tab (rather than just a boolean) keeps the options page and the
 * tests honest about *why* something survived.
 *
 * @param {chrome.tabs.Tab} tab
 * @param {number|undefined} lastActiveAt epoch ms the tab was last the active tab
 * @param {number} now epoch ms
 * @param {ReturnType<typeof normalizeSettings>} settings
 */
export function evaluateTab(tab, lastActiveAt, now, settings) {
  const idleMs = Math.max(0, now - (lastActiveAt ?? now));
  const thresholdMs = settings.idleMinutes * 60_000;
  const keep = (reason) => ({ tabId: tab.id, close: false, reason, idleMs });

  if (tab.active) return keep('active');
  if (tab.pinned) return keep('pinned');
  if (!isReapableUrl(tab.url)) return keep('internal-page');
  if (isAllowlisted(tab.url, settings.allowlist)) return keep('allowlisted');
  if (idleMs < thresholdMs) return keep('not-idle-long-enough');

  return { tabId: tab.id, close: true, reason: 'idle', idleMs };
}

/**
 * @returns {{closing: object[], keeping: object[]}}
 */
export function planReap({ tabs, lastActive, now, settings }) {
  const normalized = normalizeSettings(settings);
  const closing = [];
  const keeping = [];

  if (!normalized.enabled) {
    return { closing, keeping: tabs.map((tab) => ({ tabId: tab.id, close: false, reason: 'disabled', idleMs: 0 })) };
  }

  for (const tab of tabs) {
    const verdict = evaluateTab(tab, lastActive[tab.id], now, normalized);
    (verdict.close ? closing : keeping).push(verdict);
  }
  return { closing, keeping };
}
