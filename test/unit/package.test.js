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
import zlib from 'node:zlib';
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

test('every packaged icon is the size the manifest declares', async () => {
  // A PNG's real dimensions are in its IHDR chunk, so this needs no browser.
  // Chrome scales a mismatched icon silently and the manifest keeps claiming
  // whatever it likes — which is how every icon here once shipped at 4x its
  // declared size (the rasterizer rendered at 4x and never downscaled),
  // quadrupling the package. The store, unlike Chrome, checks.
  const { path: zipPath } = await pkg();
  const { stdout: manifestJson } = await run('unzip', ['-p', zipPath, 'manifest.json']);
  const manifest = JSON.parse(manifestJson);

  const declared = { ...(manifest.icons ?? {}), ...(manifest.action?.default_icon ?? {}) };
  assert.ok(Object.keys(declared).length > 0, 'the manifest should declare icons');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'icon-size-'));
  try {
    for (const [size, relative] of Object.entries(declared)) {
      await run('unzip', ['-o', '-q', zipPath, relative, '-d', dir]);
      const { width, height } = readPngSize(await fs.readFile(path.join(dir, relative)));
      assert.deepEqual(
        { width, height },
        { width: Number(size), height: Number(size) },
        `${relative} is declared as ${size}px but is ${width}x${height}`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the store listing icon meets the store's own requirements", async () => {
  // Not part of the extension, so nothing else would catch it drifting. The
  // store requires exactly 128x128; the 96x96 inset is its guidance, since it
  // draws shadow and hover effects in the margin.
  const png = await fs.readFile(path.join(ROOT, 'assets', 'store', 'store-icon-128.png'));
  assert.deepEqual(readPngSize(png), { width: 128, height: 128 });

  // Confirm the art really is inset, rather than the file merely being 128px:
  // the outermost 16px ring must be fully transparent.
  const { width, height, pixels } = decodePng(png);
  let maxAlphaInMargin = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inMargin = x < 16 || y < 16 || x >= width - 16 || y >= height - 16;
      if (inMargin) maxAlphaInMargin = Math.max(maxAlphaInMargin, pixels[(y * width + x) * 4 + 3]);
    }
  }
  assert.equal(maxAlphaInMargin, 0, 'the outer 16px margin should be empty');
});

/** Read width/height out of a PNG's IHDR chunk. */
function readPngSize(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('latin1'), 'PNG', 'not a PNG');
  // IHDR is always the first chunk: 8-byte signature, 4-byte length, 4-byte type.
  assert.equal(buffer.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Decode an 8-bit RGBA PNG to raw pixels.
 *
 * Node has zlib but no image decoder, and the project takes no dependencies, so
 * the ~20 lines of PNG un-filtering live here. Only what these tests need is
 * handled: colour type 6, bit depth 8, non-interlaced — which is what Chrome's
 * screenshots produce. Anything else throws rather than returning wrong pixels.
 */
function decodePng(buffer) {
  let offset = 8;
  let width;
  let height;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      assert.equal(buffer[offset + 16], 8, 'expected 8-bit depth');
      assert.equal(buffer[offset + 17], 6, 'expected colour type 6 (RGBA)');
      assert.equal(buffer[offset + 20], 0, 'expected a non-interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }

  // Each row is prefixed with a filter byte and encoded relative to the pixel
  // to its left (`a`), the row above (`b`), and above-left (`c`).
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp + 1;
  const pixels = Buffer.alloc(width * height * bpp);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    const row = pixels.subarray(y * width * bpp, (y + 1) * width * bpp);
    raw.copy(row, 0, y * stride + 1, y * stride + 1 + width * bpp);

    for (let i = 0; i < width * bpp; i += 1) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * width * bpp + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[(y - 1) * width * bpp + i - bpp] : 0;
      if (filter === 1) row[i] = (row[i] + a) & 0xff;
      else if (filter === 2) row[i] = (row[i] + b) & 0xff;
      else if (filter === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${filter} on row ${y}`);
      }
    }
  }

  return { width, height, pixels };
}
