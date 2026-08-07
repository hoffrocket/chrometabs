import { DEFAULT_SETTINGS, normalizeSettings, planReap } from './lib/reaper.js';

const SWEEP_ALARM = 'tab-reaper-sweep';
const SWEEP_PERIOD_MINUTES = 1;
const ACTIVITY_KEY = 'lastActive';

/**
 * The service worker is torn down whenever Chrome feels like it, so the
 * tabId -> "last time this tab was active" map lives in storage.session
 * rather than in a module-level variable. storage.session is cleared when
 * the browser restarts, which is exactly the lifetime we want.
 */
async function readActivity() {
  const stored = await chrome.storage.session.get(ACTIVITY_KEY);
  return stored[ACTIVITY_KEY] ?? {};
}

async function writeActivity(activity) {
  await chrome.storage.session.set({ [ACTIVITY_KEY]: activity });
}

/**
 * Every update to the activity map is a read-modify-write against storage.
 * Tab events arrive in bursts (opening ten tabs at once fires ten onCreated
 * events), and unserialized updates interleave so that later writes clobber
 * earlier ones with stale copies of the map. Funnelling mutations through a
 * single promise chain keeps them atomic with respect to each other.
 */
let activityQueue = Promise.resolve();

function updateActivity(mutate) {
  activityQueue = activityQueue.then(async () => {
    const activity = await readActivity();
    const result = await mutate(activity);
    await writeActivity(activity);
    return result;
  }).catch((error) => {
    console.warn('Tab Reaper: activity update failed', error);
  });
  return activityQueue;
}

async function readSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return normalizeSettings(stored);
}

function now() {
  return Date.now();
}

function touch(tabId, at = now()) {
  return updateActivity((activity) => {
    activity[tabId] = at;
  });
}

/** Seed every existing tab so a freshly installed/restarted extension does not
 *  treat long-open tabs as instantly stale. */
function seedAllTabs() {
  return updateActivity(async (activity) => {
    const tabs = await chrome.tabs.query({});
    const at = now();
    for (const tab of tabs) {
      if (activity[tab.id] === undefined) activity[tab.id] = at;
    }
    prune(activity, tabs);
  });
}

/** Drop timestamps for tabs that no longer exist. */
function prune(activity, tabs) {
  const live = new Set(tabs.map((tab) => String(tab.id)));
  for (const key of Object.keys(activity)) {
    if (!live.has(key)) delete activity[key];
  }
}

export async function sweep() {
  const settings = await readSettings();

  return updateActivity(async (activity) => {
    const tabs = await chrome.tabs.query({});
    const at = now();

    // A tab that is active right now is being used right now.
    for (const tab of tabs) {
      if (tab.active) activity[tab.id] = at;
    }

    const plan = planReap({ tabs, lastActive: activity, now: at, settings });
    const closed = [];

    for (const verdict of plan.closing) {
      try {
        await chrome.tabs.remove(verdict.tabId);
        delete activity[verdict.tabId];
        closed.push(verdict.tabId);
      } catch (error) {
        // The tab vanished between query and remove; nothing to do.
        console.warn('Tab Reaper: could not close tab', verdict.tabId, error);
      }
    }

    prune(activity, await chrome.tabs.query({}));
    return { closed, kept: plan.keeping, settings };
  });
}

function scheduleSweeps() {
  chrome.alarms.create(SWEEP_ALARM, {
    periodInMinutes: SWEEP_PERIOD_MINUTES,
    delayInMinutes: SWEEP_PERIOD_MINUTES,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await seedAllTabs();
  scheduleSweeps();
});

chrome.runtime.onStartup.addListener(async () => {
  await seedAllTabs();
  scheduleSweeps();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) sweep();
});

chrome.tabs.onCreated.addListener((tab) => touch(tab.id));

chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId));

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  updateActivity((activity) => {
    activity[addedTabId] = activity[removedTabId] ?? now();
    delete activity[removedTabId];
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateActivity((activity) => {
    delete activity[tabId];
  });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) await touch(tab.id);
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

/** Message API used by the options page ("Reap now") and by the test suite. */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'sweepNow') {
    sweep().then((result) => respond({ ok: true, ...result }));
    return true;
  }
  if (message?.type === 'getActivity') {
    readActivity().then((activity) => respond({ ok: true, activity, now: now() }));
    return true;
  }
  return false;
});

/**
 * Handle for the test suite, which drives the worker's own global scope and so
 * cannot use sendMessage (a worker's messages are not delivered to itself).
 */
self.__tabReaper = { sweep, readActivity, readSettings, updateActivity };

// Cover the case where the worker starts for a reason other than
// install/startup (e.g. after being evicted) — make sure the alarm exists.
scheduleSweeps();
seedAllTabs();
