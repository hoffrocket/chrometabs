/**
 * A minimal ZIP writer, enough to produce a Chrome Web Store upload package.
 *
 * Node has zlib but no archive format, and the project takes no third-party
 * dependencies — so the container format is built here. Only what the store
 * needs is implemented: stored/deflated file entries, no directory entries,
 * no Zip64, no encryption.
 *
 * Archives are byte-for-byte reproducible on any machine: entry order is
 * caller-controlled, every timestamp is fixed, and entries are **stored rather
 * than deflated** by default. That last point is not an optimisation choice —
 * it is what makes the digest meaningful.
 *
 * Deflate output is not standardised. Measured across five Node versions, the
 * same input produced two different archives:
 *
 *   node 16 (zlib 1.2.11), node 26 (zlib 1.2.12)      -> 1195ee5b…
 *   node 20, 22 (zlib 1.3.0.1-motley), node 24 (1.3.1) -> 0c812d88…
 *
 * So a compressed archive's hash depends on the toolchain that built it, and
 * "rebuild it yourself and compare the digest" would fail for anyone on a
 * different Node — exactly the people a provenance claim is aimed at. Storing
 * costs about 23% more bytes (63 KB -> 77 KB here) and buys a digest that
 * anyone can reproduce forever. The store recompresses uploads anyway, so the
 * compression never reached users in the first place.
 *
 * `compress: true` re-enables deflate for callers that want small over
 * reproducible.
 */
import zlib from 'node:zlib';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// ZIP stores timestamps as MS-DOS date/time, which cannot represent anything
// before 1980. A fixed value keeps output reproducible; the store does not
// care what it says.
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (1980 - 1980) << 9 | (1 << 5) | 1; // 1980-01-01

// Unix mode 0644 in the high 16 bits, which is where ZIP keeps it. Without
// this, some extractors produce files with no permission bits at all.
// `>>> 0` because JS bitwise ops are signed: the shift alone lands past
// 2^31 and comes back negative, which writeUInt32LE rejects.
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive from `[{ name, data }]`.
 *
 * `name` is the path inside the archive and must use forward slashes — the
 * spec requires it, and a backslash would make the entry unreadable on the
 * store's side.
 */
export function zip(entries, { compress = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (entry.name.includes('\\')) {
      throw new Error(`zip entry name must use forward slashes: ${entry.name}`);
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);

    // When compressing, deflate then keep it only if it actually helped: tiny
    // or already-compressed files (the PNGs) can deflate *larger* than they
    // started. Off by default — see the note on reproducibility above.
    const deflated = compress ? zlib.deflateRawSync(data, { level: 9 }) : null;
    const useDeflate = deflated !== null && deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed to extract: 2.0
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    central.writeUInt16LE(0x031e, 4); // version made by: 3.0, Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(EXTERNAL_ATTRS, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDirectory, eocd]);
}
