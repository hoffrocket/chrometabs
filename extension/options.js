import { DEFAULT_SETTINGS, normalizeSettings, parseAllowlist } from './lib/reaper.js';

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

let statusTimer;
function setStatus(text) {
  $('status').textContent = text;
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => ($('status').textContent = ''), 4000);
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const settings = normalizeSettings(stored);
  $('enabled').checked = settings.enabled;
  $('idleMinutes').value = settings.idleMinutes;
  $('allowlist').value = settings.allowlist.join('\n');
  renderHint();
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
  };
  await chrome.storage.sync.set(settings);
  // Reflect any normalization (deduped hosts, floored minutes) back into the form.
  $('idleMinutes').value = settings.idleMinutes;
  $('allowlist').value = settings.allowlist.join('\n');
  renderHint();
  setStatus('Saved.');
}

async function reapNow() {
  setStatus('Reaping…');
  const result = await chrome.runtime.sendMessage({ type: 'sweepNow' });
  const count = result?.closed?.length ?? 0;
  setStatus(count === 0 ? 'No idle tabs to close.' : `Closed ${count} tab${count === 1 ? '' : 's'}.`);
}

$('save').addEventListener('click', save);
$('reapNow').addEventListener('click', reapNow);
$('idleMinutes').addEventListener('input', renderHint);

load();
