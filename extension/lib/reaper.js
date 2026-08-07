/**
 * Pure decision logic for Tab Reaper.
 *
 * Nothing in this file touches the `chrome.*` APIs, so it can be exercised
 * directly by unit tests as well as by the service worker.
 */

export const DEFAULT_SETTINGS = {
  enabled: true,
  idleMinutes: 12 * 60,
  allowlist: [],
  rules: [],
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
    rules: parseRules(settings.rules),
  };
}

/**
 * Per-domain overrides of the global idle timeout, e.g. close `*.zoom.us`
 * after 10 minutes while everything else waits 12 hours.
 *
 * Accepts an array of `{pattern, minutes}` objects, or a newline/comma
 * separated string of `pattern = minutes` lines (which is what the options
 * page textarea produces):
 *
 *   *.zoom.us = 10
 *   docs.google.com = 2880
 *
 * Invalid lines are dropped rather than throwing, so one typo in the textarea
 * cannot break every rule.
 */
export function parseRules(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(/[\n,]/)
        .map((line) => {
          const match = /^([^=:]+)[=:](.*)$/.exec(line);
          return match ? { pattern: match[1], minutes: match[2] } : null;
        })
        .filter(Boolean);

  const byPattern = new Map();
  for (const entry of entries) {
    const [pattern] = parseAllowlist([entry?.pattern ?? '']);
    const minutes = Number(String(entry?.minutes ?? '').trim());
    if (!pattern || !Number.isFinite(minutes) || minutes <= 0) continue;
    // Last definition of a pattern wins, matching the allowlist's dedupe.
    byPattern.set(pattern, { pattern, minutes: Math.floor(minutes) });
  }
  return [...byPattern.values()];
}

/** Serialize rules back into the `pattern = minutes` textarea format. */
export function formatRules(rules) {
  return rules.map(({ pattern, minutes }) => `${pattern} = ${minutes}`).join('\n');
}

/**
 * How specific a host pattern is. An exact host beats a wildcard, and a
 * deeper wildcard beats a shallower one, so `*.us.zoom.us` wins over
 * `*.zoom.us` and `docs.google.com` wins over `*.google.com`.
 */
function specificity(pattern) {
  const labels = pattern.replace(/^\*\./, '').split('.').length;
  return pattern.startsWith('*.') ? labels : labels + 100;
}

/**
 * The most specific rule matching this URL, or null.
 */
export function matchRule(url, rules) {
  let best = null;
  for (const rule of rules) {
    if (!isAllowlisted(url, [rule.pattern])) continue;
    if (!best || specificity(rule.pattern) > specificity(best.pattern)) best = rule;
  }
  return best;
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

  // The allowlist is checked before rules, so a never-close entry always wins
  // over a custom timeout for the same host.
  const rule = matchRule(tab.url, settings.rules);
  const thresholdMinutes = rule ? rule.minutes : settings.idleMinutes;
  const thresholdMs = thresholdMinutes * 60_000;

  const verdict = (close, reason) => ({
    tabId: tab.id,
    close,
    reason,
    idleMs,
    thresholdMinutes,
    matchedRule: rule ? rule.pattern : null,
  });

  if (tab.active) return verdict(false, 'active');
  if (tab.pinned) return verdict(false, 'pinned');
  if (!isReapableUrl(tab.url)) return verdict(false, 'internal-page');
  if (isAllowlisted(tab.url, settings.allowlist)) return verdict(false, 'allowlisted');
  if (idleMs < thresholdMs) return verdict(false, 'not-idle-long-enough');

  return verdict(true, rule ? 'idle-by-rule' : 'idle');
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
