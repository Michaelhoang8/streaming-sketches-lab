import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HyperLogLog, CountMinSketch, decodeState, encodeState } from '../src/sketches.ts';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const csv = (path: string) => {
  const lines = read(path).trim().split('\n'); const columns = lines.shift()!.split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((value, index) => [columns[index], value])));
};
test('committed stream hashes and exact reference files agree with independent counting', () => {
  const manifest = JSON.parse(read('data/manifest.json')) as { definitions: Array<{ name: string; sha256: string; events: number; exactDistinct: number }> };
  for (const definition of manifest.definitions) {
    const text = read(`data/${definition.name}.txt`);
    assert.equal(createHash('sha256').update(text).digest('hex'), definition.sha256);
    const events = text.trimEnd().split('\n'); assert.equal(events.length, definition.events);
    const counted: Record<string, number> = {};
    for (const key of events) counted[key] = (counted[key] ?? 0) + 1;
    assert.equal(Object.keys(counted).length, definition.exactDistinct);
    assert.deepEqual(counted, JSON.parse(read(`data/${definition.name}-exact.json`)));
  }
});
test('raw estimate errors and query-panel outcomes reconcile arithmetically', () => {
  for (const row of csv('results/hll-runs.csv')) {
    assert.equal(Number(row.payloadBytes), 2 ** Number(row.p));
    assert.ok(Math.abs(Number(row.relativeError) - (Number(row.estimate) - Number(row.exactDistinct)) / Number(row.exactDistinct)) < 1e-12);
  }
  for (const row of csv('results/count-min-runs.csv')) {
    assert.equal(Number(row.payloadBytes), Number(row.width) * Number(row.depth) * 4);
    assert.equal(Number(row.underestimates), 0);
    assert.ok(Math.abs(Number(row.meanNormalizedOvercount) - Number(row.meanOvercount) / Number(row.total)) < 1e-12);
  }
  const exact = Object.fromEntries(['uniform', 'power-skewed', 'repeated'].map(name => [name, JSON.parse(read(`data/${name}-exact.json`)) as Record<string, number>]));
  for (const row of csv('results/query-panel.csv')) {
    assert.equal(Number(row.exact), exact[row.stream][row.key] ?? 0);
    assert.equal(Number(row.overcount), Number(row.estimate) - Number(row.exact));
    assert.ok(Number(row.overcount) >= 0);
  }
});

test('preserved source hashes and stored snapshots reproduce from the committed inputs', () => {
  const environment = JSON.parse(read('results/environment.json')) as { sourceSha256: Record<string, string> };
  for (const [path, expected] of Object.entries(environment.sourceSha256)) {
    assert.equal(createHash('sha256').update(read(path)).digest('hex'), expected, path);
  }
  const hllRows = csv('results/hll-runs.csv'); const cmsRows = csv('results/count-min-runs.csv');
  const merges = JSON.parse(read('results/merge-checks.json')) as Array<{ stream: string; hllStateSha256: string; cmsStateSha256: string }>;
  for (const stream of ['uniform', 'power-skewed', 'repeated']) {
    const events = read(`data/${stream}.txt`).trimEnd().split('\n');
    const hllState = decodeState(read(`results/snapshots/${stream}-hll.json`));
    const cmsState = decodeState(read(`results/snapshots/${stream}-count-min.json`));
    assert.equal(hllState.algorithm, 'hll'); assert.equal(cmsState.algorithm, 'count-min');
    if (hllState.algorithm !== 'hll' || cmsState.algorithm !== 'count-min') throw new Error('Wrong evidence algorithm');
    const hll = new HyperLogLog(hllState.p, hllState.seed);
    const cms = new CountMinSketch(cmsState.width, cmsState.depth, cmsState.seed);
    for (const key of events) { hll.add(key); cms.add(key); }
    assert.deepEqual(hll.snapshot(), hllState);
    assert.deepEqual(cms.snapshot(), cmsState);
    const merge = merges.find(row => row.stream === stream)!;
    assert.equal(createHash('sha256').update(encodeState(hllState)).digest('hex'), merge.hllStateSha256);
    assert.equal(createHash('sha256').update(encodeState(cmsState)).digest('hex'), merge.cmsStateSha256);
    const hllRow = hllRows.find(row => row.stream === stream && Number(row.seed) === hll.seed && Number(row.p) === hll.p)!;
    assert.equal(Number(hllRow.estimate), hll.estimate().estimate);
    assert.equal(Number(hllRow.zeroRegisters), hll.estimate().zeroRegisters);
    const cmsRow = cmsRows.find(row => row.stream === stream && Number(row.seed) === cms.seed && Number(row.width) === cms.width)!;
    const exact = JSON.parse(read(`data/${stream}-exact.json`)) as Record<string, number>;
    const errors = Object.entries(exact).map(([key, count]) => cms.estimate(key) - count);
    assert.equal(Number(cmsRow.meanOvercount), errors.reduce((sum, value) => sum + value, 0) / errors.length);
    assert.equal(Number(cmsRow.maxOvercount), Math.max(...errors));
  }
});

test('published summary counts and seed aggregates reconcile to preserved raw runs', () => {
  const summary = JSON.parse(read('results/summary.json')) as { hllRuns: number; countMinRuns: number; queryPanelRows: number;
    countMinPresentChecks: number; countMinAbsentChecks: number; hll: Array<{ stream: string; p: number; rmseRelativeError: number }>;
    countMin: Array<{ stream: string; width: number; medianMeanNormalizedOvercount: number }> };
  const hll = csv('results/hll-runs.csv'); const cms = csv('results/count-min-runs.csv');
  assert.equal(summary.hllRuns, hll.length); assert.equal(summary.countMinRuns, cms.length);
  assert.equal(summary.queryPanelRows, csv('results/query-panel.csv').length);
  assert.equal(summary.countMinPresentChecks, cms.reduce((sum, row) => sum + Number(row.presentQueries), 0));
  assert.equal(summary.countMinAbsentChecks, cms.reduce((sum, row) => sum + Number(row.absentQueries), 0));
  for (const aggregate of summary.hll) {
    const errors = hll.filter(row => row.stream === aggregate.stream && Number(row.p) === aggregate.p).map(row => Number(row.relativeError));
    const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length);
    assert.ok(Math.abs(rmse - aggregate.rmseRelativeError) < 1e-12);
  }
  for (const aggregate of summary.countMin) {
    const values = cms.filter(row => row.stream === aggregate.stream && Number(row.width) === aggregate.width)
      .map(row => Number(row.meanNormalizedOvercount)).sort((a, b) => a - b);
    const median = (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2;
    assert.ok(Math.abs(median - aggregate.medianMeanNormalizedOvercount) < 1e-12);
  }
});
