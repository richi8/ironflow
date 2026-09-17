/**
 * A minimal PNG encoder, for the dev tools under `tools/`. See C19 task 7.
 *
 * The minimap tool has to hand back something a human can look at, and a PNG
 * is a length-prefixed header, a zlib stream of filtered scanlines and three
 * CRCs. Node ships zlib, so the whole format costs about eighty lines — which
 * is less than the argument for adding an image dependency to a project whose
 * §3 policy is "a dependency must save more than it costs".
 *
 * Truecolour, 8 bits per channel, no alpha, filter type 0 on every row. None
 * of the format's other modes would make a map of coloured tiles smaller or
 * clearer.
 */

import { deflateSync } from 'node:zlib';

/** The eight bytes every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, as PNG specifies it: reflected, polynomial 0xedb88320. */
const CRC_TABLE = ((): Int32Array => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * Encode an RGB bitmap, three bytes per pixel, row-major from the top left.
 *
 * `rgb.length` must be exactly `width * height * 3`; a mismatch is a caller
 * bug that would otherwise produce a file that opens skewed rather than one
 * that fails.
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new RangeError(`encodePng: expected ${expected} bytes for ${width}x${height}, got ${rgb.length}.`);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type 2: truecolour
  header.writeUInt8(0, 10); // deflate
  header.writeUInt8(0, 11); // adaptive filtering
  header.writeUInt8(0, 12); // no interlace

  // Every scanline is prefixed with its filter type. Zero — "none" — because
  // the image is flat colour regions where a predictor buys almost nothing and
  // the zlib pass already collapses the runs.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
