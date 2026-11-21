import test from 'node:test';
import assert from 'node:assert/strict';
import { HyperLogLog, CountMinSketch, encodeState, decodeState } from '../src/sketches.ts';

test('fixed multilingual hash vectors match an independent Python hashlib calculation', () => {
  // UTF-8 c3 a9 00 f0 9d 84 9e: composed e-acute, NUL, musical G clef.
  // Python hashlib.sha256(domain + struct.pack(">II", seed, row) + key).
  // CMS seed42: first64bits modulo16 gives [14,14,6].
  // HLL seed0xffffffff: first64bits = 0x599b6e6052e1faeb.
  const key = '\u00e9\0\u{1d11e}';
  const cms = new CountMinSketch(16, 3, 42);
  cms.add(key, 0x01020304);
  const bytes = Buffer.from(cms.snapshot().counters, 'base64');
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 16; column += 1) {
    assert.equal(bytes.readUInt32LE((row * 16 + column) * 4), column === [14,14,6][row] ? 0x01020304 : 0);
  }
  const hll = new HyperLogLog(12, 0xffffffff);
  hll.add(key);
  const registers = Buffer.from(hll.snapshot().registers, 'base64');
  assert.equal(registers[1433], 1);
  assert.equal(registers.reduce((sum, value) => sum + value, 0), 1);
});

test('self-merge reaches the uint32 boundary exactly and failed operations preserve portable state', () => {
  const sketch = new CountMinSketch(16, 2, 23);
  sketch.add('counter', 0x7fffffff);
  sketch.merge(sketch);
  assert.equal(sketch.total, 0xfffffffe);
  sketch.add('counter', 1);
  assert.equal(sketch.estimate('counter'), 0xffffffff);
  const encoded = encodeState(sketch.snapshot());
  sketch.add('counter', 0);
  sketch.merge(new CountMinSketch(16, 2, 23));
  assert.equal(encodeState(sketch.snapshot()), encoded);
  assert.throws(() => sketch.merge(sketch), /overflow/);
  assert.throws(() => sketch.add('new-key', 1), /overflow/);
  assert.equal(encodeState(sketch.snapshot()), encoded);
  const decoded = decodeState(encoded);
  assert.equal(decoded.algorithm, 'count-min');
  if (decoded.algorithm === 'count-min') {
    assert.equal(CountMinSketch.restore(decoded).estimate('counter'), 0xffffffff);
  }
});
