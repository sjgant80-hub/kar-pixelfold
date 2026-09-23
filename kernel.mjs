// kernel.mjs — kar-pixelfold: a LOSSLESS byte <-> pixel-grid codec.
//
// The core promise, and the only thing this file is for: decode(encode(x)) === x, byte-exact,
// for ARBITRARY bytes — not just text, any input, including empty input and input containing
// every byte value 0-255. A visual you can verify, not just look at.
//
// Frame layout (grounded in the estate's own established pattern — mctp-multi-carrier-transport's
// checksum-verified frame, one-ladder's [VER · data · CHK] — connect, don't invent):
//   [4 bytes: length, big-endian uint32] [2 bytes: CRC-16/CCITT-FALSE of the PAYLOAD]
//   [length bytes: the payload] [0-2 zero bytes: padding to a multiple of 3]
// The header's length field is what decode trusts to know where the real payload ends — never a
// null terminator, so payloads containing 0x00 bytes round-trip exactly like any other byte. The
// CRC is what makes this a VERIFIED round-trip: a single flipped pixel is caught and named, not
// silently returned as if nothing happened.
//
// Pixels: each cell carries one RGB triplet (3 bytes), row-major, as square a grid as the pixel
// count allows. Total functions throughout: bad input returns { ok:false, why }, never a throw.

const HEADER_BYTES = 6; // 4 (length) + 2 (crc16)
const MAX_LEN = 0xFFFFFFFF;

// CRC-16/CCITT-FALSE — reused verbatim from mctp-multi-carrier-transport's mctp.mjs (the estate's
// own proven, dependency-free implementation), not reinvented. Exported so it can be checked
// against the algorithm's own standard test vector, not just its self-consistency within this
// file (encode and decode both call the same function, so a subtly-wrong-but-still-internally-
// consistent implementation would pass every round-trip test and still be the wrong algorithm).
export function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function isBytesLike(x) {
  if (x instanceof Uint8Array) return true;
  if (!Array.isArray(x)) return false;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (!Number.isInteger(v) || v < 0 || v > 255) return false; }
  return true;
}

function isByteValue(v) { return Number.isInteger(v) && v >= 0 && v <= 255; }

// encode(bytes) -> { ok:true, width, height, pixels:[{x,y,r,g,b}] } | { ok:false, why }
export function encode(bytes) {
  if (!isBytesLike(bytes)) return { ok: false, why: 'bytes must be a Uint8Array or an array of byte values (0-255)' };
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (data.length > MAX_LEN) return { ok: false, why: 'input exceeds the max encodable length (4,294,967,295 bytes)' };

  const crc = crc16(data);
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = (data.length >>> 24) & 0xff;
  header[1] = (data.length >>> 16) & 0xff;
  header[2] = (data.length >>> 8) & 0xff;
  header[3] = data.length & 0xff;
  header[4] = (crc >>> 8) & 0xff;
  header[5] = crc & 0xff;

  const framedLen = HEADER_BYTES + data.length;
  const rem = framedLen % 3;
  const padLen = rem === 0 ? 0 : 3 - rem;
  const framed = new Uint8Array(framedLen + padLen); // zero-filled; padding is never trusted on decode
  framed.set(header, 0);
  framed.set(data, HEADER_BYTES);

  const pixelCount = framed.length / 3;
  const width = Math.max(1, Math.ceil(Math.sqrt(pixelCount)));
  const height = Math.max(1, Math.ceil(pixelCount / width));
  const cells = width * height;

  const pixels = new Array(cells);
  for (let i = 0; i < cells; i++) {
    const base = i * 3;
    const r = base < framed.length ? framed[base] : 0;
    const g = base + 1 < framed.length ? framed[base + 1] : 0;
    const b = base + 2 < framed.length ? framed[base + 2] : 0;
    pixels[i] = { x: i % width, y: Math.floor(i / width), r, g, b };
  }
  return { ok: true, width, height, pixels };
}

// decode({width,height,pixels}) -> { ok:true, bytes:Uint8Array } | { ok:false, why }
export function decode(grid) {
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return { ok: false, why: 'grid must be an object' };
  const { width, height, pixels } = grid;
  if (!Number.isInteger(width) || width <= 0) return { ok: false, why: 'width must be a positive integer' };
  if (!Number.isInteger(height) || height <= 0) return { ok: false, why: 'height must be a positive integer' };
  if (!Array.isArray(pixels)) return { ok: false, why: 'pixels must be an array' };
  const cells = width * height;
  if (pixels.length !== cells) return { ok: false, why: `pixels length (${pixels.length}) does not match width*height (${cells})` };

  // Reconstruct by (x,y) regardless of array order — total, never trusts input ordering.
  // Note: with pixels.length === cells already enforced above, catching every duplicate
  // coordinate here is sufficient to guarantee full coverage by construction (pigeonhole:
  // `cells` pairwise-distinct indices drawn from a space of exactly `cells` possible values
  // must cover all of them) — so there is no separate "missing cell" case left to check.
  const seen = new Array(cells).fill(false);
  const raw = new Uint8Array(cells * 3);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    if (!p || typeof p !== 'object') return { ok: false, why: `pixel at index ${i} must be an object` };
    const { x, y, r, g, b } = p;
    if (!Number.isInteger(x) || x < 0 || x >= width) return { ok: false, why: `pixel at index ${i} has an out-of-range x` };
    if (!Number.isInteger(y) || y < 0 || y >= height) return { ok: false, why: `pixel at index ${i} has an out-of-range y` };
    if (!isByteValue(r) || !isByteValue(g) || !isByteValue(b)) return { ok: false, why: `pixel at (${x},${y}) has a channel outside 0-255` };
    const idx = y * width + x;
    if (seen[idx]) return { ok: false, why: `duplicate pixel at (${x},${y})` };
    seen[idx] = true;
    raw[idx * 3] = r; raw[idx * 3 + 1] = g; raw[idx * 3 + 2] = b;
  }

  if (raw.length < HEADER_BYTES) return { ok: false, why: 'grid is too small to contain a header' };
  const len = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  const declaredCrc = ((raw[4] << 8) | raw[5]) & 0xffff;
  if (HEADER_BYTES + len > raw.length) return { ok: false, why: 'declared length exceeds the available payload — corrupted grid' };
  const payload = raw.slice(HEADER_BYTES, HEADER_BYTES + len);
  const actualCrc = crc16(payload);
  if (actualCrc !== declaredCrc) return { ok: false, why: `corrupted — CRC mismatch (declared ${declaredCrc.toString(16)}, computed ${actualCrc.toString(16)})` };
  return { ok: true, bytes: payload };
}

// roundTrips(bytes) -> true|false — the core promise, checkable in one call. Never throws.
export function roundTrips(bytes) {
  const e = encode(bytes);
  if (!e.ok) return false;
  const d = decode({ width: e.width, height: e.height, pixels: e.pixels });
  if (!d.ok) return false;
  const src = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (d.bytes.length !== src.length) return false;
  for (let i = 0; i < src.length; i++) if (d.bytes[i] !== src[i]) return false;
  return true;
}

// ── text convenience (thin, separately tested — the CORE promise is about bytes) ──
export function encodeText(text) {
  if (typeof text !== 'string') return { ok: false, why: 'text must be a string' };
  return encode(new TextEncoder().encode(text));
}
export function decodeText(grid) {
  const d = decode(grid);
  if (!d.ok) return d;
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(d.bytes) }; }
  catch (e) { return { ok: false, why: 'decoded bytes are not valid UTF-8: ' + e.message }; }
}
