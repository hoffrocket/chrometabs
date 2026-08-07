import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  evaluateTab,
  isAllowlisted,
  normalizeSettings,
  parseAllowlist,
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
