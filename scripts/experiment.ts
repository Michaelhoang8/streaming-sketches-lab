import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { HyperLogLog, CountMinSketch, encodeState, decodeState } from '../src/sketches.ts';
import { definitions, makeStream, exactCounts, queryPanel } from '../src/streams.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: npm run experiment -- [--output results-local] [--quick]\n--quick uses two hash seeds; normal execution uses twenty.'); process.exit(0); }
let destination = 'results'; let quick = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--quick') quick = true;
  else if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) destination = args[++i];
  else { console.error('Invalid argument; use --help'); process.exit(2); }
}
const output = resolve(root, destination);
for (const dir of [output, join(output, 'snapshots'), join(root, 'data')]) mkdirSync(dir, { recursive: true });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const json = (file: string, value: unknown) => writeFileSync(join(output, file), JSON.stringify(value, null, 2) + '\n');
const csv = (file: string, rows: Array<Record<string, string | number>>) => {
  const columns = Object.keys(rows[0]);
  writeFileSync(join(output, file), columns.join(',') + '\n' + rows.map(row => columns.map(key => String(row[key])).join(',')).join('\n') + '\n');
};
const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * q; const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * (index - lower);
};
type HllRow = { stream: string; seed: number; p: number; registers: number; payloadBytes: number; snapshotBytes: number;
  exactDistinct: number; estimate: number; rawEstimate: number; zeroRegisters: number; method: string; relativeError: number; updateMs: number };
type CmsRow = { stream: string; seed: number; width: number; depth: number; total: number; payloadBytes: number; snapshotBytes: number;
  presentQueries: number; absentQueries: number; meanOvercount: number; p95Overcount: number; maxOvercount: number;
  meanNormalizedOvercount: number; absentPositiveRate: number; underestimates: number; updateMs: number; queryMs: number };
