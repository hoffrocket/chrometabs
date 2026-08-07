import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  evaluateTab,
  formatRules,
  isAllowlisted,
  matchRule,
  normalizeSettings,
  parseAllowlist,
  parseRules,
  planReap,
} from '../../extension/lib/reaper.js';

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

function tab(overrides = {}) {
  return { id: 1, url: 'https://example.com/', active: false, pinned: false, ...overrides };
}

function settings(overrides = {}) {
  return normalizeSettings({ ...DEFAULT_SETTINGS, idleMinutes: 30, ...overrides });
}

test('the default idle period is 12 hours', () => {
  assert.equal(DEFAULT_SETTINGS.idleMinutes, 720);
  assert.equal(normalizeSettings({}).idleMinutes, 720);
});

test('normalizeSettings falls back on invalid idleMinutes', () => {
  assert.equal(normalizeSettings({ idleMinutes: 0 }).idleMinutes, DEFAULT_SETTINGS.idleMinutes);
  assert.equal(normalizeSettings({ idleMinutes: -5 }).idleMinutes, DEFAULT_SETTINGS.idleMinutes);
  assert.equal(normalizeSettings({ idleMinutes: 'abc' }).idleMinutes, DEFAULT_SETTINGS.idleMinutes);
  assert.equal(normalizeSettings({ idleMinutes: '45' }).idleMinutes, 45);
});

test('normalizeSettings treats missing enabled as on, explicit false as off', () => {
  assert.equal(normalizeSettings({}).enabled, true);
  assert.equal(normalizeSettings({ enabled: false }).enabled, false);
});

