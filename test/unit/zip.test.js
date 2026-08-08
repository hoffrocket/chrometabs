/**
 * Tests for the hand-rolled ZIP writer.
 *
 * The archive format is written by hand here, so these tests check the bytes
 * against the spec rather than trusting a round-trip through our own reader —
 * an encoder and decoder that share a misunderstanding agree with each other
 * perfectly. `test/unit/package.test.js` complements this by extracting a real
 * package with the system `unzip`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { crc32, zip } from '../../scripts/lib/zip.js';

const EOCD_SIG = 0x06054b50;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;

/** Minimal reader: walk the central directory the way a real extractor does. */
function readCentralDirectory(archive) {
  const eocdOffset = archive.length - 22;
  assert.equal(archive.readUInt32LE(eocdOffset), EOCD_SIG, 'end-of-central-directory signature');

  const count = archive.readUInt16LE(eocdOffset + 10);
  const size = archive.readUInt32LE(eocdOffset + 12);
  const start = archive.readUInt32LE(eocdOffset + 16);
  assert.equal(start + size, eocdOffset, 'central directory should end where the EOCD begins');

  const entries = [];
  let offset = start;
  for (let i = 0; i < count; i += 1) {
    assert.equal(archive.readUInt32LE(offset), CENTRAL_SIG, `central header ${i} signature`);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const externalAttrs = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    // Follow the pointer into the local header and pull the payload back out.
    assert.equal(archive.readUInt32LE(localOffset), LOCAL_SIG, `local header for ${name}`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? payload : zlib.inflateRawSync(payload);

    entries.push({ name, method, crc, compressedSize, uncompressedSize, externalAttrs, data });
    offset += 46 + nameLength;
  }
  return entries;
}

test('crc32 matches the known check value for "123456789"', () => {
  // The standard CRC-32 check value, so this pins the table rather than
  // just agreeing with itself.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('crc32 of empty input is zero', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('an archive round-trips names and contents', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"manifest_version":3}') },
    { name: 'lib/nested.js', data: Buffer.from('export const a = 1;\n') },
  ];
  const read = readCentralDirectory(zip(entries));

  assert.deepEqual(
    read.map((e) => e.name),
    ['manifest.json', 'lib/nested.js'],
    'entry order is preserved, including the nested path',
  );
  assert.equal(read[0].data.toString(), '{"manifest_version":3}');
  assert.equal(read[1].data.toString(), 'export const a = 1;\n');
});

test('every entry records a correct CRC and uncompressed size', () => {
  const data = Buffer.from('a'.repeat(500));
  const [entry] = readCentralDirectory(zip([{ name: 'a.txt', data }]));

  assert.equal(entry.crc, crc32(data));
  assert.equal(entry.uncompressedSize, data.length);
});

test('data is stored, not deflated, by default', () => {
  // Deliberate: deflate output varies by zlib version, so a compressed archive
  // has a different digest depending on the Node that built it. Storing is what
  // makes "rebuild it and compare the hash" work for someone else. See the note
  // at the top of scripts/lib/zip.js.
  const data = Buffer.from('x'.repeat(2000));
  const [entry] = readCentralDirectory(zip([{ name: 'big.txt', data }]));

  assert.equal(entry.method, 0, 'stored');
  assert.equal(entry.compressedSize, data.length);
  assert.equal(entry.data.toString(), data.toString());
});

test('compress: true deflates what is worth deflating', () => {
  const data = Buffer.from('x'.repeat(2000));
  const [entry] = readCentralDirectory(zip([{ name: 'big.txt', data }], { compress: true }));

  assert.equal(entry.method, 8, 'deflate');
  assert.ok(entry.compressedSize < data.length, 'should actually be smaller');
  assert.equal(entry.data.toString(), data.toString());
});

test('compress: true still stores incompressible data', () => {
  // Deflating random bytes produces *more* bytes than it started with, so the
  // writer has to notice and fall back to storing.
  const data = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xf3, 0x21, 0x9c, 0x7d,
  ]);
  const [entry] = readCentralDirectory(zip([{ name: 'noise.png', data }], { compress: true }));

  assert.equal(entry.method, 0, 'stored');
  assert.equal(entry.compressedSize, data.length);
  assert.deepEqual(entry.data, data);
});

test('entries carry a readable unix mode', () => {
  const [entry] = readCentralDirectory(zip([{ name: 'a.txt', data: Buffer.from('hi') }]));

  // High 16 bits hold the unix mode. Without it some extractors produce files
  // with no permission bits at all.
  assert.equal(entry.externalAttrs >>> 16, 0o100644);
});

test('the same input always produces identical bytes', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"a":1}') },
    { name: 'b.js', data: Buffer.from('const b = 2;') },
  ];
  assert.deepEqual(zip(entries), zip(entries), 'timestamps must not vary between builds');
});

test('the archive contains no output from zlib', () => {
  // The provenance claim is "rebuild this and you get the same digest", which
  // holds across machines only if nothing in the archive depends on the local
  // zlib. Measured: with deflate on, five Node versions produced two different
  // digests (zlib 1.2.x vs 1.3.x). This asserts the property directly, so
  // switching the default back to compressing fails here rather than silently
  // making published digests unreproducible.
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"version":"1.0"}') },
    { name: 'big.js', data: Buffer.from('export const x = 1;\n'.repeat(500)) },
  ];
  for (const entry of readCentralDirectory(zip(entries))) {
    assert.equal(entry.method, 0, `${entry.name} is compressed, so its bytes depend on zlib`);
  }
});

test('an empty archive is still structurally valid', () => {
  assert.deepEqual(readCentralDirectory(zip([])), []);
});

test('backslashes in entry names are rejected', () => {
  // ZIP requires forward slashes; a Windows-style path would be unreadable.
  assert.throws(() => zip([{ name: 'lib\\reaper.js', data: Buffer.from('x') }]), /forward slashes/);
});

test('utf-8 names are length-prefixed by bytes, not characters', () => {
  const [entry] = readCentralDirectory(zip([{ name: 'café.txt', data: Buffer.from('x') }]));
  assert.equal(entry.name, 'café.txt');
});
