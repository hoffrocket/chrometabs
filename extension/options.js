import {
  DEFAULT_SETTINGS,
  formatRules,
  normalizeSettings,
  parseAllowlist,
  parseRules,
} from './lib/reaper.js';

const $ = (id) => document.getElementById(id);

function describeDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (hours < 24) {
    const rounded = Number.isInteger(hours) ? hours : hours.toFixed(1);
    return `${rounded} hour${Number(rounded) === 1 ? '' : 's'}`;
  }
  const days = hours / 24;
  const rounded = Number.isInteger(days) ? days : days.toFixed(1);
  return `${rounded} day${Number(rounded) === 1 ? '' : 's'}`;
}

function renderHint() {
  const minutes = Number($('idleMinutes').value);
  const pretty = describeDuration(minutes);
  $('idleHint').textContent = pretty ? `That's about ${pretty} of not looking at a tab.` : '';
}

/** Echo back how the rules textarea was actually understood, so a typo that
 *  drops a line is visible before the user navigates away. */
function renderRulesHint() {
  const raw = $('rules').value;
  const written = raw.split('\n').filter((line) => line.trim()).length;
  const rules = parseRules(raw);

  if (written === 0) {
    $('rulesHint').textContent = '';
    return;
  }
  const summary = rules
    .map((rule) => `${rule.pattern} after ${describeDuration(rule.minutes)}`)
    .join(', ');
  const dropped = written - rules.length;
  $('rulesHint').textContent =
    (summary ? `Understood: ${summary}.` : '') +
    (dropped > 0 ? ` ${dropped} line${dropped === 1 ? '' : 's'} ignored — use "hostname = minutes".` : '');
}

let statusTimer;
function setStatus(text) {
  $('status').textContent = text;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => ($('status').textContent = ''), 4000);
}

const CONTROLS = ['enabled', 'idleMinutes', 'allowlist', 'rules', 'save', 'reapNow'];

/**
 * Populate the form from storage, then hand it over to the user.
 *
 * The controls are `disabled` in the HTML and only enabled here. Reading
 * settings is asynchronous, and this function overwrites every field
 * unconditionally — so anything typed before the read resolves would be
 * silently discarded. On a fast machine the window is invisible; on a slow one
 * it is wide enough to lose a real edit. (It also made a browser test flake:
 * a typed timeout was clobbered back to the stored default, so the save wrote
 * the wrong value while still reporting "Saved.")
 */
async function load() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = normalizeSettings(stored);
  $('enabled').checked = settings.enabled;
  $('idleMinutes').value = settings.idleMinutes;
  $('allowlist').value = settings.allowlist.join('\n');
  $('rules').value = formatRules(settings.rules);
  renderHint();
  renderRulesHint();
  for (const id of CONTROLS) $(id).disabled = false;
  delete document.body.dataset.loading;
}

async function save() {
  const minutes = Number($('idleMinutes').value);
  if (!Number.isFinite(minutes) || minutes < 1) {
    setStatus('Enter a number of minutes greater than 0.');
    return;
  }
  const settings = {
    enabled: $('enabled').checked,
    idleMinutes: Math.floor(minutes),
    allowlist: parseAllowlist($('allowlist').value),
    rules: parseRules($('rules').value),
  };
  await chrome.storage.sync.set(settings);
  // Reflect any normalization (deduped hosts, floored minutes) back into the form.
  $('idleMinutes').value = settings.idleMinutes;
  $('allowlist').value = settings.allowlist.join('\n');
  $('rules').value = formatRules(settings.rules);
  renderHint();
  renderRulesHint();
  setStatus('Saved.');
}

async function reapNow() {
  setStatus('Reaping…');
  // Don't fold a failed round-trip into "nothing to close" — a dead service
  // worker would otherwise report the same reassuring message as a real sweep
  // that found no idle tabs.
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'sweepNow' });
  } catch (error) {
    setStatus(`Could not reach the extension: ${error.message}`);
    return;
  }
  if (!Array.isArray(result?.closed)) {
    setStatus('Sweep failed — see the service worker console.');
    return;
  }
  const count = result.closed.length;
  setStatus(count === 0 ? 'No idle tabs to close.' : `Closed ${count} tab${count === 1 ? '' : 's'}.`);
}

$('save').addEventListener('click', save);
$('reapNow').addEventListener('click', reapNow);
$('idleMinutes').addEventListener('input', renderHint);
$('rules').addEventListener('input', renderRulesHint);

load();
