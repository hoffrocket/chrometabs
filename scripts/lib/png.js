/**
 * Minimal PNG reader and 24-bit writer.
 *
 * This exists for one reason: the Chrome Web Store requires listing images to
 * be "JPEG or 24-bit PNG (no alpha)", and every PNG a browser produces —
 * `page.screenshot()`, `canvas.toDataURL()` — is 32-bit RGBA. The store
 * rejects those, so a capture has to be flattened onto an opaque background and
 * re-encoded without an alpha channel.
 *
 * Rather than add an image-processing dependency for that one conversion, the
 * two chunks that matter are handled here. A PNG is a signature followed by
 * length-prefixed chunks; the pixels live in IDAT as zlib-compressed,
 * per-scanline-filtered rows, and `node:zlib` does the compression.
 *
 * Scope is deliberately narrow — 8 bits per channel, non-interlaced, no
 * palette. That covers what Chrome writes, and anything else throws rather than
 * being silently misread.
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel for each PNG colour type, at 8 bits per channel. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

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

/** PNG uses the same CRC-32 as ZIP, but over `type + data` per chunk. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/**
 * Decode a PNG to `{ width, height, data }`, where `data` is RGBA regardless of
 * the source colour type — callers get one pixel layout to reason about.
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature)');
  }

  let header;
  const idat = [];
  let cursor = 8;
  while (cursor + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.subarray(cursor + 4, cursor + 8).toString('latin1');
    const data = buffer.subarray(cursor + 8, cursor + 8 + length);
    cursor += 12 + length;

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!header) throw new Error('PNG has no IHDR chunk');
  if (header.depth !== 8) throw new Error(`Unsupported PNG bit depth ${header.depth}; expected 8`);
  if (header.interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  const bpp = CHANNELS[header.colorType];
  if (!bpp) throw new Error(`Unsupported PNG colour type ${header.colorType}`);

  const { width, height } = header;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) {
    throw new Error('PNG pixel data is shorter than IHDR promises');
  }

  // Undo the per-scanline filters in place. Each row is prefixed with its
  // filter byte and predicts from the pixel to the left (`a`), the row above
  // (`b`), and above-left (`c`) — so rows must be processed in order.
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = line[i]; break;
        case 1: value = line[i] + a; break;
        case 2: value = line[i] + b; break;
        case 3: value = line[i] + ((a + b) >> 1); break;
        case 4: value = line[i] + paeth(a, b, c); break;
        default: throw new Error(`Unknown PNG filter type ${filter} on row ${y}`);
      }
      out[i] = value & 0xff;
    }
  }

  // Widen whatever came in to RGBA.
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    const src = p * bpp;
    const dst = p * 4;
    switch (header.colorType) {
      case 0: // grey
        data.fill(pixels[src], dst, dst + 3);
        data[dst + 3] = 255;
        break;
      case 4: // grey + alpha
        data.fill(pixels[src], dst, dst + 3);
        data[dst + 3] = pixels[src + 1];
        break;
      case 2: // RGB
        pixels.copy(data, dst, src, src + 3);
        data[dst + 3] = 255;
        break;
      default: // RGBA
        pixels.copy(data, dst, src, src + 4);
    }
  }

  return { width, height, data };
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
 * Encode RGBA pixels as a 24-bit (colour type 2) PNG, dropping the alpha
 * channel by compositing over `background`.
 *
 * Flattening rather than just discarding alpha matters: discarding it would
 * reveal whatever colour happened to sit under a transparent pixel, which for a
 * browser screenshot is black — semi-transparent shadows and rounded corners
 * would come out with dark fringes.
 */
export function encodePng24({ width, height, data }, { background = [255, 255, 255] } = {}) {
  if (data.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} RGBA bytes, got ${data.length}`);
  }

  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);

  // Previous *unfiltered* row, needed by the Up/Average/Paeth predictors.
  let prev = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const alpha = data[src + 3] / 255;
      for (let c = 0; c < 3; c += 1) {
        current[x * 3 + c] = Math.round(data[src + c] * alpha + background[c] * (1 - alpha));
      }
    }

    // Try every filter and keep the one whose output has the smallest sum of
    // absolute differences — the heuristic the PNG spec suggests. On a flat UI
    // screenshot this is the difference between a ~2MB file and a ~200KB one.
    const filtered = rows.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    let best = null;
    for (let type = 0; type <= 4; type += 1) {
      const candidate = filterRow(type, current, prev, stride, 3);
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        // Filtered bytes are modulo-256, so read them as signed distance from 0.
        score += candidate[i] < 128 ? candidate[i] : 256 - candidate[i];
      }
      if (best === null || score < best.score) best = { type, candidate, score };
    }
    filtered[0] = best.type;
    best.candidate.copy(filtered, 1);

    const swap = prev;
    prev = current;
    current = swap;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function filterRow(type, row, prev, stride, bpp) {
  const out = Buffer.alloc(stride);
  for (let i = 0; i < stride; i += 1) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    switch (type) {
      case 0: out[i] = row[i]; break;
      case 1: out[i] = row[i] - a; break;
      case 2: out[i] = row[i] - b; break;
      case 3: out[i] = row[i] - ((a + b) >> 1); break;
      default: out[i] = row[i] - paeth(a, b, c);
    }
  }
  return out;
}
