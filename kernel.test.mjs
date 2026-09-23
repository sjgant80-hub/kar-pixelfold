import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, roundTrips, encodeText, decodeText, crc16 } from './kernel.mjs';

// ── crc16 against the algorithm's own published standard test vector — not just self-consistency.
// encode() and decode() both call the SAME crc16(), so every round-trip/corruption test above can
// pass even if crc16 computes the wrong algorithm consistently. CRC-16/CCITT-FALSE's known check
// value for the ASCII bytes "123456789" is 0x29B1 — this is the standard's own answer, not one we
// picked to make a test pass.
test('crc16 matches the CRC-16/CCITT-FALSE standard check value for "123456789"', () => {
  const bytes = Uint8Array.from('123456789'.split('').map((c) => c.charCodeAt(0)));
  assert.equal(crc16(bytes), 0x29b1);
});
test('crc16 of an empty input is the initial value unchanged (0xFFFF)', () => {
  assert.equal(crc16(new Uint8Array(0)), 0xffff);
});

// ── encode: input validation ──
test('encode rejects a non-array, non-Uint8Array', () => {
  const r = encode('not bytes');
  assert.equal(r.ok, false);
  assert.match(r.why, /Uint8Array/);
});
test('encode rejects an array with an out-of-range value', () => {
  assert.equal(encode([1, 2, 256]).ok, false);
  assert.equal(encode([1, -1, 3]).ok, false);
});
test('encode rejects an array with a non-integer value', () => {
  assert.equal(encode([1, 2.5, 3]).ok, false);
});
test('encode rejects null/undefined/object', () => {
  assert.equal(encode(null).ok, false);
  assert.equal(encode(undefined).ok, false);
  assert.equal(encode({}).ok, false);
});
test('encode accepts a plain array of byte values', () => {
  const r = encode([1, 2, 3]);
  assert.equal(r.ok, true);
});
test('encode accepts 255 as a valid boundary byte value in a plain array', () => {
  assert.equal(encode([0, 0, 0, 0, 255]).ok, true);
});
test('encode rejects 256 specifically at the LAST element of a plain array (loop must reach it)', () => {
  assert.equal(encode([0, 0, 0, 0, 256]).ok, false);
});
test('encode rejects -1 specifically at the LAST element of a plain array (loop must reach it)', () => {
  assert.equal(encode([0, 0, 0, 0, -1]).ok, false);
});
test('encode does not reject a plain array one element past a false accusation — every element is checked, not just the first', () => {
  // if the loop under-ran by one, this bad first element would slip through unseen
  assert.equal(encode([256, 0, 0]).ok, false);
});
test('encode accepts a Uint8Array', () => {
  const r = encode(new Uint8Array([1, 2, 3]));
  assert.equal(r.ok, true);
});

// ── the core promise: decode(encode(x)) === x, byte-exact ──
test('round-trip: empty bytes', () => {
  assert.equal(roundTrips(new Uint8Array(0)), true);
});
test('round-trip: single byte, value 0', () => {
  assert.equal(roundTrips(new Uint8Array([0])), true);
});
test('round-trip: single byte, value 255', () => {
  assert.equal(roundTrips(new Uint8Array([255])), true);
});
test('round-trip: bytes containing 0x00 in the middle (not a terminator)', () => {
  assert.equal(roundTrips(new Uint8Array([65, 0, 66, 0, 0, 67])), true);
});
test('round-trip: all 256 byte values, once each', () => {
  const arr = new Uint8Array(256);
  for (let i = 0; i < 256; i++) arr[i] = i;
  assert.equal(roundTrips(arr), true);
});
test('round-trip: header+payload length already exactly divisible by 3 (no padding needed)', () => {
  assert.equal(roundTrips(new Uint8Array(9).fill(7)), true); // 6 header + 9 payload = 15, 15 % 3 === 0
});
test('round-trip: header+payload length 16 (remainder 1, needs 2 padding bytes)', () => {
  assert.equal(roundTrips(new Uint8Array(10).fill(7)), true); // 6 header + 10 payload = 16, 16 % 3 === 1
});
test('round-trip: header+payload length 17 (remainder 2, needs 1 padding byte)', () => {
  assert.equal(roundTrips(new Uint8Array(11).fill(7)), true); // 6 header + 11 payload = 17, 17 % 3 === 2
});
test('encode adds NO padding when header+payload is already a multiple of 3 (exact grid shape)', () => {
  // 6 header + 6 payload = 12, 12 % 3 === 0 -> padLen must be 0 -> pixelCount 4 -> a 2x2 grid.
  // A padLen bug that adds 3 needless bytes here would instead produce pixelCount 5 -> a 3x2
  // grid (6 cells) — a different, checkable shape. Padding bytes are never read on decode, so
  // round-trip correctness alone can't tell these apart; only a direct shape check can.
  const e = encode(new Uint8Array(6).fill(1));
  assert.equal(e.width, 2);
  assert.equal(e.height, 2);
  assert.equal(e.pixels.length, 4);
});
test('round-trip: a 1000-byte pseudo-random buffer', () => {
  const arr = new Uint8Array(1000);
  let seed = 12345;
  for (let i = 0; i < arr.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; arr[i] = seed % 256; }
  assert.equal(roundTrips(arr), true);
});
test('round-trip preserves exact bytes, checked value-by-value, not just length', () => {
  const src = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const e = encode(src);
  const d = decode({ width: e.width, height: e.height, pixels: e.pixels });
  assert.deepEqual(Array.from(d.bytes), Array.from(src));
});

