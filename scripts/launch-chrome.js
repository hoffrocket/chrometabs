#!/usr/bin/env node
/**
 * Launches a throwaway Chrome with the unpacked extension loaded, so you can
 * poke at it by hand without touching your everyday browser profile.
 *
 *   npm run chrome
 *
 * The profile lives in .chrome-dev-profile/ (gitignored) and persists between
 * runs, so your settings and open tabs survive a restart. Delete it to reset.
 *
 * Chrome 151 stable removed the --load-extension switch, so this uses the
 * Chrome for Testing build that Playwright downloads. Point CHROME_PATH at
 * another binary to override.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = path.join(ROOT, 'extension');
const PROFILE = path.join(ROOT, '.chrome-dev-profile');

async function resolveBinary() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const { chromium } = await import('@playwright/test');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

const binary = await resolveBinary();
if (!binary || !fs.existsSync(binary)) {
  console.error(
    'Could not find a Chrome that supports --load-extension.\n' +
      'Run `npx playwright install chromium`, or set CHROME_PATH.',
  );
  process.exit(1);
}

fs.mkdirSync(PROFILE, { recursive: true });

const args = [
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXTENSION}`,
  `--load-extension=${EXTENSION}`,
  '--no-first-run',
  '--no-default-browser-check',
  'chrome://extensions',
];

console.log(`Launching ${path.basename(binary)} with Tab Reaper loaded.`);
console.log(`Profile: ${PROFILE}`);
console.log("Open the extension's options page to change the idle timeout.\n");

const child = spawn(binary, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
