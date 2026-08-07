/**
 * Tests for the store package itself.
 *
 * These extract the real archive with the system `unzip` rather than our own
 * reader. The ZIP writer is hand-rolled, so a bug shared between our encoder
 * and decoder would pass test/unit/zip.test.js and still produce a package the
 * store rejects. An independent implementation is the point.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildPackage } from '../../scripts/package.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let built;
async function pkg() {
  built ??= await buildPackage({ quiet: true });
  return built;
}

test('the package passes an integrity check by an independent unzip', async () => {
  const { path: zipPath } = await pkg();
  // `unzip -t` verifies every entry's CRC against its actual bytes.
  const { stdout } = await run('unzip', ['-t', zipPath]);
  assert.match(stdout, /No errors detected/);
});

test('manifest.json sits at the archive root', async () => {
  const { path: zipPath } = await pkg();
  const { stdout } = await run('unzip', ['-Z1', zipPath]);
  const names = stdout.trim().split('\n');

  // The store looks for manifest.json at the top level. Zipping the folder
  // rather than its contents is the classic mistake and the upload is rejected.
  assert.ok(names.includes('manifest.json'), `expected manifest.json at root, got: ${names}`);
  assert.ok(
    !names.some((name) => name.startsWith('extension/')),
    'the extension/ directory must not be the archive root',
  );
});

test('the extracted extension is byte-identical to the source tree', async () => {
  const { path: zipPath, files } = await pkg();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-reaper-pkg-'));
  try {
    await run('unzip', ['-q', zipPath, '-d', dir]);
    for (const name of files) {
      const [packaged, source] = await Promise.all([
        fs.readFile(path.join(dir, name)),
        fs.readFile(path.join(ROOT, 'extension', name)),
      ]);
      assert.deepEqual(packaged, source, `${name} should survive the round trip unchanged`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the package contains nothing beyond the declared file list', async () => {
  const { path: zipPath, files } = await pkg();
  const { stdout } = await run('unzip', ['-Z1', zipPath]);
  const packaged = stdout.trim().split('\n').sort();

  // The allowlist in scripts/package.js is the security boundary: anything
  // that slips in here gets published. Tests, git metadata and node_modules
  // must never appear.
  assert.deepEqual(packaged, [...files].sort());
});

test('the package carries no source maps, dotfiles or test files', async () => {
  const { path: zipPath } = await pkg();
  const { stdout } = await run('unzip', ['-Z1', zipPath]);

  for (const name of stdout.trim().split('\n')) {
    assert.ok(!name.endsWith('.map'), `${name} is a source map`);
    assert.ok(!path.basename(name).startsWith('.'), `${name} is a dotfile`);
    assert.ok(!/(^|\/)(test|node_modules)\//.test(name), `${name} should not ship`);
  }
});

test('the packaged manifest version matches the reported version', async () => {
  const { path: zipPath, version } = await pkg();
  const { stdout } = await run('unzip', ['-p', zipPath, 'manifest.json']);
  assert.equal(JSON.parse(stdout).version, version);
});

test('every file the manifest references is present in the archive', async () => {
  const { path: zipPath } = await pkg();
  const { stdout: manifestJson } = await run('unzip', ['-p', zipPath, 'manifest.json']);
  const manifest = JSON.parse(manifestJson);
  const { stdout: listing } = await run('unzip', ['-Z1', zipPath]);
  const packaged = new Set(listing.trim().split('\n'));

  const referenced = [
    manifest.background?.service_worker,
    manifest.options_page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);

  assert.ok(referenced.length > 0, 'sanity: the manifest should reference some files');
  for (const file of referenced) {
    assert.ok(packaged.has(file), `manifest references ${file}, which is missing from the package`);
  }
});

test('the service worker imports only files that are packaged', async () => {
  // The reaper logic lives in a separate module, and a relative import that
  // is not in the file list produces an extension that installs and then
  // fails at runtime with no packaging error.
  const { path: zipPath } = await pkg();
  const { stdout: listing } = await run('unzip', ['-Z1', zipPath]);
  const packaged = new Set(listing.trim().split('\n'));

  for (const entry of ['background.js', 'options.js']) {
    const { stdout: source } = await run('unzip', ['-p', zipPath, entry]);
    const imports = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
    for (const specifier of imports) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier));
      assert.ok(packaged.has(resolved), `${entry} imports ${specifier}, which is not packaged`);
    }
  }
});