const hllRows: HllRow[] = []; const cmsRows: CmsRow[] = [];
const panelRows: Array<Record<string, string | number>> = [];
const manifests: Array<Record<string, unknown>> = [];
const mergeRows: Array<Record<string, unknown>> = [];
const seeds = Array.from({ length: quick ? 2 : 20 }, (_, seed) => seed);
for (const definition of definitions) {
  const stream = makeStream(definition); const exact = exactCounts(stream); const panel = queryPanel(exact);
  const absent = panel.filter(key => !exact.has(key));
  const text = stream.join('\n') + '\n';
  writeFileSync(join(root, 'data', `${definition.name}.txt`), text);
  const ordered = Object.fromEntries([...exact].sort((a, b) => a[0] < b[0] ? -1 : 1));
  writeFileSync(join(root, 'data', `${definition.name}-exact.json`), JSON.stringify(ordered, null, 2) + '\n');
  const exactKeyBytes = [...exact.keys()].reduce((sum, key) => sum + Buffer.byteLength(key), 0);
  manifests.push({ ...definition, sha256: sha(text), fixtureBytes: Buffer.byteLength(text), exactDistinct: exact.size,
    exactCountSum: [...exact.values()].reduce((sum, value) => sum + value, 0), exactKeyBytes,
    exactLogicalCountBytes: exact.size * 8, exactLogicalPayloadBytes: exactKeyBytes + exact.size * 8,
    exactCompactJsonBytes: Buffer.byteLength(JSON.stringify(ordered)), queryPanel: panel });
  for (const seed of seeds) {
    const configs = [[6, 64], [8, 256], [10, 1024]];
    const rotated = configs.slice(seed % 3).concat(configs.slice(0, seed % 3));
    for (const [p, width] of rotated) {
      const hll = new HyperLogLog(p, seed);
      const hllStart = performance.now(); for (const key of stream) hll.add(key); const hllUpdateMs = performance.now() - hllStart;
      const estimate = hll.estimate(); const hllState = hll.snapshot();
      assert.deepEqual(decodeState(encodeState(hllState)), hllState);
      hllRows.push({ stream: definition.name, seed, p, registers: 2 ** p, payloadBytes: hll.payloadBytes,
        snapshotBytes: Buffer.byteLength(encodeState(hllState)), exactDistinct: exact.size, estimate: estimate.estimate,
        rawEstimate: estimate.raw, zeroRegisters: estimate.zeroRegisters, method: estimate.method,
        relativeError: (estimate.estimate - exact.size) / exact.size, updateMs: hllUpdateMs });
      const cms = new CountMinSketch(width, 4, seed);
      const cmsStart = performance.now(); for (const key of stream) cms.add(key); const cmsUpdateMs = performance.now() - cmsStart;
      assert.equal(cms.total, stream.length);
      const queryStart = performance.now(); const estimates = new Map<string, number>();
      for (const key of [...exact.keys(), ...absent]) estimates.set(key, cms.estimate(key));
      const queryMs = performance.now() - queryStart;
      const errors = [...exact].map(([key, count]) => estimates.get(key)! - count).sort((a, b) => a - b);
      assert.ok(errors.every(error => error >= 0), 'Count-Min underestimated a nonnegative stream count');
      const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
      const cmsState = cms.snapshot(); assert.deepEqual(decodeState(encodeState(cmsState)), cmsState);
      cmsRows.push({ stream: definition.name, seed, width, depth: 4, total: cms.total, payloadBytes: cms.payloadBytes,
        snapshotBytes: Buffer.byteLength(encodeState(cmsState)), presentQueries: exact.size, absentQueries: absent.length,
        meanOvercount: mean, p95Overcount: quantile(errors, .95), maxOvercount: errors.at(-1)!, meanNormalizedOvercount: mean / stream.length,
        absentPositiveRate: absent.filter(key => estimates.get(key)! > 0).length / absent.length, underestimates: errors.filter(error => error < 0).length,
        updateMs: cmsUpdateMs, queryMs });
      for (const key of panel) panelRows.push({ stream: definition.name, seed, width, depth: 4, key, exact: exact.get(key) ?? 0,
        estimate: estimates.get(key)!, overcount: estimates.get(key)! - (exact.get(key) ?? 0),
        overcountFractionOfStream: (estimates.get(key)! - (exact.get(key) ?? 0)) / stream.length });
      if (seed === 0 && p === 8) {
        writeFileSync(join(output, 'snapshots', `${definition.name}-hll.json`), encodeState(hllState) + '\n');
        writeFileSync(join(output, 'snapshots', `${definition.name}-count-min.json`), encodeState(cmsState) + '\n');
        const hllParts = Array.from({ length: 4 }, () => new HyperLogLog(p, seed));
        const cmsParts = Array.from({ length: 4 }, () => new CountMinSketch(width, 4, seed));
        stream.forEach((key, index) => { hllParts[index % 4].add(key); cmsParts[index % 4].add(key); });
        const mergedHll = new HyperLogLog(p, seed); const mergedCms = new CountMinSketch(width, 4, seed);
        for (const partition of [2, 0, 3, 1]) { mergedHll.merge(hllParts[partition]); mergedCms.merge(cmsParts[partition]); }
        assert.deepEqual(mergedHll.snapshot(), hllState); assert.deepEqual(mergedCms.snapshot(), cmsState);
        mergeRows.push({ stream: definition.name, seed, hllP: p, cmsWidth: width, cmsDepth: 4, partitions: 4,
          partitionRule: 'event index modulo 4', mergeOrder: [2, 0, 3, 1], hllIdentical: true, cmsIdentical: true,
          hllStateSha256: sha(encodeState(hllState)), cmsStateSha256: sha(encodeState(cmsState)) });
      }
    }
  }
  console.log(`${definition.name}: ${stream.length} events, ${exact.size} exact keys, ${seeds.length} hash seeds complete`);
}
csv('hll-runs.csv', hllRows); csv('count-min-runs.csv', cmsRows); csv('query-panel.csv', panelRows);
writeFileSync(join(root, 'data/manifest.json'), JSON.stringify({ definitions: manifests, exactMemoryNote: 'Logical payload = UTF-8 distinct keys + 8 bytes per exact count. Excludes JS Map/object overhead; not a heap measurement.' }, null, 2) + '\n');
json('merge-checks.json', mergeRows);
const hllAggregates = definitions.flatMap(definition => [6, 8, 10].map(p => {
  const rows = hllRows.filter(row => row.stream === definition.name && row.p === p);
  const errors = rows.map(row => row.relativeError).sort((a, b) => a - b);
  return { stream: definition.name, p, registers: 2 ** p, runs: rows.length, minRelativeError: errors[0], maxRelativeError: errors.at(-1)!,
    medianRelativeError: quantile(errors, .5), rmseRelativeError: Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length),
    p95AbsoluteRelativeError: quantile(errors.map(Math.abs).sort((a, b) => a - b), .95),
    linearCountingRuns: rows.filter(row => row.method === 'linear-counting').length,
    medianUpdateMs: quantile(rows.map(row => row.updateMs).sort((a, b) => a - b), .5) };
}));
const cmsAggregates = definitions.flatMap(definition => [64, 256, 1024].map(width => {
  const rows = cmsRows.filter(row => row.stream === definition.name && row.width === width);
  const errors = rows.map(row => row.meanNormalizedOvercount).sort((a, b) => a - b);
  return { stream: definition.name, width, depth: 4, payloadBytes: width * 4 * 4, runs: rows.length,
    minMeanNormalizedOvercount: errors[0], maxMeanNormalizedOvercount: errors.at(-1)!, medianMeanNormalizedOvercount: quantile(errors, .5),
    medianP95Overcount: quantile(rows.map(row => row.p95Overcount).sort((a, b) => a - b), .5),
    medianAbsentPositiveRate: quantile(rows.map(row => row.absentPositiveRate).sort((a, b) => a - b), .5),
    medianUpdateMs: quantile(rows.map(row => row.updateMs).sort((a, b) => a - b), .5) };
}));
json('summary.json', { seedCount: seeds.length, seeds, hllRuns: hllRows.length, countMinRuns: cmsRows.length,
  totalStreamEvents: definitions.reduce((sum, row) => sum + row.events, 0),
  countMinPresentChecks: cmsRows.reduce((sum, row) => sum + row.presentQueries, 0),
  countMinAbsentChecks: cmsRows.reduce((sum, row) => sum + row.absentQueries, 0), queryPanelRows: panelRows.length,
  underestimates: cmsRows.reduce((sum, row) => sum + row.underestimates, 0), mergeComparisons: mergeRows.length * 2,
  hll: hllAggregates, countMin: cmsAggregates,
  scope: 'Empirical errors over deterministic hash seeds on fixed synthetic streams; no confidence intervals or universal-hash probability guarantee.' });
const sources = ['src/hash.ts', 'src/sketches.ts', 'src/streams.ts', 'scripts/experiment.ts'];
json('environment.json', { measuredAt: new Date().toISOString(), node: process.version, platform: platform(), architecture: arch(), clock: 'performance.now',
  sourceHashEncoding: 'UTF-8; CRLF normalized to LF', sourceSha256: Object.fromEntries(sources.map(file => [file, sha(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n'))])),
  provenance: 'AI-assisted synthetic streaming algorithm laboratory. Estimates, counters, timings, and merge results are actual executions.' });
