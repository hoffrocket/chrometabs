/**
 * Tests for the PNG reader and 24-bit writer.
 *
 * What actually matters here is a store requirement: listing images must be
 * 24-bit PNG with no alpha. So these tests check the encoded *bytes* against the
 * PNG spec — signature, IHDR fields, per-chunk CRC — and unfilter the scanlines
 * with an independent implementation rather than calling `decodePng`. An encoder
 * and decoder that share a misunderstanding agree with each other perfectly,
 * which is the same reason zip.test.js reads the archive by hand.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { decodePng, encodePng24 } from '../../scripts/lib/png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk the chunk list, verifying each CRC the way any real decoder would. */
function readChunks(png) {
  assert.ok(png.subarray(0, 8).equals(SIGNATURE), 'PNG signature');
  const chunks = [];
  let cursor = 8;
  while (cursor < png.length) {
    const length = png.readUInt32BE(cursor);
    const type = png.subarray(cursor + 4, cursor + 8).toString('latin1');
    const data = png.subarray(cursor + 8, cursor + 8 + length);
    const crc = png.readUInt32BE(cursor + 8 + length);
    assert.equal(
      crc,
      zlib.crc32(png.subarray(cursor + 4, cursor + 8 + length)),
      `CRC for chunk ${type}`,
    );
    chunks.push({ type, data });
    cursor += 12 + length;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Independent unfilter: decompress IDAT and reverse the scanline predictors,
 * returning `[[r, g, b], ...]` in row-major order.
 */
function unfilter(png) {
  const chunks = readChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);

  const raw = zlib.inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)),
  );
  const bpp = 3;
  const stride = width * bpp;
  assert.equal(raw.length, (stride + 1) * height, 'one filter byte plus RGB per row');

  const pixels = [];
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else assert.equal(filter, 0, `row ${y} filter type`);
      cur[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      pixels.push([cur[x * 3], cur[x * 3 + 1], cur[x * 3 + 2]]);
    }
    prev = cur;
  }
  return { width, height, pixels };
}

/** An RGBA image built from `fn(x, y) -> [r, g, b, a]`. */
function image(width, height, fn) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = fn(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

test('IHDR declares 8-bit truecolour with no alpha channel', () => {
  const png = encodePng24(image(3, 2, () => [10, 20, 30]));
  const ihdr = readChunks(png).find((c) => c.type === 'IHDR');

  assert.equal(ihdr.data.length, 13, 'IHDR is 13 bytes');
  assert.equal(ihdr.data.readUInt32BE(0), 3, 'width');
  assert.equal(ihdr.data.readUInt32BE(4), 2, 'height');
  assert.equal(ihdr.data[8], 8, 'bit depth: 8 per channel');
  // Colour type 2 is truecolour without alpha. This is the whole point of the
  // module: the Chrome Web Store rejects the type 6 (RGBA) that browsers write.
  assert.equal(ihdr.data[9], 2, 'colour type: truecolour, no alpha');
  assert.equal(ihdr.data[10], 0, 'compression: deflate');
  assert.equal(ihdr.data[11], 0, 'filter method: adaptive');
  assert.equal(ihdr.data[12], 0, 'interlace: none');
});

test('chunks appear in the order the spec requires and end with IEND', () => {
  const png = encodePng24(image(2, 2, () => [0, 0, 0]));
  const types = readChunks(png).map((c) => c.type);

  assert.equal(types[0], 'IHDR', 'IHDR must come first');
  assert.equal(types.at(-1), 'IEND', 'IEND must come last');
  assert.ok(types.includes('IDAT'), 'pixel data present');
  // readChunks asserts every CRC, so reaching here means all of them matched.
});

test('opaque pixels survive the round trip byte for byte', () => {
  // A gradient in every channel, so a swapped or dropped channel shows up.
  const source = image(16, 9, (x, y) => [x * 16, y * 28, 255 - x * 16]);
  const { width, height, pixels } = unfilter(encodePng24(source));

  assert.equal(width, 16);
  assert.equal(height, 9);
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      assert.deepEqual(pixels[y * 16 + x], [x * 16, y * 28, 255 - x * 16], `pixel ${x},${y}`);
    }
  }
});

test('transparent pixels are composited onto the background, not just stripped', () => {
  // Alpha 0 over white must read as white. Discarding alpha instead of
  // compositing would leave the underlying colour (here, red) visible — which
  // for a real screenshot means black fringes around shadows.
  const source = image(1, 3, (_x, y) => [255, 0, 0, [0, 128, 255][y]]);
  const { pixels } = unfilter(encodePng24(source, { background: [255, 255, 255] }));

  assert.deepEqual(pixels[0], [255, 255, 255], 'fully transparent → pure background');
  assert.deepEqual(pixels[2], [255, 0, 0], 'fully opaque → source colour');

  const [r, g, b] = pixels[1];
  assert.equal(r, 255, 'half-transparent red keeps a full red channel over white');
  // 0 * 128/255 + 255 * 127/255 ≈ 127.
  assert.ok(Math.abs(g - 127) <= 1, `green composited to ~127, got ${g}`);
  assert.equal(g, b, 'green and blue composite identically from equal inputs');
});

test('a non-white background is honoured', () => {
  const source = image(1, 1, () => [0, 0, 0, 0]);
  const { pixels } = unfilter(encodePng24(source, { background: [18, 52, 86] }));
  assert.deepEqual(pixels[0], [18, 52, 86]);
});

test('filtering shrinks a flat image well below its raw size', () => {
  // A flat fill is the case row filters exist for. If the filter selection were
  // broken — always emitting type 0, say — this would barely compress.
  const png = encodePng24(image(200, 200, () => [200, 210, 220]));
  assert.ok(png.length < 200 * 200 * 3 * 0.02, `expected heavy compression, got ${png.length} bytes`);
});

test('decodePng reads back what encodePng24 writes, as RGBA', () => {
  const source = image(5, 4, (x, y) => [x * 40, y * 60, 128]);
  const decoded = decodePng(encodePng24(source));

  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 4);
  assert.equal(decoded.data.length, 5 * 4 * 4, 'widened back out to RGBA');
  for (let i = 0; i < 5 * 4; i += 1) {
    // Alpha is synthesized as opaque, since a type-2 PNG has no alpha to read.
    assert.equal(decoded.data[i * 4 + 3], 255, `pixel ${i} alpha`);
  }
  assert.deepEqual([...decoded.data.subarray(0, 3)], [0, 0, 128], 'first pixel');
});

test('decodePng rejects input that is not a PNG', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /bad signature/);
});

test('decodePng refuses formats it would otherwise misread', () => {
  // Silently misreading an interlaced or 16-bit PNG would produce garbled
  // pixels rather than an error, so the guards are worth pinning down.
  const png = encodePng24(image(2, 2, () => [1, 2, 3]));

  const interlaced = Buffer.from(png);
  interlaced[8 + 8 + 12] = 1; // IHDR interlace byte
  assert.throws(() => decodePng(interlaced), /Interlaced/);

  const deep = Buffer.from(png);
  deep[8 + 8 + 8] = 16; // IHDR bit depth
  assert.throws(() => decodePng(deep), /bit depth 16/);
});

test('encodePng24 rejects a buffer that does not match its dimensions', () => {
  assert.throws(
    () => encodePng24({ width: 4, height: 4, data: Buffer.alloc(10) }),
    /Expected 64 RGBA bytes/,
  );
});
