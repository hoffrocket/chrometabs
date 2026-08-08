/**
 * Tests for the CRX3 / ZIP reader used by verify-provenance.js.
 *
 * The reader is the other half of a pair: scripts/lib/zip.js writes archives
 * and this reads them. Testing one against the other alone would prove very
 * little — an encoder and decoder that share a misunderstanding agree with each
 * other perfectly. So the round-trip cases below are backed by two independent
 * checks:
 *
 *   - the system `zip` builds an archive this reader must also read, and
 *   - the corruption cases assert it *rejects* bad input rather than returning
 *     plausible-looking bytes, since a verifier that silently mis-extracts
 *     would compare garbage and report a match.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCrx, readZip } from '../../scripts/lib/crx.js';
import { zip } from '../../scripts/lib/zip.js';
import { buildPackage } from '../../scripts/package.js';

const EXTENSION_DIR = fileURLToPath(new URL('../../extension', import.meta.url));

/** Wrap a ZIP in a CRX3 container with a stub header of `headerLength` bytes. */
function wrapAsCrx(archive, { magic = 'Cr24', version = 3, headerLength = 8 } = {}) {
  const header = Buffer.alloc(12);
  header.write(magic, 0, 'latin1');
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(headerLength, 8);
  return Buffer.concat([header, Buffer.alloc(headerLength, 0x11), archive]);
}

const SAMPLE = [
  { name: 'manifest.json', data: Buffer.from('{"name":"x","version":"1.0"}') },
  // Long and repetitive, so it deflates and exercises the inflate path.
  { name: 'lib/big.js', data: Buffer.from('export const x = 1;\n'.repeat(500)) },
  // Incompressible, so it is stored rather than deflated.
  { name: 'icons/blob.png', data: Buffer.from('89504e470d0a1a0a', 'hex') },
];

test('parseCrx splits the header from the ZIP payload', () => {
  const archive = zip(SAMPLE);
  const crx = wrapAsCrx(archive, { headerLength: 1309 });
  const parsed = parseCrx(crx);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.headerLength, 1309);
  assert.deepEqual(parsed.zip, archive, 'the payload must be the ZIP, byte for byte');
});

test('parseCrx rejects anything that is not a CRX3', () => {
  const archive = zip(SAMPLE);
  assert.throws(() => parseCrx(archive), /Cr24/, 'a bare ZIP is not a CRX');
  assert.throws(() => parseCrx(wrapAsCrx(archive, { magic: 'Cr99' })), /Cr24/);
  assert.throws(() => parseCrx(wrapAsCrx(archive, { version: 2 })), /version 2/);
  assert.throws(() => parseCrx(Buffer.alloc(4)), /Cr24/);
  // A header length past the end of the file would otherwise yield an empty
  // payload, which would read as "an extension containing no files" instead of
  // as a malformed download.
  // Built by hand rather than via wrapAsCrx, which always pads to match the
  // length it declares and so cannot produce this.
  const overrun = Buffer.alloc(20);
  overrun.write('Cr24', 0, 'latin1');
  overrun.writeUInt32LE(3, 4);
  overrun.writeUInt32LE(4096, 8);
  assert.throws(() => parseCrx(overrun), /past the end/);
});

test('readZip recovers every entry, both stored and deflated', () => {
  const entries = readZip(zip(SAMPLE));
  assert.deepEqual(
    entries.map((entry) => entry.name),
    SAMPLE.map((entry) => entry.name),
  );
  for (const [i, entry] of entries.entries()) {
    assert.deepEqual(entry.data, SAMPLE[i].data, `${entry.name} did not round-trip`);
  }
});

test('readZip reads an archive built by the system zip', () => {
  // An independent encoder. Notably it writes directory entries and real
  // timestamps, neither of which our writer produces, so this is the case that
  // catches assumptions baked in from only ever reading our own output.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"version":"1.0"}');
    fs.writeFileSync(path.join(dir, 'lib', 'reaper.js'), 'export const x = 1;\n'.repeat(200));
    execFileSync('zip', ['-q', '-r', 'out.zip', '.'], { cwd: dir });

    const entries = readZip(fs.readFileSync(path.join(dir, 'out.zip')));
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));

    assert.equal(byName.get('manifest.json').toString(), '{"version":"1.0"}');
    assert.equal(byName.get('lib/reaper.js').toString(), 'export const x = 1;\n'.repeat(200));
    // Directory entries carry no content and the store adds them; they must not
    // show up as files to compare against the source.
    assert.ok(
      ![...byName.keys()].some((name) => name.endsWith('/')),
      `directory entries leaked through: ${[...byName.keys()]}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readZip rejects a tampered file rather than returning wrong bytes', () => {
  // The whole point of the verifier is catching modified code, so silently
  // extracting corrupt data is the one failure that must not happen.
  const archive = zip(SAMPLE);
  const target = archive.indexOf(Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.ok(target > 0, 'test setup: stored payload not found');
  const tampered = Buffer.from(archive);
  tampered[target] ^= 0xff;
  assert.throws(() => readZip(tampered), /CRC-32 mismatch/);
});

test('readZip rejects an archive with no end-of-central-directory record', () => {
  const archive = zip(SAMPLE);
  assert.throws(() => readZip(archive.subarray(0, archive.length - 10)), /no end-of-central/);
});

test('readZip handles an empty archive', () => {
  assert.deepEqual(readZip(zip([])), []);
});

test('readZip reads the real store package, and it matches extension/', async () => {
  // End to end on the actual artifact. The verifier compares a store download
  // against the source file by file, so the same comparison against a local
  // build has to come out clean — otherwise every real run fails for reasons
  // that have nothing to do with the store.
  // Its own output directory: test files run in parallel, so sharing dist/ with
  // package.test.js would mean reading an archive the other suite is rewriting.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-pkg-'));
  try {
    const { path: zipPath, files } = await buildPackage({ quiet: true, outDir });
    const entries = readZip(fs.readFileSync(zipPath));

    assert.deepEqual(entries.map((entry) => entry.name), files);
    for (const entry of entries) {
      const onDisk = fs.readFileSync(path.join(EXTENSION_DIR, entry.name));
      assert.deepEqual(entry.data, onDisk, `${entry.name} differs from extension/`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