// ── decode: structural validation ──
test('decode rejects non-object grid', () => {
  assert.equal(decode(null).ok, false);
  assert.equal(decode('x').ok, false);
  assert.equal(decode([]).ok, false);
});
test('decode rejects width <= 0, isolated from height (exact why)', () => {
  assert.match(decode({ width: 0, height: 3, pixels: [] }).why, /width must be a positive integer/);
  assert.match(decode({ width: -1, height: 3, pixels: [] }).why, /width must be a positive integer/);
});
test('decode rejects a non-integer width, isolated from the <=0 clause', () => {
  assert.match(decode({ width: 1.5, height: 3, pixels: [] }).why, /width must be a positive integer/);
});
test('decode rejects height <= 0, isolated from width (exact why)', () => {
  assert.match(decode({ width: 3, height: 0, pixels: [] }).why, /height must be a positive integer/);
  assert.match(decode({ width: 3, height: -1, pixels: [] }).why, /height must be a positive integer/);
});
test('decode rejects a non-integer height, isolated from the <=0 clause', () => {
  assert.match(decode({ width: 3, height: 2.5, pixels: [] }).why, /height must be a positive integer/);
});
test('decode rejects pixels that is not an array', () => {
  assert.match(decode({ width: 1, height: 1, pixels: 'x' }).why, /pixels must be an array/);
});
test('decode rejects grid that is not an object, or an array, or null (each clause)', () => {
  assert.match(decode(null).why, /grid must be an object/);
  assert.match(decode([1, 2]).why, /grid must be an object/);
  assert.match(decode('x').why, /grid must be an object/);
});
test('decode rejects a pixel-count mismatch', () => {
  const e = encode([1, 2, 3]);
  const r = decode({ width: e.width, height: e.height, pixels: e.pixels.slice(0, -1) });
  assert.equal(r.ok, false);
  assert.match(r.why, /pixels length/);
});

// A hand-built, controlled 3x2 grid (not derived from encode()) so boundary tests can't
// coincidentally alias onto a DIFFERENT real cell and get caught by an unrelated check
// (found live: corrupting x to exactly `width` on a 2x2 grid happened to land on another
// pixel's real index and got caught as "duplicate," not as the intended out-of-range check
// — silent, wrong reason, same bug either way but the wrong test can't tell them apart).
function blankGrid(width, height) {
  const pixels = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.push({ x, y, r: 0, g: 0, b: 0 });
  return { width, height, pixels };
}

test('decode rejects a null pixel, isolated from the typeof clause', () => {
  const g = blankGrid(3, 2);
  g.pixels[0] = null;
  assert.match(decode(g).why, /must be an object/);
});
test('decode rejects a non-null non-object pixel, isolated from the null clause', () => {
  const g = blankGrid(3, 2);
  g.pixels[0] = 'not an object';
  assert.match(decode(g).why, /must be an object/);
});
test('decode rejects x < 0, isolated from the x >= width clause (exact why)', () => {
  const g = blankGrid(3, 2);
  g.pixels[0] = { ...g.pixels[0], x: -1 };
  assert.match(decode(g).why, /out-of-range x/);
});
test('decode rejects x === width exactly (the boundary), isolated from every other clause', () => {
  const g = blankGrid(3, 2);
  g.pixels[0] = { ...g.pixels[0], x: 3 }; // width is 3; valid x is 0,1,2
  assert.match(decode(g).why, /out-of-range x/);
});
test('decode rejects a non-integer x, isolated from the range clauses', () => {
  const g = blankGrid(3, 2);
  g.pixels[0] = { ...g.pixels[0], x: 1.5 };
  assert.match(decode(g).why, /out-of-range x/);
});
test('decode rejects y < 0, isolated from the y >= height clause (exact why)', () => {
  const g = blankGrid(3, 2);
  g.pixels[0] = { ...g.pixels[0], y: -1 };
  assert.match(decode(g).why, /out-of-range y/);
});
test('decode rejects y === height exactly (the boundary), isolated from every other clause', () => {
  const g = blankGrid(3, 2);
  g.pixels[0] = { ...g.pixels[0], y: 2 }; // height is 2; valid y is 0,1
  assert.match(decode(g).why, /out-of-range y/);
});
test('decode rejects each channel out of range independently (r, then g, then b)', () => {
  const gr = blankGrid(3, 2); gr.pixels[0] = { ...gr.pixels[0], r: 256 };
  const gg = blankGrid(3, 2); gg.pixels[0] = { ...gg.pixels[0], g: -1 };
  const gb = blankGrid(3, 2); gb.pixels[0] = { ...gb.pixels[0], b: 999 };
  assert.match(decode(gr).why, /channel outside 0-255/);
  assert.match(decode(gg).why, /channel outside 0-255/);
  assert.match(decode(gb).why, /channel outside 0-255/);
});
test('decode rejects a duplicate pixel coordinate, isolated from the out-of-range checks', () => {
  const g = blankGrid(3, 2);
  g.pixels[1] = { ...g.pixels[0] }; // a real, in-range duplicate, not a boundary alias
  assert.match(decode(g).why, /duplicate pixel/);
});