test('parseAllowlist accepts strings, arrays, urls and dedupes', () => {
  assert.deepEqual(parseAllowlist('example.com\n*.google.com'), ['example.com', '*.google.com']);
  assert.deepEqual(parseAllowlist('a.com, b.com'), ['a.com', 'b.com']);
  assert.deepEqual(parseAllowlist(['https://Example.com/path', 'example.com']), ['example.com']);
  assert.deepEqual(parseAllowlist(''), []);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test('isAllowlisted matches exact hosts and wildcard subdomains', () => {
  const list = parseAllowlist('example.com\n*.google.com');
  assert.equal(isAllowlisted('https://example.com/x', list), true);
  assert.equal(isAllowlisted('https://sub.example.com/x', list), false, 'exact host must not match subdomains');
  assert.equal(isAllowlisted('https://mail.google.com/x', list), true);
  assert.equal(isAllowlisted('https://google.com/x', list), true, 'wildcard also covers the base host');
  assert.equal(isAllowlisted('https://notgoogle.com/x', list), false);
  assert.equal(isAllowlisted('not a url', list), false);
});

test('parseRules reads "pattern = minutes" lines and drops junk', () => {
  assert.deepEqual(parseRules('*.zoom.us = 10\ndocs.google.com: 2880'), [
    { pattern: '*.zoom.us', minutes: 10 },
    { pattern: 'docs.google.com', minutes: 2880 },
  ]);
  // Missing separator, non-numeric, and non-positive values are all dropped.
  assert.deepEqual(parseRules('nonsense\nbad.com = abc\nzero.com = 0\nneg.com = -5'), []);
  assert.deepEqual(parseRules('  *.Zoom.us  =  10.9  '), [{ pattern: '*.zoom.us', minutes: 10 }]);
  assert.deepEqual(parseRules(''), []);
  assert.deepEqual(parseRules(undefined), []);
});

test('parseRules accepts object arrays and lets the last duplicate win', () => {
  assert.deepEqual(parseRules([{ pattern: 'a.com', minutes: 5 }]), [{ pattern: 'a.com', minutes: 5 }]);
  assert.deepEqual(parseRules('a.com = 5\na.com = 9'), [{ pattern: 'a.com', minutes: 9 }]);
});

test('formatRules round-trips through parseRules', () => {
  const rules = parseRules('*.zoom.us = 10\ndocs.google.com = 2880');
  assert.equal(formatRules(rules), '*.zoom.us = 10\ndocs.google.com = 2880');
  assert.deepEqual(parseRules(formatRules(rules)), rules);
});

test('matchRule prefers the most specific pattern', () => {
  const rules = parseRules('*.google.com = 60\ndocs.google.com = 5\n*.us.zoom.us = 2\n*.zoom.us = 10');

  assert.equal(matchRule('https://docs.google.com/a', rules).minutes, 5, 'exact host beats wildcard');
  assert.equal(matchRule('https://mail.google.com/a', rules).minutes, 60);
  assert.equal(matchRule('https://x.us.zoom.us/j', rules).minutes, 2, 'deeper wildcard beats shallower');
  assert.equal(matchRule('https://x.eu.zoom.us/j', rules).minutes, 10);
  assert.equal(matchRule('https://example.com/', rules), null);
});

test('a per-domain rule overrides the global timeout in both directions', () => {
  const config = settings({ idleMinutes: 720, rules: '*.zoom.us = 10\nslow.com = 10000' });

  // zoom closes sooner than the 12h global default...
  const zoom = evaluateTab(tab({ url: 'https://x.zoom.us/j' }), NOW - 11 * MINUTE, NOW, config);
  assert.equal(zoom.close, true);
  assert.equal(zoom.reason, 'idle-by-rule');
  assert.equal(zoom.matchedRule, '*.zoom.us');
  assert.equal(zoom.thresholdMinutes, 10);

  // ...and a longer rule keeps a tab the global timeout would have reaped.
  const slow = evaluateTab(tab({ url: 'https://slow.com/' }), NOW - 800 * MINUTE, NOW, config);
  assert.equal(slow.close, false);
  assert.equal(slow.reason, 'not-idle-long-enough');
  assert.equal(slow.thresholdMinutes, 10000);
});

test('a rule does not apply before its own threshold elapses', () => {
  const config = settings({ idleMinutes: 1, rules: '*.zoom.us = 60' });
  const verdict = evaluateTab(tab({ url: 'https://x.zoom.us/j' }), NOW - 30 * MINUTE, NOW, config);
  assert.equal(verdict.close, false, 'the rule lengthens the timeout past the global 1 minute');
});

test('the allowlist wins over a custom timeout for the same host', () => {
  const config = settings({ allowlist: '*.zoom.us', rules: '*.zoom.us = 1' });
  const verdict = evaluateTab(tab({ url: 'https://x.zoom.us/j' }), NOW - 999 * MINUTE, NOW, config);
  assert.equal(verdict.close, false);
  assert.equal(verdict.reason, 'allowlisted');
});

test('tabs without a matching rule report no threshold override', () => {
  const config = settings({ idleMinutes: 720, rules: '*.zoom.us = 10' });
  const verdict = evaluateTab(tab({ url: 'https://example.com/' }), NOW - 1 * MINUTE, NOW, config);
  assert.equal(verdict.matchedRule, null);
  assert.equal(verdict.thresholdMinutes, 720);
});

test('an idle tab past the threshold is closed', () => {
  const verdict = evaluateTab(tab(), NOW - 31 * MINUTE, NOW, settings());
  assert.equal(verdict.close, true);
  assert.equal(verdict.reason, 'idle');
});

test('a tab just under the threshold survives', () => {
  const verdict = evaluateTab(tab(), NOW - 29 * MINUTE, NOW, settings());
  assert.equal(verdict.close, false);
  assert.equal(verdict.reason, 'not-idle-long-enough');
});

test('the active, pinned, internal and allowlisted tabs all survive', () => {
  const old = NOW - 999 * MINUTE;
  const config = settings({ allowlist: 'keep.com' });

  assert.equal(evaluateTab(tab({ active: true }), old, NOW, config).reason, 'active');
  assert.equal(evaluateTab(tab({ pinned: true }), old, NOW, config).reason, 'pinned');
  assert.equal(evaluateTab(tab({ url: 'chrome://settings' }), old, NOW, config).reason, 'internal-page');
  assert.equal(evaluateTab(tab({ url: 'about:blank' }), old, NOW, config).reason, 'internal-page');
  assert.equal(evaluateTab(tab({ url: 'https://keep.com/a' }), old, NOW, config).reason, 'allowlisted');
});

test('a tab with no recorded activity is treated as just-used', () => {
  const verdict = evaluateTab(tab(), undefined, NOW, settings());
  assert.equal(verdict.close, false);
  assert.equal(verdict.idleMs, 0);
});

test('planReap applies per-domain rules across a mixed set of tabs', () => {
  const tabs = [
    tab({ id: 1, url: 'https://call.zoom.us/j' }),
    tab({ id: 2, url: 'https://docs.google.com/d' }),
    tab({ id: 3, url: 'https://example.com/' }),
  ];
  // All three have been idle 30 minutes.
  const lastActive = { 1: NOW - 30 * MINUTE, 2: NOW - 30 * MINUTE, 3: NOW - 30 * MINUTE };

  const { closing } = planReap({
    tabs,
    lastActive,
    now: NOW,
    settings: { idleMinutes: 720, rules: '*.zoom.us = 10\ndocs.google.com = 2880' },
  });

  // zoom (10m) is past due; docs (48h) and the 12h global default are not.
  assert.deepEqual(closing.map((v) => v.tabId), [1]);
});

test('planReap splits tabs into closing and keeping', () => {
  const tabs = [
    tab({ id: 1, active: true }),
    tab({ id: 2, url: 'https://stale.com/' }),
    tab({ id: 3, url: 'https://fresh.com/' }),
    tab({ id: 4, url: 'https://pinned.com/', pinned: true }),
  ];
  const lastActive = {
    1: NOW - 500 * MINUTE,
    2: NOW - 500 * MINUTE,
    3: NOW - 1 * MINUTE,
    4: NOW - 500 * MINUTE,
  };

  const { closing, keeping } = planReap({ tabs, lastActive, now: NOW, settings: { idleMinutes: 30 } });
  assert.deepEqual(closing.map((v) => v.tabId), [2]);
  assert.deepEqual(keeping.map((v) => v.tabId).sort(), [1, 3, 4]);
});

test('planReap closes nothing when disabled', () => {
  const tabs = [tab({ id: 1 }), tab({ id: 2 })];
  const lastActive = { 1: NOW - 999 * MINUTE, 2: NOW - 999 * MINUTE };
  const { closing, keeping } = planReap({
    tabs,
    lastActive,
    now: NOW,
    settings: { enabled: false, idleMinutes: 1 },
  });
  assert.equal(closing.length, 0);
  assert.equal(keeping.length, 2);
  assert.equal(keeping[0].reason, 'disabled');
});
