import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HyperLogLog, CountMinSketch, encodeState, decodeState } from '../src/sketches.ts';
import { bucketRank, seededHash64, keyBytes, MAX_TOTAL } from '../src/hash.ts';
import { definitions, makeStream, exactCounts } from '../src/streams.ts';

test('manually constructed 64-bit words have exact bucket and leading-zero ranks', () => {
  assert.deepEqual(bucketRank(0n, 4), { bucket: 0, rank: 61 });
  assert.deepEqual(bucketRank(0xa800000000000000n, 4), { bucket: 10, rank: 1 });
  assert.deepEqual(bucketRank(0xa100000000000000n, 4), { bucket: 10, rank: 4 });
  assert.deepEqual(bucketRank(0xa000000000000001n, 4), { bucket: 10, rank: 60 });
  assert.deepEqual(bucketRank(0xfff8000000000000n, 12), { bucket: 4095, rank: 1 });
  assert.throws(() => bucketRank(1n << 64n, 4));
});

test('hash byte layout matches independent SHA construction and row domains differ', () => {
  const context = Buffer.from([0, 0, 0, 7, 0, 0, 0, 2]);
  const independent = createHash('sha256').update(Buffer.concat([Buffer.from('sketch-cms-v1\0'), context, Buffer.from('alpha')])).digest();
  assert.equal(seededHash64(Buffer.from('alpha'), 7, 'cms', 2), independent.readBigUInt64BE(0));
  assert.notEqual(seededHash64(Buffer.from('alpha'), 7, 'cms', 0), seededHash64(Buffer.from('alpha'), 7, 'cms', 1));
  assert.notEqual(seededHash64(Buffer.from('alpha'), 7, 'hll'), seededHash64(Buffer.from('alpha'), 7, 'cms'));
});

test('HLL empty state returns zero via linear counting and one occupied register has known estimate', () => {
  const sketch = new HyperLogLog(4, 0);
  assert.equal(sketch.estimate().estimate, 0);
  assert.equal(sketch.estimate().method, 'linear-counting');
  sketch.add('one');
  assert.equal(sketch.estimate().zeroRegisters, 15);
  assert.equal(sketch.estimate().estimate, 16 * Math.log(16 / 15));
  const before = sketch.snapshot();
  for (let i = 0; i < 100; i += 1) sketch.add('one');
  assert.deepEqual(sketch.snapshot(), before);
});

test('HLL raw estimator and correction branch follow independently calculated register vectors', () => {
  const template = new HyperLogLog(4).snapshot();
  const one = HyperLogLog.restore({ ...template, registers: Buffer.alloc(16, 1).toString('base64') }).estimate();
  assert.equal(one.method, 'raw-hll'); assert.equal(one.estimate, 0.673 * 16 * 16 / 8);
  const rankFive = HyperLogLog.restore({ ...template, registers: Buffer.alloc(16, 5).toString('base64') }).estimate();
  assert.equal(rankFive.estimate, 0.673 * 16 * 32);
});

test('partition merge equals direct ingestion for both sketches over many seeds/configurations', () => {
  const stream = makeStream({ ...definitions[1], events: 600 });
  for (const seed of [0, 1, 7, 19]) for (const [p, width] of [[4, 16], [8, 64], [10, 256]]) {
    const directHll = new HyperLogLog(p, seed); const directCms = new CountMinSketch(width, 4, seed);
    const hllParts = Array.from({ length: 4 }, () => new HyperLogLog(p, seed));
    const cmsParts = Array.from({ length: 4 }, () => new CountMinSketch(width, 4, seed));
    stream.forEach((key, index) => { directHll.add(key); directCms.add(key); hllParts[index % 4].add(key); cmsParts[index % 4].add(key); });
    const mergedHll = new HyperLogLog(p, seed); const mergedCms = new CountMinSketch(width, 4, seed);
    for (const index of [2, 0, 3, 1]) { mergedHll.merge(hllParts[index]); mergedCms.merge(cmsParts[index]); }
    assert.deepEqual(mergedHll.snapshot(), directHll.snapshot());
    assert.deepEqual(mergedCms.snapshot(), directCms.snapshot());
  }
});

test('HLL merge is idempotent; Count-Min merge adds overlapping observations', () => {
  const hll = new HyperLogLog(); hll.add('a'); const before = hll.snapshot(); hll.merge(hll);
  assert.deepEqual(hll.snapshot(), before);
  const cms = new CountMinSketch(); cms.add('a', 7); cms.merge(cms);
  assert.equal(cms.estimate('a'), 14); assert.equal(cms.total, 14);
});