// ── the CRC: corruption must be CAUGHT, not silently returned as different-but-valid bytes ──
test('a single flipped channel INSIDE the payload is caught by the CRC, not silently accepted', () => {
  const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const e = encode(src);
  // pixel index 2 covers raw bytes 6,7,8 — squarely inside the 6-byte-header + 8-byte-payload
  // region (not the header itself, not any trailing zero-padding pixel beyond the frame, which
  // decode correctly never reads at all — corrupting THAT would prove nothing about the CRC).
  const corrupted = e.pixels.map((p, i) => (i === 2 ? { ...p, r: (p.r + 1) % 256 } : p));
  const d = decode({ width: e.width, height: e.height, pixels: corrupted });
  assert.equal(d.ok, false);
  assert.match(d.why, /corrupted|CRC/i);
});
test('a corrupted length header that overruns the grid is refused, not silently truncated wrong', () => {
  const e = encode([1, 2, 3]);
  const bad = e.pixels.map((p, i) => (i === 0 ? { ...p, r: 255, g: 255, b: 255 } : p)); // blow up the length field
  const d = decode({ width: e.width, height: e.height, pixels: bad });
  assert.equal(d.ok, false);
});
test('grid too small to even hold a header is refused', () => {
  assert.equal(decode({ width: 1, height: 1, pixels: [{ x: 0, y: 0, r: 0, g: 0, b: 0 }] }).ok, false);
});

// ── roundTrips() itself is total ──
test('roundTrips returns false (never throws) on garbage input', () => {
  assert.equal(roundTrips('nope'), false);
  assert.equal(roundTrips(null), false);
  assert.equal(roundTrips({}), false);
});
test('roundTrips returns true for a real value', () => {
  assert.equal(roundTrips([1, 2, 3, 4, 5]), true);
});

// ── text convenience ──
test('encodeText/decodeText round-trip plain ASCII', () => {
  const e = encodeText('hello, estate');
  const d = decodeText({ width: e.width, height: e.height, pixels: e.pixels });
  assert.equal(d.ok, true);
  assert.equal(d.text, 'hello, estate');
});
test('encodeText/decodeText round-trip multi-byte UTF-8', () => {
  const e = encodeText('κ φ — 折り紙 🦅');
  const d = decodeText({ width: e.width, height: e.height, pixels: e.pixels });
  assert.equal(d.ok, true);
  assert.equal(d.text, 'κ φ — 折り紙 🦅');
});
test('encodeText rejects a non-string', () => {
  assert.equal(encodeText(42).ok, false);
});
test('decodeText refuses bytes that are not valid UTF-8', () => {
  // an isolated continuation byte (0x80) with nothing before it is invalid UTF-8
  const e = encode(new Uint8Array([0x80, 0x80]));
  const d = decodeText({ width: e.width, height: e.height, pixels: e.pixels });
  assert.equal(d.ok, false);
});

// ── THE FUZZ: the core promise, hammered ──
test('fuzz: 500 random-length random-content buffers all round-trip byte-exact', () => {
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  let failures = 0;
  for (let trial = 0; trial < 500; trial++) {
    const len = rnd() % 600; // 0..599 bytes, including 0
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = rnd() % 256;
    if (!roundTrips(arr)) failures++;
  }
  assert.equal(failures, 0, failures + ' of 500 fuzzed buffers failed to round-trip byte-exact');
});
test('fuzz: garbage-shaped encode() inputs never throw', () => {
  const garbage = [undefined, null, {}, [], () => {}, Symbol('x'), NaN, Infinity, -Infinity, '', '0', true, false, 0, new Map(), new Date(), [1, 2, 3.5], [1, -1], [1, 256]];
  for (const g of garbage) {
    assert.doesNotThrow(() => encode(g));
    assert.doesNotThrow(() => decode(g));
    assert.doesNotThrow(() => roundTrips(g));
  }
});
