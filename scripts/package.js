/**
 * Build the Chrome Web Store upload package: `npm run package`.
 *
 * Writes dist/tab-reaper-<version>.zip containing the contents of extension/
 * with extension/ itself as the archive root (the store expects manifest.json
 * at the top level, not nested in a folder).
 *
 * The file list is an explicit allowlist rather than a directory walk with
 * exclusions. A packaging script that ships whatever it finds is one stray
 * file away from publishing something private, and the failure is silent —
 * the upload succeeds. Adding a file to the extension means adding it here,
 * and the manifest cross-check below makes forgetting it loud.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zip } from './lib/zip.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION_DIR = path.join(ROOT, 'extension');
const DIST_DIR = path.join(ROOT, 'dist');

/**
 * Everything that ships, relative to extension/. Order fixes archive order.
 *
 * Exported because it is the authoritative list of what a published build
 * should contain: `verify-provenance.js` checks the store download against it
 * in both directions, and the packaging tests assert the archive holds exactly
 * this and nothing else.
 */
export const FILES = [
  'manifest.json',
  'background.js',
  'lib/reaper.js',
  'options.html',
  'options.css',
  'options.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

/**
 * Fail if the manifest references a file the package does not carry.
 *
 * A missing icon or a renamed script produces an extension that installs and
 * then breaks at runtime, which is exactly the kind of thing that reaches
 * users when packaging is automated. Only the paths the manifest states
 * outright are checked — this deliberately does not parse JS imports.
 */
function manifestReferences(manifest) {
  const referenced = new Set();
  const add = (value) => {
    if (typeof value === 'string') referenced.add(value);
  };

  add(manifest.background?.service_worker);
  add(manifest.options_page);
  Object.values(manifest.icons ?? {}).forEach(add);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  (manifest.web_accessible_resources ?? []).forEach((entry) =>
    (entry.resources ?? []).forEach(add),
  );
  (manifest.content_scripts ?? []).forEach((script) => {
    (script.js ?? []).forEach(add);
    (script.css ?? []).forEach(add);
  });

  return referenced;
}

/**
 * Build the archive and return `{ path, version, bytes, files }`.
 *
 * `outDir` exists for tests: `node --test` runs files in parallel, so two suites
 * both building into `dist/` will write the same path at the same time and one
 * can read a half-written archive. Passing separate directories removes the
 * race rather than papering over it with retries.
 */
export async function buildPackage({ quiet = false, outDir = DIST_DIR } = {}) {
  const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const { version } = manifest;

  if (!/^\d+(\.\d+){0,3}$/.test(version ?? '')) {
    throw new Error(
      `manifest version must be 1-4 dot-separated integers, got ${JSON.stringify(version)}`,
    );
  }

  const packaged = new Set(FILES);
  const missing = [...manifestReferences(manifest)].filter((file) => !packaged.has(file));
  if (missing.length > 0) {
    throw new Error(
      `manifest.json references files that scripts/package.js does not include: ${missing.join(', ')}`,
    );
  }

  const entries = [];
  for (const name of FILES) {
    // Read every file before writing anything, so a typo in FILES fails
    // without leaving a half-built archive behind.
    entries.push({ name, data: await fs.readFile(path.join(EXTENSION_DIR, name)) });
  }

  const archive = zip(entries);
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `tab-reaper-${version}.zip`);
  await fs.writeFile(outPath, archive);

  if (!quiet) {
    const kb = (archive.length / 1024).toFixed(1);
    console.log(`Packaged ${entries.length} files -> ${path.relative(ROOT, outPath)} (${kb} KB)`);
  }

  return { path: outPath, version, bytes: archive.length, files: FILES };
}

// Only run when invoked directly, so the publish script can import it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildPackage().catch((error) => {
    console.error(`Packaging failed: ${error.message}`);
    process.exit(1);
  });
}