test('configuration mismatch is rejected before mutating either sketch', () => {
  const hll = new HyperLogLog(8, 3); hll.add('a'); const beforeHll = hll.snapshot();
  for (const other of [new HyperLogLog(7, 3), new HyperLogLog(8, 4)]) assert.throws(() => hll.merge(other));
  assert.deepEqual(hll.snapshot(), beforeHll);
  const cms = new CountMinSketch(64, 4, 3); cms.add('a'); const beforeCms = cms.snapshot();
  for (const other of [new CountMinSketch(128, 4, 3), new CountMinSketch(64, 3, 3), new CountMinSketch(64, 4, 4)]) assert.throws(() => cms.merge(other));
  assert.deepEqual(cms.snapshot(), beforeCms);
});

test('Count-Min never underestimates observed nonnegative counts and supports zero/weighted updates', () => {
  const stream = makeStream({ ...definitions[0], events: 1000 });
  const exact = exactCounts(stream); const sketch = new CountMinSketch(32, 4, 9);
  for (const key of stream) sketch.add(key);
  for (const [key, count] of exact) assert.ok(sketch.estimate(key) >= count);
  const empty = new CountMinSketch(); empty.add('a', 0); assert.equal(empty.total, 0);
  empty.add('a', 20); assert.equal(empty.estimate('a'), 20);
  assert.throws(() => empty.add('a', -1)); assert.throws(() => empty.add('a', 0.5));
});

test('overflow checks preserve state atomically for update and merge', () => {
  const sketch = new CountMinSketch(16, 2); sketch.add('a', MAX_TOTAL);
  const before = sketch.snapshot(); assert.throws(() => sketch.add('b')); assert.deepEqual(sketch.snapshot(), before);
  const other = new CountMinSketch(16, 2); other.add('a');
  assert.throws(() => sketch.merge(other)); assert.deepEqual(sketch.snapshot(), before);
});

test('portable little-endian counters independently match row positions for a weighted update', () => {
  const sketch = new CountMinSketch(16, 2, 5); sketch.add('x', 0x01020304);
  const bytes = Buffer.from(sketch.snapshot().counters, 'base64');
  for (let row = 0; row < 2; row += 1) {
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(5); prefix.writeUInt32BE(row, 4);
    const digest = createHash('sha256').update('sketch-cms-v1\0').update(prefix).update('x').digest();
    const column = Number(digest.readBigUInt64BE(0) % 16n);
    assert.deepEqual([...bytes.subarray((row * 16 + column) * 4, (row * 16 + column) * 4 + 4)], [4, 3, 2, 1]);
    for (let c = 0; c < 16; c += 1) assert.equal(bytes.readUInt32LE((row * 16 + c) * 4), c === column ? 0x01020304 : 0);
  }
});

test('serialization round-trips and rejects impossible state and noncanonical JSON/base64', () => {
  const hll = new HyperLogLog(); hll.add('x'); const cms = new CountMinSketch(); cms.add('x', 7);
  assert.deepEqual(HyperLogLog.restore(decodeState(encodeState(hll.snapshot())) as ReturnType<HyperLogLog['snapshot']>).snapshot(), hll.snapshot());
  assert.deepEqual(CountMinSketch.restore(decodeState(encodeState(cms.snapshot())) as ReturnType<CountMinSketch['snapshot']>).snapshot(), cms.snapshot());
  const invalidRank = { ...hll.snapshot(), registers: Buffer.alloc(256, 255).toString('base64') };
  assert.throws(() => HyperLogLog.restore(invalidRank));
  assert.throws(() => CountMinSketch.restore({ ...cms.snapshot(), total: 6 }));
  const encoded = encodeState(hll.snapshot());
  for (const invalid of [encoded.replace('"version":1', '"version":1,"version":1'), ' ' + encoded,
    encoded.replace('"seed":0', '"seed":-0'), encoded + '\r\n', encoded + '\n\n', '\ufeff' + encoded,
    encoded.replace('sha256-64-hll-v1', 'unknown-hash'), 'x'.repeat(200001)]) assert.throws(() => decodeState(invalid));
  assert.throws(() => decodeState(Buffer.from([0xff])));
  assert.deepEqual(decodeState(encoded + '\n'), hll.snapshot());
});

test('key identity is exact valid UTF-8 and snapshot/config access cannot mutate internals', () => {
  assert.throws(() => keyBytes('\ud800')); assert.throws(() => keyBytes('a'.repeat(257)));
  assert.notDeepEqual(keyBytes('é'), keyBytes('e\u0301'));
  const sketch = new HyperLogLog(); sketch.add('');
  const snapshot = sketch.snapshot(); snapshot.registers = '';
  assert.notEqual(sketch.snapshot().registers, '');
  assert.equal(Reflect.set(sketch, 'seed', 2), false);
  assert.equal(sketch.seed, 0);
});
