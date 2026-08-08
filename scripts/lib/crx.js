/**
 * Read a CRX3 file — the format Chrome actually downloads and installs.
 *
 * A CRX3 is a small signed header followed by an ordinary ZIP:
 *
 *   "Cr24"                 4 bytes, magic
 *   version                4 bytes LE, 3 for CRX3
 *   headerLength           4 bytes LE
 *   CrxFileHeader          headerLength bytes, protobuf (signatures + key)
 *   ZIP archive            the rest of the file
 *
 * Only the container is parsed here. The protobuf header carries Google's and
 * the publisher's signatures over the ZIP, but verifying those would mean
 * pinning Google's key — and the signature that matters for provenance is the
 * one inside the ZIP, in `_metadata/verified_contents.json`, which names every
 * file individually. See scripts/verify-provenance.js.
 *
 * The ZIP reader reads the central directory rather than scanning for local
 * headers: the central directory is the authoritative index, and a file whose
 * bytes are present but unlisted is not something an extractor would surface.
 */
import zlib from 'node:zlib';

import { crc32 } from './zip.js';

const CRX_MAGIC = 'Cr24';
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Split a CRX3 into its header metadata and the ZIP payload. */
export function parseCrx(buffer) {
  if (buffer.length < 16 || buffer.subarray(0, 4).toString('latin1') !== CRX_MAGIC) {
    throw new Error('Not a CRX file (missing "Cr24" magic)');
  }
  const version = buffer.readUInt32LE(4);
  if (version !== 3) {
    throw new Error(`Unsupported CRX version ${version}; only CRX3 is understood`);
  }
  const headerLength = buffer.readUInt32LE(8);
  const zipOffset = 12 + headerLength;
  if (zipOffset > buffer.length) {
    throw new Error('CRX header length runs past the end of the file');
  }
  return { version, headerLength, zip: buffer.subarray(zipOffset) };
}

/**
 * Read every entry from a ZIP archive as `[{ name, data }]`.
 *
 * Directory entries (names ending in `/`) are skipped — the store adds them and
 * they carry no content.
 */
export function readZip(buffer) {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) {
      throw new Error(`Corrupt central directory at entry ${i}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    // The local header repeats the name and extra field, and its extra field
    // length can differ from the central one, so read it rather than assuming.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(start, start + compressedSize);

    let data;
    if (method === METHOD_STORE) {
      data = Buffer.from(payload);
    } else if (method === METHOD_DEFLATE) {
      data = zlib.inflateRawSync(payload);
    } else {
      throw new Error(`Entry ${name} uses unsupported compression method ${method}`);
    }

    // A CRC mismatch means the extraction is wrong, and every hash comparison
    // downstream would be comparing against garbage.
    if (data.length !== uncompressedSize) {
      throw new Error(`Entry ${name}: expected ${uncompressedSize} bytes, extracted ${data.length}`);
    }
    if (crc32(data) !== checksum) {
      throw new Error(`Entry ${name}: CRC-32 mismatch, the archive is corrupt`);
    }

    entries.push({ name, data });
  }

  return entries;
}

/**
 * Locate the end-of-central-directory record.
 *
 * It sits at the end of the file but may be followed by a comment of up to
 * 65535 bytes, so it has to be searched for backwards.
 */
function findEocd(buffer) {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= earliest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('Not a ZIP archive (no end-of-central-directory record)');
}
